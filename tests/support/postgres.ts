/**
 * Disposable PostgreSQL cluster for migration-execution tests.
 *
 * DF-0A shipped migrations that were only ever verified *structurally* — the SQL
 * was read, not run. That was a real P1: a structural test cannot catch a typo
 * in a CHECK constraint, a FK to a column that does not exist, or a DO block that
 * throws. This harness boots a genuine PostgreSQL server, applies the migrations,
 * and lets the tests interrogate `pg_catalog` and real row behaviour.
 *
 * The cluster is created in a temp directory, listens on an ephemeral loopback
 * port, is never reachable off-host, and is deleted on teardown. It has no
 * relationship to any Reivesti database.
 *
 * Binaries are discovered, never assumed:
 *   1. $DF_PG_BINDIR
 *   2. node_modules/@embedded-postgres/<platform>/native/bin  (optionalDependency)
 *   3. pg_ctl on PATH
 * When none is found, `startDisposablePostgres` returns null and the tests skip
 * loudly rather than passing vacuously.
 */
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Roles the migrations expect to exist, mirroring a Supabase project. */
export const APP_ROLES = ['anon', 'authenticated'] as const;
export const SERVICE_ROLE = 'df_service';
const SUPERUSER = 'dfsuper';

export type DisposablePostgres = {
  readonly binDir: string;
  readonly version: string;
  readonly port: number;
  /** Creates a brand-new database and returns its name. */
  createDatabase(name: string): Promise<string>;
  connect(database: string, user?: string): Promise<pg.Client>;
  /** Applies db/migrations/*.sql in filename order to `database`. */
  applyMigrations(database: string, files?: readonly string[]): Promise<readonly string[]>;
  stop(): Promise<void>;
};

export function findPostgresBinDir(): string | null {
  const fromEnv = process.env['DF_PG_BINDIR'];
  if (fromEnv && existsSync(join(fromEnv, 'pg_ctl'))) return fromEnv;

  for (const platform of [`${process.platform}-${process.arch}`]) {
    const candidate = join(REPO, 'node_modules', '@embedded-postgres', platform, 'native', 'bin');
    if (existsSync(join(candidate, 'pg_ctl'))) return candidate;
  }

  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir && existsSync(join(dir, 'pg_ctl'))) return dir;
  }
  return null;
}

export const POSTGRES_UNAVAILABLE_MESSAGE =
  'No PostgreSQL binaries found. Run `npm install` (pulls the embedded-postgres optionalDependency) '
  + 'or set DF_PG_BINDIR to a directory containing pg_ctl/initdb/postgres.';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => { port ? resolvePort(port) : reject(new Error('no free port')); });
    });
  });
}

export async function startDisposablePostgres(): Promise<DisposablePostgres | null> {
  const binDir = findPostgresBinDir();
  if (!binDir) return null;

  // A short base path matters: PostgreSQL caps the Unix socket path at 103
  // bytes. We disable sockets entirely and use loopback TCP, which sidesteps it.
  const root = mkdtempSync(join(tmpdir(), 'df-pg-'));
  const dataDir = join(root, 'data');
  const port = await freePort();

  await run(join(binDir, 'initdb'), [
    '-D', dataDir,
    '-U', SUPERUSER,
    '-A', 'trust', // loopback-only, ephemeral, no data of value: password auth would add nothing
    '--encoding=UTF8',
    '--locale=C',
  ]);

  await run(join(binDir, 'pg_ctl'), [
    '-D', dataDir,
    '-l', join(root, 'server.log'),
    '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c full_page_writes=off`,
    '-w', 'start',
  ]);

  const connect = async (database: string, user: string = SUPERUSER): Promise<pg.Client> => {
    const client = new pg.Client({ host: '127.0.0.1', port, user, database });
    await client.connect();
    return client;
  };

  const admin = await connect('postgres');
  const version = (await admin.query('show server_version')).rows[0].server_version as string;
  // Roles are cluster-wide, so they are created once here. These mirror the
  // roles a Supabase project exposes, which is what the migrations guard against.
  for (const role of APP_ROLES) await admin.query(`create role ${role} nologin`);
  await admin.query(`create role ${SERVICE_ROLE} login bypassrls`);
  await admin.end();

  let stopped = false;

  return {
    binDir,
    version,
    port,

    async createDatabase(name) {
      const client = await connect('postgres');
      await client.query(`drop database if exists ${quoteIdent(name)}`);
      await client.query(`create database ${quoteIdent(name)}`);
      await client.end();
      return name;
    },

    connect,

    async applyMigrations(database, files) {
      const dir = join(REPO, 'db', 'migrations');
      const names = files ?? migrationFiles();
      const client = await connect(database);
      try {
        for (const file of names) {
          const sql = readFileSync(join(dir, file), 'utf8');
          await client.query(sql);
        }
      } finally {
        await client.end();
      }
      return names;
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      await run(join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop']).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function migrationFiles(): readonly string[] {
  return readdirSync(join(REPO, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/**
 * A stable text signature of everything the migrations created: schemas, tables,
 * columns with types/nullability/defaults, constraints with their expressions,
 * indexes, RLS flags and policies. Two independent fresh applications must
 * produce byte-identical output.
 */
export async function schemaSignature(client: pg.Client): Promise<string> {
  const lines: string[] = [];

  const columns = await client.query(`
    select table_schema, table_name, column_name, data_type, is_nullable,
           coalesce(column_default, '') as column_default,
           coalesce(character_maximum_length::text, '') as maxlen
    from information_schema.columns
    where table_schema in ('data_fabric','data_fabric_restricted')
    order by table_schema, table_name, column_name`);
  for (const r of columns.rows) {
    lines.push(`col ${r.table_schema}.${r.table_name}.${r.column_name} ${r.data_type} null=${r.is_nullable} def=${r.column_default} len=${r.maxlen}`);
  }

  const constraints = await client.query(`
    select n.nspname, rel.relname, con.conname, con.contype,
           pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname in ('data_fabric','data_fabric_restricted')
    order by n.nspname, rel.relname, con.conname`);
  for (const r of constraints.rows) {
    lines.push(`con ${r.nspname}.${r.relname}.${r.conname} ${r.contype} ${r.def}`);
  }

  const indexes = await client.query(`
    select schemaname, tablename, indexname, indexdef
    from pg_indexes
    where schemaname in ('data_fabric','data_fabric_restricted')
    order by schemaname, tablename, indexname`);
  for (const r of indexes.rows) lines.push(`idx ${r.schemaname}.${r.tablename}.${r.indexname} ${r.indexdef}`);

  const rls = await client.query(`
    select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('data_fabric','data_fabric_restricted') and c.relkind = 'r'
    order by n.nspname, c.relname`);
  for (const r of rls.rows) lines.push(`rls ${r.nspname}.${r.relname} enabled=${r.relrowsecurity} forced=${r.relforcerowsecurity}`);

  const policies = await client.query(`
    select schemaname, tablename, policyname, permissive, roles::text, cmd,
           coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname in ('data_fabric','data_fabric_restricted')
    order by schemaname, tablename, policyname`);
  for (const r of policies.rows) {
    lines.push(`pol ${r.schemaname}.${r.tablename}.${r.policyname} ${r.permissive} ${r.roles} ${r.cmd} using=${r.qual} check=${r.with_check}`);
  }

  return lines.join('\n');
}
