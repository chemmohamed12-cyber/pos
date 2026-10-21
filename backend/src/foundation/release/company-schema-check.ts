import { execFile } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { DatabaseConfig } from '../configuration/app-config.service';

const execFileAsync = promisify(execFile);

/**
 * Company schema check (CTO 2026-10-21, Company Migration Reliability). A Company database can have a COMPLETE migration list and still not be what the new code
 * queries (a hand-applied fix, a restored older dump, a migration that no-op'd). The 1.1.10 hosting incident looked exactly like that to the application:
 * `column Product.itemType does not exist` -> HTTP 500 on every screen that read the table.
 *
 * What it checks, READ-ONLY, against the CANDIDATE's own compiled entity registry (the very classes the new build will query with):
 *   1. every column of every entity whose table EXISTS in the Company database must exist (missing column = the 1.1.10 failure class);
 *   2. every entity table that the Company's received migration tags CREATE must exist (missing table = the 1.1.11 cash-session / treasury failure class).
 * An entity table that no received tag creates is not expected (the Company never got that module), so a Company without a module is not a finding.
 *
 * Known limits (stated, not hidden): column NAMES only (no type / nullability / default / index / constraint comparison); table creation is detected from
 * `CREATE TABLE` statements in the compiled migration files (a table created only through the TypeORM table API is not detected as expected, though its columns
 * are still checked once it exists).
 *
 * It runs in a child process whose cwd is the candidate, exactly like the dependency check, so the candidate's own `typeorm` and entity classes are loaded
 * without mixing two builds' metadata in the engine process. Credentials travel in the child's environment, never in argv, and are never returned or logged.
 */
export interface CompanySchemaFinding {
  /** Entity tables the Company's received tags create, missing from the database. */
  missingTables: string[];
  /** table -> columns the candidate's entity expects that the database does not have. */
  missingColumns: Record<string, string[]>;
}

export interface CompanySchemaCheckResult {
  /** The check ran to completion (it may still have findings). `false` = it could not run; treat as unverified, never as clean. */
  ran: boolean;
  checkedTables: number;
  findings: CompanySchemaFinding;
  /** Present when `ran` is false. Never contains credentials. */
  error?: string;
  /** How it ran. `in_process` = the child process could not run on this host and the running build's own classes were used (same logic, same read-only session). */
  via?: 'child_process' | 'in_process';
}

export const EMPTY_FINDINGS: CompanySchemaFinding = { missingTables: [], missingColumns: {} };

export function hasFindings(f: CompanySchemaFinding): boolean {
  return f.missingTables.length > 0 || Object.keys(f.missingColumns).length > 0;
}

/** Compact, audit-safe summary (names only, capped). */
export function summarizeFindings(f: CompanySchemaFinding, cap = 20): Record<string, unknown> {
  const cols = Object.entries(f.missingColumns);
  return {
    missingTableCount: f.missingTables.length,
    missingTables: f.missingTables.slice(0, cap),
    tablesWithMissingColumns: cols.length,
    missingColumns: Object.fromEntries(cols.slice(0, cap).map(([t, c]) => [t, c.slice(0, cap)])),
    truncated: f.missingTables.length > cap || cols.length > cap,
  };
}

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi;
const DROP_TABLE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi;
const RENAME_TABLE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?\s+RENAME\s+TO\s+"?([A-Za-z0-9_]+)"?/gi;

/**
 * Tables the given tags create, net of tables later dropped or renamed away, from the compiled migration files in timestamp order. A `down()` also contains
 * `DROP TABLE`; the compiled class text is split at `down(` so only the `up()` side is read.
 */
export function tablesCreatedByTags(candidatePath: string, tags: readonly string[]): Set<string> {
  const files: Array<{ ts: number; text: string }> = [];
  for (const tag of tags) {
    let names: string[] = [];
    try {
      names = readdirSync(join(candidatePath, 'dist', 'database', 'migrations', tag));
    } catch {
      continue;
    }
    for (const f of names) {
      const m = /^(\d+)-.+\.js$/.exec(f);
      if (!m) continue;
      let text = '';
      try {
        text = readFileSync(join(candidatePath, 'dist', 'database', 'migrations', tag, f), 'utf8');
      } catch {
        continue;
      }
      const downAt = text.search(/async\s+down\s*\(/);
      files.push({ ts: Number(m[1]), text: downAt > 0 ? text.slice(0, downAt) : text });
    }
  }
  files.sort((a, b) => a.ts - b.ts);
  const created = new Set<string>();
  for (const { text } of files) {
    for (const re of [CREATE_TABLE, DROP_TABLE, RENAME_TABLE]) re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE.exec(text)) !== null) created.add(m[1]);
    while ((m = RENAME_TABLE.exec(text)) !== null) {
      created.delete(m[1]);
      created.add(m[2]);
    }
    while ((m = DROP_TABLE.exec(text)) !== null) created.delete(m[1]);
  }
  return created;
}

/** The child-process program. Plain JS text so it behaves identically from `src` (ts-jest) and from `dist`. Prints ONE JSON line on stdout. */
export const SCHEMA_CHECK_PROGRAM = `
const path = require('path');
const cfg = JSON.parse(process.env.DAII_SCHEMA_CHECK_CFG);
const typeormPath = require.resolve('typeorm', { paths: [process.cwd()] });
const { DataSource } = require(typeormPath);
const registryPath = path.join(process.cwd(), 'dist', 'foundation', 'database-registry', 'company-entity-registry.js');
const { COMPANY_ENTITY_REGISTRY } = require(registryPath);
(async () => {
  const ds = new DataSource({ type: 'postgres', host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, database: cfg.database, entities: COMPANY_ENTITY_REGISTRY, synchronize: false, logging: false});
  await ds.initialize();
  try {
    const qr = ds.createQueryRunner();
    let rows;
    try {
      await qr.query('SET default_transaction_read_only = on');
      rows = await qr.query("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()");
    } finally { await qr.release(); }
    const have = new Map();
    for (const r of rows) { if (!have.has(r.t)) have.set(r.t, new Set()); have.get(r.t).add(r.c); }
    const expectedCreated = new Set(cfg.createdTables);
    const missingTables = [];
    const missingColumns = {};
    let checked = 0;
    for (const m of ds.entityMetadatas) {
      if (m.tableType === 'view' || !m.tableName) continue;
      const table = m.tableName;
      const cols = have.get(table);
      if (!cols) { if (expectedCreated.has(table)) missingTables.push(table); continue; }
      checked += 1;
      const miss = m.columns.filter((c) => !c.isVirtual && !c.isVirtualProperty && c.databaseName && !cols.has(c.databaseName)).map((c) => c.databaseName);
      if (miss.length) missingColumns[table] = miss;
    }
    process.stdout.write(JSON.stringify({ checked, missingTables: [...new Set(missingTables)].sort(), missingColumns }));
  } finally { await ds.destroy().catch(() => undefined); }
})().catch((e) => { process.stderr.write(String(e && e.message ? e.message : e).slice(0, 300)); process.exit(1); });
`;

/**
 * What actually went wrong with the child process, WITHOUT the error message of execFile (it echoes the whole command line - here the program text - and so buried the
 * real reason when cut for display: the 2026-10-21 host showed only "Command failed: node -e const path = require"). Exit code, signal, timeout and the stderr tail,
 * never the credentials.
 */
export function describeChildFailure(err: unknown, timeoutMs: number): string {
  const e = err as { code?: string | number; signal?: string | null; killed?: boolean; stderr?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  const parts: string[] = [];
  if (e.killed && e.signal === 'SIGTERM') parts.push(`the child process was stopped after the ${Math.round(timeoutMs / 1000)}s timeout`);
  else if (e.signal) parts.push(`the child process was killed by ${e.signal} (typically a memory / process limit of the host)`);
  else if (typeof e.code === 'string') parts.push(`the child process could not be started (${e.code})`);
  else if (typeof e.code === 'number') parts.push(`the child process exited with code ${e.code}`);
  else parts.push('the child process failed');
  parts.push(stderr ? `stderr: ${stderr.slice(-300)}` : 'no stderr output');
  return parts.join('; ');
}

/**
 * The same check run IN this process, with the classes of the build that is running right now. Only valid when the candidate IS the running build (catch-up of the
 * installed release): it is the fallback for a host that will not start a second node process. Same logic as SCHEMA_CHECK_PROGRAM, kept in step by the real-Postgres
 * spec that runs both against the same databases.
 */
export async function checkCompanySchemaInProcess(candidatePath: string, database: DatabaseConfig, tags: readonly string[]): Promise<CompanySchemaCheckResult> {
  const createdTables = tablesCreatedByTags(candidatePath, tags);
  const secret = database.password;
  const redact = (s: string) => (secret ? s.split(secret).join('***') : s);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DataSource } = require(require.resolve('typeorm', { paths: [candidatePath] })) as typeof import('typeorm');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { COMPANY_ENTITY_REGISTRY } = require(join(candidatePath, 'dist', 'foundation', 'database-registry', 'company-entity-registry.js')) as { COMPANY_ENTITY_REGISTRY: never[] };
    const ds = new DataSource({ type: 'postgres', host: database.host, port: database.port, username: database.username, password: database.password, database: database.database, entities: COMPANY_ENTITY_REGISTRY, synchronize: false, logging: false });
    await ds.initialize();
    try {
      const qr = ds.createQueryRunner();
      let rows: Array<{ t: string; c: string }>;
      try {
        await qr.query('SET default_transaction_read_only = on');
        rows = await qr.query('SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()');
      } finally {
        await qr.release();
      }
      const have = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!have.has(r.t)) have.set(r.t, new Set());
        have.get(r.t)!.add(r.c);
      }
      const missingTables: string[] = [];
      const missingColumns: Record<string, string[]> = {};
      let checked = 0;
      for (const m of ds.entityMetadatas) {
        if (m.tableType === 'view' || !m.tableName) continue;
        const cols = have.get(m.tableName);
        if (!cols) {
          if (createdTables.has(m.tableName)) missingTables.push(m.tableName);
          continue;
        }
        checked += 1;
        const miss = m.columns.filter((c) => !c.isVirtual && !c.isVirtualProperty && c.databaseName && !cols.has(c.databaseName)).map((c) => c.databaseName);
        if (miss.length) missingColumns[m.tableName] = miss;
      }
      return { ran: true, checkedTables: checked, findings: { missingTables: [...new Set(missingTables)].sort(), missingColumns }, via: 'in_process' };
    } finally {
      await ds.destroy().catch(() => undefined);
    }
  } catch (err) {
    return { ran: false, checkedTables: 0, findings: { missingTables: [], missingColumns: {} }, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 400), via: 'in_process' };
  }
}

export async function checkCompanySchema(
  candidatePath: string,
  database: DatabaseConfig,
  tags: readonly string[],
  nodeBin: string,
  timeoutMs = 120_000,
  /** Allowed only when `candidatePath` is the build that is running this process. */
  allowInProcessFallback = false,
): Promise<CompanySchemaCheckResult> {
  const child = await checkCompanySchemaChild(candidatePath, database, tags, nodeBin, timeoutMs);
  if (child.ran || !allowInProcessFallback) return child;
  const inProcess = await checkCompanySchemaInProcess(candidatePath, database, tags);
  if (inProcess.ran) return inProcess;
  return { ...inProcess, error: `child process: ${child.error ?? 'failed'} | in-process: ${inProcess.error ?? 'failed'}`.slice(0, 600) };
}

async function checkCompanySchemaChild(candidatePath: string, database: DatabaseConfig, tags: readonly string[], nodeBin: string, timeoutMs: number): Promise<CompanySchemaCheckResult> {
  const createdTables = [...tablesCreatedByTags(candidatePath, tags)];
  const secret = database.password;
  const redact = (s: string) => (secret ? s.split(secret).join('***') : s);
  try {
    const { stdout } = await execFileAsync(nodeBin, ['-e', SCHEMA_CHECK_PROGRAM], {
      cwd: candidatePath,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        DAII_SCHEMA_CHECK_CFG: JSON.stringify({ host: database.host, port: database.port, username: database.username, password: database.password, database: database.database, createdTables }),
      },
    });
    const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { checked?: number; missingTables?: string[]; missingColumns?: Record<string, string[]> };
    return { ran: true, checkedTables: parsed.checked ?? 0, findings: { missingTables: parsed.missingTables ?? [], missingColumns: parsed.missingColumns ?? {} }, via: 'child_process' };
  } catch (err) {
    return { ran: false, checkedTables: 0, findings: { missingTables: [], missingColumns: {} }, error: redact(describeChildFailure(err, timeoutMs)).slice(0, 400), via: 'child_process' };
  }
}
