/**
 * Transports.
 *
 * Connectors declare *what* to retrieve; a transport decides *how* bytes arrive.
 * Keeping them apart is what lets one adapter serve an HTTP bulk download today
 * and an SFTP drop or a vendor export later without touching its parser.
 *
 * The `sanctionedOnly` gate lives here rather than in each adapter: no transport
 * that reaches out over a network will run against a source whose registry entry
 * does not record a publisher-sanctioned mechanism. "Public record" is not a
 * licence to automate, and the check is not something an adapter can forget.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fail } from '../core/errors.ts';
import type { AccessType, AutomationStatus } from '../registry/types.ts';
import { type RateLimiter, type RetryPolicy, type Sleep, noRateLimit, withRetry } from './retry.ts';
import type { Logger } from '../core/logging.ts';

export type FetchRequest = {
  /** Location in whatever the transport's address space is: URL, path, key. */
  readonly locator: string;
  readonly filename?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type FetchedPayload = {
  readonly bytes: Uint8Array;
  readonly originalUrl: string | null;
  readonly originalFilename: string;
  readonly mimeType: string | null;
  /** Publisher-declared effective/last-modified instant, when one is offered. */
  readonly effectiveAt: string | null;
};

export type TransportContext = {
  readonly logger: Logger;
  readonly rateLimiter?: RateLimiter;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: Sleep;
};

export type Transport = {
  readonly accessType: AccessType;
  /** True when the transport crosses a network boundary to the publisher. */
  readonly reachesPublisher: boolean;
  fetch(request: FetchRequest, ctx: TransportContext): Promise<FetchedPayload>;
};

export function assertAutomationPermitted(
  transport: Transport,
  automationStatus: AutomationStatus,
  sourceId: string,
): void {
  if (!transport.reachesPublisher) return;
  if (automationStatus !== 'sanctioned') {
    fail('ACCESS_BLOCKED', `automated retrieval of "${sourceId}" is not permitted (automationStatus=${automationStatus})`, {
      sourceId,
      automationStatus,
      accessType: transport.accessType,
      remedy: 'obtain publisher approval and set automationStatus to "sanctioned", or supply the file through the local_file transport',
    });
  }
}

/**
 * Reads bytes an operator has already obtained lawfully and placed on disk.
 * This is the transport DF-0B actually uses: it needs no credentials, touches
 * no publisher system, and makes fixture-driven and replay runs identical to
 * live ones in every step after retrieval.
 */
export function createLocalFileTransport(): Transport {
  return {
    accessType: 'manual_import',
    reachesPublisher: false,
    async fetch(request) {
      let bytes: Buffer;
      try {
        bytes = await readFile(request.locator);
      } catch (e) {
        fail('TRANSPORT', `cannot read local source file "${request.locator}"`, {
          locator: request.locator,
          cause: (e as Error).message,
        });
      }
      return {
        bytes,
        originalUrl: null,
        originalFilename: request.filename ?? basename(request.locator),
        mimeType: null,
        effectiveAt: null,
      };
    },
  };
}

/**
 * HTTP(S) bulk download. Present so the contract is proven against a real
 * network transport; no source in DF-0B is cleared to use it.
 */
export function createHttpTransport(deps: { fetchImpl?: typeof fetch } = {}): Transport {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  return {
    accessType: 'bulk_download',
    reachesPublisher: true,
    async fetch(request, ctx) {
      const limiter = ctx.rateLimiter ?? noRateLimit;
      return withRetry(
        async () => {
          await limiter.acquire();
          const response = await doFetch(request.locator, {
            headers: { ...(request.headers ?? {}) },
            redirect: 'follow',
          }).catch((e: unknown) => fail('TRANSPORT', `request failed: ${(e as Error).message}`, { locator: request.locator }));

          if (!response.ok) {
            fail('TRANSPORT', `HTTP ${response.status} retrieving ${request.locator}`, {
              locator: request.locator,
              status: response.status,
            });
          }
          const buffer = new Uint8Array(await response.arrayBuffer());
          const lastModified = response.headers.get('last-modified');
          return {
            bytes: buffer,
            originalUrl: request.locator,
            originalFilename: request.filename ?? filenameFromUrl(request.locator),
            mimeType: response.headers.get('content-type'),
            effectiveAt: lastModified ? new Date(lastModified).toISOString() : null,
          };
        },
        { logger: ctx.logger, label: `http:${request.locator}`, ...(ctx.retryPolicy ? { policy: ctx.retryPolicy } : {}), ...(ctx.sleep ? { sleep: ctx.sleep } : {}) },
      );
    },
  };
}

function filenameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? decodeURIComponent(last) : 'download';
  } catch {
    return 'download';
  }
}
