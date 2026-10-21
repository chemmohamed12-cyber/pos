import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as childProcess from 'child_process';
import { readFileSync as readFile } from 'fs';
import { checkCompanySchema, describeChildFailure, hasFindings, summarizeFindings, tablesCreatedByTags, SCHEMA_CHECK_PROGRAM } from './company-schema-check';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

/** Compiled-migration-like fixture: only the text the scanner reads matters. */
function writeMigration(root: string, tag: string, ts: number, name: string, up: string, down = ''): void {
  const dir = join(root, 'dist', 'database', 'migrations', tag);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ts}-${name}.js`), `class ${name}${ts} { async up(queryRunner) {\n${up}\n}\n async down(queryRunner) {\n${down}\n}\n}\nexports.${name}${ts} = ${name}${ts};\n`);
}

describe('tablesCreatedByTags', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'schema-check-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('collects CREATE TABLE names (quoted, unquoted, IF NOT EXISTS, schema-qualified) from the requested tags only', () => {
    writeMigration(root, 'core', 1, 'A', 'await queryRunner.query(`CREATE TABLE "users" (id int)`); await queryRunner.query(`CREATE TABLE IF NOT EXISTS audit_records (id int)`);');
    writeMigration(root, 'finance', 2, 'B', 'await queryRunner.query(`CREATE TABLE public."cash_sessions" (id int)`);');
    writeMigration(root, 'hr', 3, 'C', 'await queryRunner.query(`CREATE TABLE "employees" (id int)`);');
    expect([...tablesCreatedByTags(root, ['core', 'finance'])].sort()).toEqual(['audit_records', 'cash_sessions', 'users']);
  });

  it('reads only up(): a DROP TABLE inside down() does not remove the table, a DROP in up() does', () => {
    writeMigration(root, 'core', 1, 'A', 'await queryRunner.query(`CREATE TABLE "keep" (id int)`); await queryRunner.query(`CREATE TABLE "gone" (id int)`);', 'await queryRunner.query(`DROP TABLE "keep"`);');
    writeMigration(root, 'core', 2, 'B', 'await queryRunner.query(`DROP TABLE IF EXISTS "gone"`);');
    expect([...tablesCreatedByTags(root, ['core'])]).toEqual(['keep']);
  });

  it('follows renames in timestamp order (the old name is no longer expected, the new one is)', () => {
    writeMigration(root, 'core', 5, 'Rename', 'await queryRunner.query(`ALTER TABLE "old_name" RENAME TO "new_name"`);');
    writeMigration(root, 'core', 1, 'Create', 'await queryRunner.query(`CREATE TABLE "old_name" (id int)`);');
    expect([...tablesCreatedByTags(root, ['core'])]).toEqual(['new_name']);
  });

  it('a tag that is not on disk contributes nothing (no throw)', () => {
    expect(tablesCreatedByTags(root, ['nope']).size).toBe(0);
  });
});

describe('findings helpers', () => {
  it('hasFindings / summarizeFindings (names only, capped, flagged as truncated)', () => {
    expect(hasFindings({ missingTables: [], missingColumns: {} })).toBe(false);
    expect(hasFindings({ missingTables: ['t'], missingColumns: {} })).toBe(true);
    expect(hasFindings({ missingTables: [], missingColumns: { products: ['itemType'] } })).toBe(true);
    const many = { missingTables: Array.from({ length: 30 }, (_, i) => `t${i}`), missingColumns: {} };
    const s = summarizeFindings(many, 5);
    expect(s.missingTableCount).toBe(30);
    expect((s.missingTables as string[]).length).toBe(5);
    expect(s.truncated).toBe(true);
  });
});

describe('checkCompanySchema (child process mocked)', () => {
  let root: string;
  const db = { host: 'h', port: 5432, username: 'u', password: 'S3cr3t-pw', database: 'company_x' };
  const execFileMock = childProcess.execFile as unknown as jest.Mock;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'schema-check-'));
    writeMigration(root, 'core', 1, 'A', 'await queryRunner.query(`CREATE TABLE "products" (id int)`);');
    execFileMock.mockReset();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const respond = (err: unknown, stdout = '') =>
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: { stdout: string; stderr: string }) => void) => {
      // util.promisify(execFile) resolves with { stdout, stderr }
      if (err) cb(err);
      else cb(null, { stdout, stderr: '' });
    });

  it('runs the program in the CANDIDATE directory, passes credentials only through the environment, and returns the findings', async () => {
    respond(null, JSON.stringify({ checked: 90, missingTables: ['cash_sessions'], missingColumns: { products: ['itemType'] } }));
    const r = await checkCompanySchema(root, db, ['core'], 'node');
    expect(r).toEqual({ ran: true, checkedTables: 90, findings: { missingTables: ['cash_sessions'], missingColumns: { products: ['itemType'] } }, via: 'child_process' });
    const [bin, args, opts] = execFileMock.mock.calls[0];
    expect(bin).toBe('node');
    expect(args).toEqual(['-e', SCHEMA_CHECK_PROGRAM]);
    expect(opts.cwd).toBe(root);
    expect(JSON.stringify(args)).not.toContain('S3cr3t-pw'); // never in argv
    const cfg = JSON.parse(opts.env.DAII_SCHEMA_CHECK_CFG);
    expect(cfg.createdTables).toEqual(['products']);
    expect(cfg.database).toBe('company_x');
  });

  it('the child program is READ-ONLY by construction: the session is set read-only and it contains no write statement', () => {
    expect(SCHEMA_CHECK_PROGRAM).toContain('SET default_transaction_read_only = on');
    expect(SCHEMA_CHECK_PROGRAM).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE\s+TABLE|TRUNCATE)\b/i);
    expect(SCHEMA_CHECK_PROGRAM).toContain('synchronize: false');
  });

  it('a failing child => ran:false with a redacted message (never "clean", never the password)', async () => {
    respond(Object.assign(new Error('boom'), { stderr: 'password authentication failed for S3cr3t-pw' }));
    const r = await checkCompanySchema(root, db, ['core'], 'node');
    expect(r.ran).toBe(false);
    expect(r.error).toContain('password authentication failed');
    expect(r.error).not.toContain('S3cr3t-pw');
    expect(r.findings).toEqual({ missingTables: [], missingColumns: {} });
  });

  it('the reported reason is the exit code / signal / stderr, NEVER the echoed command line (the host showed only "Command failed: node -e const path = require")', async () => {
    respond(Object.assign(new Error('Command failed: node -e ' + SCHEMA_CHECK_PROGRAM), { signal: 'SIGKILL', stderr: '' }));
    const r = await checkCompanySchema(root, db, ['core'], 'node');
    expect(r.ran).toBe(false);
    expect(r.error).toContain('killed by SIGKILL');
    expect(r.error).toContain('no stderr output');
    expect(r.error).not.toContain('Command failed');
    expect(r.error).not.toContain('const path');
  });

  it('describeChildFailure covers timeout, start failure, exit code and stderr tail', () => {
    expect(describeChildFailure({ killed: true, signal: 'SIGTERM' }, 120_000)).toContain('120s timeout');
    expect(describeChildFailure({ code: 'EAGAIN' }, 1)).toContain('could not be started (EAGAIN)');
    expect(describeChildFailure({ code: 1, stderr: 'x'.repeat(1000) + 'THE-END' }, 1)).toMatch(/exited with code 1; stderr: .*THE-END$/);
  });

  it('the in-process fallback is used ONLY when allowed (the candidate is the running build); otherwise the child failure is reported as it is', async () => {
    respond(Object.assign(new Error('x'), { signal: 'SIGKILL', stderr: '' }));
    const r = await checkCompanySchema(root, db, ['core'], 'node', 1000, false);
    expect(r.ran).toBe(false);
    expect(r.via).toBe('child_process');
    const withFallback = await checkCompanySchema(root, db, ['core'], 'node', 1000, true); // root has no typeorm / dist registry -> the fallback cannot run either
    expect(withFallback.ran).toBe(false);
    expect(withFallback.error).toContain('child process:');
    expect(withFallback.error).toContain('in-process:');
  });

  it('unparseable output => ran:false (never clean)', async () => {
    respond(null, 'not json at all');
    const r = await checkCompanySchema(root, db, ['core'], 'node');
    expect(r.ran).toBe(false);
  });
});

describe('owner tool parity', () => {
  it('tools/maintenance/company-migration-status.js embeds EXACTLY the same child program as the engine (one behaviour, two entry points)', () => {
    const tool = readFile(join(process.cwd(), 'tools', 'maintenance', 'company-migration-status.js'), 'utf8').split('\r\n').join('\n');
    expect(tool).toContain('String.raw`' + SCHEMA_CHECK_PROGRAM + '`');
  });
});
