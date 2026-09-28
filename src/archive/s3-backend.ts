/**
 * S3-compatible durable artifact backend, dependency-free.
 *
 * Speaks the S3 REST protocol with AWS Signature Version 4 and path-style
 * addressing, which every S3-compatible private store accepts — Supabase
 * Storage's S3 endpoint, AWS S3, Cloudflare R2, and the moto server the tests
 * run against. No vendor SDK: the Fabric already reads ZIP, XML and File
 * Geodatabase itself so that replay never depends on which library version a
 * machine happens to have, and the same argument applies to the bytes' home.
 *
 * ## Integrity on the wire
 *
 * Every upload is multipart, in fixed-size parts read from a local staged file.
 * Each part's `x-amz-content-sha256` is its real SHA-256, so the store rejects
 * a part corrupted in flight rather than storing it. The whole object's sha256
 * travels as `x-amz-meta-sha256` — a hint for HEAD, never a substitute for
 * re-reading the bytes, which `hashObject` does.
 *
 * ## A partial object is never an object
 *
 * Multipart parts are invisible until CompleteMultipartUpload succeeds. Any
 * failure before that aborts the upload, so an interrupted transfer leaves no
 * key at all — it can never be mistaken for a retained artifact.
 *
 * ## Credentials
 *
 * Read from DF_ARTIFACT_* environment variables by `backendFromEnv`, held in
 * memory, used to sign, and never written anywhere: not to manifests, not to
 * logs, not to error details. No presigned URL is ever persisted.
 */
import { createHmac, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fail } from '../core/errors.ts';
import { canonicalJson } from '../core/hash.ts';
import { withRetry, type RetryPolicy } from '../runtime/retry.ts';
import type { ArtifactBackend, ObjectHead } from './artifact-backend.ts';

export type S3Config = {
  /** e.g. https://<ref>.storage.supabase.co/storage/v1/s3 — no trailing slash. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Upload part size. 16 MiB bounds memory to one part; S3's floor is 5 MiB. */
  readonly partBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

const EMPTY_SHA = createHash('sha256').update('').digest('hex');
const DEFAULT_PART = 16 * 1024 * 1024;

/** RFC 3986 encoding as SigV4 requires. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** Transport-shaped failures are retried; answers (403, 404, 409) are not. */
  get kind(): string | undefined {
    return this.status >= 500 || this.status === 429 ? undefined : 'ACCESS_BLOCKED';
  }
}

export function createS3Backend(config: S3Config): ArtifactBackend {
  const fetchImpl = config.fetchImpl ?? fetch;
  const partBytes = config.partBytes ?? DEFAULT_PART;
  const base = new URL(config.endpoint.replace(/\/$/, ''));
  const retry = (label: string) => ({
    ...(config.retryPolicy ? { policy: config.retryPolicy } : {}),
    ...(config.sleep ? { sleep: config.sleep } : {}),
    label,
  });

  const objectPath = (key: string): string =>
    `${base.pathname.replace(/\/$/, '')}/${enc(config.bucket)}/${key.split('/').map(enc).join('/')}`;
  const bucketPath = (): string => `${base.pathname.replace(/\/$/, '')}/${enc(config.bucket)}`;

  /** Signs and sends one request. Body is a Buffer (bounded) or absent. */
  async function send(
    method: string,
    path: string,
    query: Readonly<Record<string, string>> = {},
    options: { body?: Buffer; headers?: Record<string, string>; payloadSha?: string } = {},
  ): Promise<Response> {
    const now = (config.now ?? (() => new Date()))();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const payloadSha = options.payloadSha ?? (options.body ? createHash('sha256').update(options.body).digest('hex') : EMPTY_SHA);
    const host = base.host;
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadSha,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const signed = Object.keys(headers).sort();
    const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k] as string)}`).join('&');
    const canonicalRequest = [
      method, path, canonicalQuery,
      signed.map((h) => `${h}:${String(headers[h]).trim()}\n`).join(''),
      signed.join(';'), payloadSha,
    ].join('\n');
    const scope = `${day}/${config.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    let key: Buffer = createHmac('sha256', `AWS4${config.secretAccessKey}`).update(day).digest();
    for (const part of [config.region, 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
    const signature = createHmac('sha256', key).update(toSign).digest('hex');

    const { host: _h, ...sendHeaders } = headers;
    const url = `${base.protocol}//${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    return fetchImpl(url, {
      method,
      headers: {
        ...sendHeaders,
        authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
      },
      ...(options.body ? { body: options.body } : {}),
    });
  }

  async function expectOk(response: Response, what: string): Promise<Response> {
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(response.status);
    // Deliberately no request headers, URLs with queries, or credentials here.
    throw new S3Error(response.status, code, `${what} failed: ${response.status} ${code}`);
  }

  const head = async (key: string): Promise<ObjectHead | null> =>
    withRetry(async () => {
      const r = await send('HEAD', objectPath(key));
      if (r.status === 404) return null;
      await expectOk(r, 'HEAD');
      return {
        bytes: Number(r.headers.get('content-length') ?? '0'),
        declaredSha256: r.headers.get('x-amz-meta-sha256'),
        contentType: r.headers.get('content-type'),
      };
    }, retry('s3.head'));

  const putBuffer = async (key: string, body: Buffer, contentType: string, sha256: string) =>
    withRetry(async () => expectOk(await send('PUT', objectPath(key), {}, {
      body, headers: { 'content-type': contentType, 'x-amz-meta-sha256': sha256 },
    }), 'PUT'), retry('s3.put'));

  return {
    describe: () => ({ kind: 'S3_COMPATIBLE', durable: true, location: `s3://${config.bucket} @ ${base.host}` }),
    head,

    async putFile(key, path, meta) {
      const existing = await head(key);
      if (existing) {
        // Same key means same bytes, by construction — but it is checked, not
        // assumed. A mismatch is corruption or a rogue writer, and it stops here.
        if (existing.bytes !== meta.bytes || (existing.declaredSha256 !== null && existing.declaredSha256 !== meta.sha256)) {
          fail('IMMUTABILITY', `refusing to overwrite "${key}": the stored object differs`, {
            storedBytes: existing.bytes, incomingBytes: meta.bytes,
          });
        }
        return { created: false };
      }

      const file = await open(path, 'r');
      let uploadId: string | null = null;
      try {
        if (meta.bytes <= partBytes) {
          const body = Buffer.alloc(meta.bytes);
          await file.read(body, 0, meta.bytes, 0);
          await putBuffer(key, body, meta.contentType, meta.sha256);
        } else {
          const init = await withRetry(async () => expectOk(await send('POST', objectPath(key), { uploads: '' }, {
            headers: { 'content-type': meta.contentType, 'x-amz-meta-sha256': meta.sha256 },
          }), 'CreateMultipartUpload'), retry('s3.multipart.init'));
          uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await init.text())?.[1] ?? null;
          if (uploadId === null) fail('TRANSPORT', 'CreateMultipartUpload returned no UploadId');
          const parts: { n: number; etag: string }[] = [];
          const buffer = Buffer.alloc(partBytes);
          for (let n = 1, offset = 0; offset < meta.bytes; n++, offset += partBytes) {
            const length = Math.min(partBytes, meta.bytes - offset);
            await file.read(buffer, 0, length, offset);
            const body = buffer.subarray(0, length);
            const id = uploadId;
            const response = await withRetry(async () => expectOk(
              await send('PUT', objectPath(key), { partNumber: String(n), uploadId: id }, { body }),
              `UploadPart ${n}`,
            ), retry('s3.multipart.part'));
            parts.push({ n, etag: response.headers.get('etag') ?? '' });
          }
          const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
          const id = uploadId;
          await withRetry(async () => {
            const r = await expectOk(await send('POST', objectPath(key), { uploadId: id }, { body: Buffer.from(xml) }), 'CompleteMultipartUpload');
            // S3 can report a failed completion inside a 200.
            const text = await r.text();
            if (text.includes('<Error>')) throw new S3Error(500, 'CompleteFailed', 'CompleteMultipartUpload returned an error body');
          }, retry('s3.multipart.complete'));
          uploadId = null;
        }
      } catch (error) {
        if (uploadId !== null) {
          // Nothing partial may survive to be mistaken for an artifact.
          await send('DELETE', objectPath(key), { uploadId }).catch(() => undefined);
        }
        throw error;
      } finally {
        await file.close();
      }

      const stored = await head(key);
      if (stored === null || stored.bytes !== meta.bytes) {
        fail('IMMUTABILITY', `"${key}" is not the expected size after upload`, { expected: meta.bytes, actual: stored?.bytes ?? null });
      }
      return { created: true };
    },

    async putJson(key, value) {
      const text = `${canonicalJson(value)}\n`;
      const existing = await head(key);
      if (existing) {
        const current = await withRetry(async () => (await expectOk(await send('GET', objectPath(key)), 'GET')).text(), retry('s3.get'));
        return { created: false, identical: current === text };
      }
      const body = Buffer.from(text);
      await putBuffer(key, body, 'application/json', createHash('sha256').update(body).digest('hex'));
      return { created: true, identical: true };
    },

    async getJson<T>(key: string): Promise<T | null> {
      return withRetry(async () => {
        const r = await send('GET', objectPath(key));
        if (r.status === 404) return null;
        return JSON.parse(await (await expectOk(r, 'GET')).text()) as T;
      }, retry('s3.get'));
    },

    async stream(key) {
      const r = await withRetry(async () => {
        const response = await send('GET', objectPath(key));
        if (response.status === 404) fail('REPLAY', `object "${key}" does not exist in the durable store`);
        return expectOk(response, 'GET');
      }, retry('s3.get'));
      if (r.body === null) fail('TRANSPORT', 'GET returned no body');
      return r.body as unknown as AsyncIterable<Uint8Array>;
    },

    async list(prefix) {
      const out: string[] = [];
      let token: string | null = null;
      do {
        const query: Record<string, string> = { 'list-type': '2', prefix };
        if (token) query['continuation-token'] = token;
        const r = await withRetry(async () => expectOk(await send('GET', bucketPath(), query), 'ListObjectsV2'), retry('s3.list'));
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(decodeXml(m[1] as string));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || null
          : null;
      } while (token);
      return out.sort();
    },
  };
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Creates a private bucket. For tests and one-time provisioning only: the
 * ingestion worker never needs, and should never be granted, bucket creation.
 */
export async function createPrivateBucket(config: Omit<S3Config, 'partBytes'>): Promise<void> {
  const { createHmac: hmac, createHash: hash } = await import('node:crypto');
  const base = new URL(config.endpoint.replace(/\/$/, ''));
  const now = (config.now ?? (() => new Date()))();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const path = `${base.pathname.replace(/\/$/, '')}/${enc(config.bucket)}`;
  const body = config.region === 'us-east-1' ? '' :
    `<CreateBucketConfiguration><LocationConstraint>${config.region}</LocationConstraint></CreateBucketConfiguration>`;
  const payload = hash('sha256').update(body).digest('hex');
  const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate, 'x-amz-acl': 'private' };
  const signed = Object.keys(headers).sort();
  const canonical = ['PUT', path, '', signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payload].join('\n');
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash('sha256').update(canonical).digest('hex')].join('\n');
  let k: Buffer = hmac('sha256', `AWS4${config.secretAccessKey}`).update(day).digest();
  for (const p of [config.region, 's3', 'aws4_request']) k = hmac('sha256', k).update(p).digest();
  const { host: _h, ...rest } = headers;
  const r = await (config.fetchImpl ?? fetch)(`${base.protocol}//${base.host}${path}`, {
    method: 'PUT',
    headers: { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${hmac('sha256', k).update(toSign).digest('hex')}` },
    ...(body ? { body } : {}),
  });
  if (!r.ok && r.status !== 409) fail('CONFIG', `bucket creation failed: ${r.status}`);
}
