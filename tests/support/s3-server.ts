/**
 * A disposable, authentication-enforcing S3-compatible server for contract tests.
 *
 * Uses moto's server in IAM-enforcing mode: requests must carry a valid SigV4
 * signature from an IAM user, and that user is granted only object operations
 * on one bucket. So "anonymous read is refused", "a wrong secret is refused"
 * and "another bucket is refused" are tested against a real protocol peer, not
 * against our own client's idea of one.
 *
 * Discovery, never assumed:
 *   1. $DF_TEST_MOTO_SERVER (path to `moto_server`), beside which a `python`
 *      with boto3 is expected (moto installs it)
 *   2. .s3env/bin/moto_server in the repository
 * When neither exists the tests SKIP LOUDLY; they never pass vacuously. CI
 * installs moto (see .github/workflows/ci.yml).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type TestS3 = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  stop(): Promise<void>;
};

export function findMotoServer(): string | null {
  const fromEnv = process.env['DF_TEST_MOTO_SERVER'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(REPO, '.s3env', 'bin', 'moto_server');
  return existsSync(local) ? local : null;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))));
    });
  });
}

export async function startTestS3(bucket = 'fabric-test'): Promise<TestS3 | null> {
  const moto = findMotoServer();
  if (moto === null) return null;
  const port = await freePort();
  const child: ChildProcess = spawn(moto, ['-H', '127.0.0.1', '-p', String(port)], {
    // Four unauthenticated actions: exactly the IAM bootstrap below. After that
    // every request must be signed by a real IAM principal.
    env: { ...process.env, INITIAL_NO_AUTH_ACTION_COUNT: '4', TEST_SERVER_MODE: 'true' },
    stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${endpoint}/moto-api/`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const python = join(dirname(moto), 'python');
  const script = `
import boto3, json
iam = boto3.client('iam', endpoint_url='${endpoint}', region_name='us-east-1', aws_access_key_id='x', aws_secret_access_key='x')
iam.create_user(UserName='worker')
iam.put_user_policy(UserName='worker', PolicyName='fabric', PolicyDocument=json.dumps({"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:ListBucket","s3:AbortMultipartUpload","s3:CreateBucket"],"Resource":["arn:aws:s3:::${bucket}","arn:aws:s3:::${bucket}/*"]}]}))
k = iam.create_access_key(UserName='worker')['AccessKey']
print(k['AccessKeyId'] + ' ' + k['SecretAccessKey'])
`;
  const { stdout } = await run(python, ['-c', script]);
  const [accessKeyId, secretAccessKey] = stdout.trim().split(' ') as [string, string];
  const { createPrivateBucket } = await import('../../src/archive/s3-backend.ts');
  const config = { endpoint, region: 'us-east-1', bucket, accessKeyId, secretAccessKey };
  await createPrivateBucket(config);
  return {
    ...config,
    async stop() {
      child.kill('SIGTERM');
    },
  };
}
