import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Company } from '../company/company.entity';
import { CompanyService } from '../company/company.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { AppConfigService } from '../configuration/app-config.service';
import { AuditRecord } from '../audit/audit-record.entity';
import { AuditService } from '../audit/audit.service';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { discoverMigrationTags } from './migration-datasource';
import { CompanyFanoutBlockedError, CompanyFanoutService, migrationNamesByTag, tagsReceivedByCompany } from './company-fanout.service';
import { BackupManagerService } from './backup-manager.service';

/**
 * CTO 2026-10-08 — Company fan-out against REAL Postgres (the isolated instance; this spec refuses to run against the shared dev server). A real control plane
 * (the repo's own `core` migrations), real disposable Company databases migrated from a small synthetic "old" release tree, and the real service migrating them
 * to a "new" tree. What is proven: discovery (READY only), tag derivation (a Company never receives a tag it never had), the read-only plan, restore-point
 * policy, the READY -> MIGRATING -> READY lifecycle, stop-at-first-failure with the unchanged-database proof, forward-only behaviour, idempotence, verification,
 * and the audit evidence. Nothing here touches any non-`daii_test_*` database.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const USERNAME = process.env.DB_USER ?? '';
const PASSWORD = process.env.DB_PASSWORD ?? '';
const NS = process.env.DAII_TEST_DB_NS ?? ''; // regression runner namespace (biz_tNN_), see two-company-real-pg-harness.ts
const PREFIX = `daii_test_${NS}fo_${randomUUID().slice(0, 8)}`;
// fixtures are written INSIDE the project root (never the OS temp directory)
const tmpdir = (): string => {
  const d = join(process.cwd(), '.test-tmp');
  mkdirSync(d, { recursive: true });
  return d;
};
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

type Mig = { ts: string; name: string; up: string; down?: string };
function writeTree(root: string, tree: Record<string, Mig[]>): string {
  for (const [tag, migs] of Object.entries(tree)) {
    const dir = join(root, 'dist', 'database', 'migrations', tag);
    mkdirSync(dir, { recursive: true });
    for (const m of migs) {
      const cls = `${m.name}${m.ts}`;
      writeFileSync(
        join(dir, `${m.ts}-${m.name}.js`),
        `class ${cls} {\n  constructor() { this.name = '${cls}'; }\n  async up(q) { ${m.up} }\n  async down(q) { ${m.down ?? ''} }\n}\nmodule.exports = { ${cls} };\n`,
      );
    }
  }
  return root;
}
const create = (t: string) => `await q.query('CREATE TABLE "${t}" (id int)');`;
const OLD: Record<string, Mig[]> = {
  core: [{ ts: '1790900000001', name: 'CoreBase', up: create('core_base') }],
  sales: [{ ts: '1790900000002', name: 'SalesBase', up: create('sales_base') }],
  hr: [{ ts: '1790900000003', name: 'HrBase', up: create('hr_base') }],
};
const NEW_ONLY: Record<string, Mig[]> = {
  core: [{ ts: '1790900001001', name: 'CoreNew', up: create('core_new') }],
  sales: [{ ts: '1790900001002', name: 'SalesNew', up: create('sales_new') }],
  hr: [{ ts: '1790900001003', name: 'HrNew', up: create('hr_new') }],
  manufacturing: [{ ts: '1790900001004', name: 'MfgFirst', up: create('mfg_first') }], // a tag NO Company has ever received
};
const merge = (a: Record<string, Mig[]>, b: Record<string, Mig[]>): Record<string, Mig[]> => {
  const out: Record<string, Mig[]> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = [...(a[k] ?? []), ...(b[k] ?? [])];
  return out;
};

const describeIsolated = PORT && PORT !== 5433 && USERNAME ? describe : describe.skip;

describeIsolated('Company fan-out — real Postgres (isolated instance only)', () => {
  jest.setTimeout(300_000);
  let rootOld: string;
  let rootNew: string;
  let rootFail: string;
  let control: DataSource;
  let companies: CompanyService;
  let registry: DatabaseRegistryService;
  let audit: AuditService;
  let service: CompanyFanoutService;
  let backups: { createBackup: jest.Mock };
  let cfgMock: { releaseDeploy: { companyMigrations: string; companyBackupPolicy: 'create' | 'require-recent'; companyBackupMaxAgeHours: number } };
  const made: Array<{ id: string; db: string }> = [];

  const dbCfg = (database: string) => ({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database });
  async function admin<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
    const ds = new DataSource({ type: 'postgres', ...dbCfg('postgres'), synchronize: false, logging: false });
    await ds.initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  }

  /** A disposable Company database migrated from the OLD tree with exactly `tags`, registered ACTIVE with the given Company status. */
  async function addCompany(name: string, tags: string[], status: 'READY' | 'SUSPENDED' = 'READY'): Promise<{ id: string; db: string }> {
    const db = `${PREFIX}_${name.toLowerCase()}_${made.length}`;
    await admin((ds) => ds.query(`CREATE DATABASE "${db}"`));
    const m = await runMigrationsForDatabase(rootOld, dbCfg(db), tags);
    if (!m.success) throw new Error(`fixture migration failed: ${m.error}`);
    const company = await companies.create({ installationId: 'installation', name: `${PREFIX}-${name}`, status });
    await registry.register({ companyId: company.id, host: HOST, port: PORT, databaseName: db, status: 'ACTIVE' }, JSON.stringify({ username: USERNAME, password: PASSWORD }));
    made.push({ id: company.id, db });
    return { id: company.id, db };
  }

  async function dbFingerprint(db: string): Promise<{ migrations: string; tables: string[] }> {
    const ds = new DataSource({ type: 'postgres', ...dbCfg(db), synchronize: false, logging: false });
    await ds.initialize();
    try {
      const mig: Array<{ h: string }> = await ds.query(`SELECT md5(coalesce(string_agg(name, '|' ORDER BY id), '')) h FROM migrations`);
      const tables: Array<{ tablename: string }> = await ds.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
      return { migrations: mig[0].h, tables: tables.map((t) => t.tablename) };
    } finally {
      await ds.destroy();
    }
  }
  const statusOf = async (id: string) => (await companies.findById(id))!.status;
  const auditActions = async (like: string): Promise<Array<{ action: string; result: string; after: Record<string, unknown> }>> =>
    control.query(`SELECT action, result, after FROM audit_records WHERE action LIKE $1 ORDER BY seq`, [like]);

  beforeAll(async () => {
    rootOld = writeTree(mkdtempSync(join(tmpdir(), 'fo-old-')), OLD);
    rootNew = writeTree(mkdtempSync(join(tmpdir(), 'fo-new-')), merge(OLD, NEW_ONLY));
    rootFail = writeTree(mkdtempSync(join(tmpdir(), 'fo-fail-')), merge(OLD, {
      ...NEW_ONLY,
      sales: [{ ts: '1790900001002', name: 'SalesNew', up: `${create('sales_new')} throw new Error('injected failure in SalesNew');` }],
    }));
    const cpDb = `${PREFIX}_control_plane`;
    await admin((ds) => ds.query(`CREATE DATABASE "${cpDb}"`));
    const cp = await runMigrationsForDatabase(process.cwd(), dbCfg(cpDb), ['core']);
    if (!cp.success) throw new Error(`control-plane migration failed: ${cp.error}`);
    control = new DataSource({ type: 'postgres', ...dbCfg(cpDb), synchronize: false, logging: false, entities: [Company, DatabaseRegistry, DatabaseCredential, AuditRecord] });
    await control.initialize();
    await control.query(`INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ('installation','test-installation','Test','DAII_STANDARD','1.0.0','{}')`);
    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    registry = new DatabaseRegistryService(control.getRepository(DatabaseRegistry), control.getRepository(DatabaseCredential), cipher);
    companies = new CompanyService(control.getRepository(Company));
    audit = new AuditService(control);
  });

  afterAll(async () => {
    if (control?.isInitialized) await control.destroy();
    await admin(async (ds) => {
      const rows: Array<{ datname: string }> = await ds.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`${PREFIX}%`]);
      for (const r of rows) await ds.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    });
    for (const r of [rootOld, rootNew, rootFail]) if (r) rmSync(r, { recursive: true, force: true });
  });

  beforeEach(() => {
    cfgMock = { releaseDeploy: { companyMigrations: 'on', companyBackupPolicy: 'create', companyBackupMaxAgeHours: 24 } };
    // The restore-point collaborator is the engine's pg_dump pipeline (proven by its own specs); here it writes the rows that pipeline writes.
    backups = {
      createBackup: jest.fn(async (_trigger: string, _actor: string | null, companyId: string) => {
        const id = randomUUID();
        await control.query(`INSERT INTO "backup_runs" ("id","trigger","initiatedByUserId","companyId","status","sourceAppVersion","completedAt") VALUES ($1,'pre_update',NULL,$2,'completed','1.0.0',now())`, [id, companyId]);
        await control.query(`INSERT INTO "backup_artifacts" ("backupRunId","type","filePath","sizeBytes","checksumSha256","status","verifiedAt") VALUES ($1,'database','x.dump',1,$2,'verified',now())`, [id, 'a'.repeat(64)]);
        return { id };
      }),
    };
    service = new CompanyFanoutService(cfgMock as unknown as AppConfigService, registry, companies, backups as unknown as BackupManagerService, control, audit);
  });

  afterEach(async () => {
    const ids = made.map((m) => m.id);
    if (ids.length) {
      await control.query(`DELETE FROM "backup_artifacts" WHERE "backupRunId" IN (SELECT id FROM "backup_runs" WHERE "companyId" = ANY($1::uuid[]))`, [ids]);
      await control.query(`DELETE FROM "backup_runs" WHERE "companyId" = ANY($1::uuid[])`, [ids]);
      await control.query(`DELETE FROM "database_credentials" WHERE "databaseRegistryId" IN (SELECT id FROM "database_registries" WHERE "companyId" = ANY($1::uuid[]))`, [ids]);
      await control.query(`DELETE FROM "database_registries" WHERE "companyId" = ANY($1::uuid[])`, [ids]);
      await control.query(`DELETE FROM "companies" WHERE "id" = ANY($1::uuid[])`, [ids]);
    }
    for (const m of made.splice(0)) await admin((ds) => ds.query(`DROP DATABASE IF EXISTS "${m.db}" WITH (FORCE)`));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('NAME CONVENTION: the file-name -> migration-name mapping that tag derivation relies on matches TypeORM exactly for EVERY migration in the real compiled set', () => {
    const root = process.cwd();
    const tags = discoverMigrationTags(root);
    expect(tags.length).toBeGreaterThanOrEqual(13);
    const mapped = migrationNamesByTag(root, tags);
    const actual = new Map<string, Set<string>>();
    for (const tag of tags) {
      const names = new Set<string>();
      const dir = join(root, 'dist', 'database', 'migrations', tag);
      for (const f of readdirSync(dir).filter((x) => /^\d.*\.js$/.test(x))) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(join(dir, f)) as Record<string, new () => { name?: string }>;
        for (const cls of Object.values(mod)) if (typeof cls === 'function') names.add(new cls().name ?? cls.name);
      }
      actual.set(tag, names);
    }
    for (const tag of tags) expect([...(mapped.get(tag) ?? [])].sort()).toEqual([...(actual.get(tag) ?? [])].sort());
    const total = [...mapped.values()].reduce((n, s) => n + s.size, 0);
    expect(total).toBeGreaterThan(250);
  });

  it('tagsReceivedByCompany: core always; another tag only if the Company has at least one executed migration of it', () => {
    const byTag = new Map([['core', new Set(['A1'])], ['sales', new Set(['S1', 'S2'])], ['hr', new Set(['H1'])]]);
    expect(tagsReceivedByCompany(byTag, new Set())).toEqual(['core']);
    expect(tagsReceivedByCompany(byTag, new Set(['S2']))).toEqual(['core', 'sales']);
    expect(tagsReceivedByCompany(byTag, new Set(['S1', 'H1', 'X9']))).toEqual(['core', 'hr', 'sales']);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('plan (read-only)', () => {
    it('discovers READY Companies only, derives each one\'s tags from ITS OWN history, never invents a tag, and writes nothing', async () => {
      const a = await addCompany('Aardvark', ['core']);
      const b = await addCompany('Badger', ['core', 'sales']);
      const c = await addCompany('Camel', ['core', 'sales', 'hr']);
      const d = await addCompany('Dormouse', ['core', 'sales'], 'SUSPENDED');
      const before = await Promise.all([a, b, c, d].map((x) => dbFingerprint(x.db)));

      const plan = await service.plan(rootNew);

      expect(plan.blockers).toEqual([]);
      const byName = Object.fromEntries(plan.planned.map((p) => [p.companyName.replace(`${PREFIX}-`, ''), p]));
      expect(Object.keys(byName).sort()).toEqual(['Aardvark', 'Badger', 'Camel']);
      expect(byName.Aardvark.tags).toEqual(['core']);
      expect(byName.Aardvark.pending).toEqual(['CoreNew1790900001001']);
      expect(byName.Badger.tags).toEqual(['core', 'sales']);
      expect(byName.Badger.pending.sort()).toEqual(['CoreNew1790900001001', 'SalesNew1790900001002']);
      expect(byName.Camel.tags).toEqual(['core', 'hr', 'sales']);
      expect(byName.Camel.pending.sort()).toEqual(['CoreNew1790900001001', 'HrNew1790900001003', 'SalesNew1790900001002']);
      for (const p of plan.planned) expect(p.pending.join()).not.toContain('MfgFirst'); // the new tag is NEVER pushed onto a Company that never had it
      expect(plan.skipped).toEqual([expect.objectContaining({ companyId: d.id, reason: expect.stringContaining('SUSPENDED') })]);

      const after = await Promise.all([a, b, c, d].map((x) => dbFingerprint(x.db)));
      expect(after).toEqual(before); // plan = zero writes to any Company database
      for (const x of [a, b, c]) expect(await statusOf(x.id)).toBe('READY');
      expect(await statusOf(d.id)).toBe('SUSPENDED');
    });

    it('a READY Company that cannot be evaluated is a BLOCKER (never silently skipped)', async () => {
      const a = await addCompany('Aardvark', ['core']);
      await control.query(`UPDATE "database_registries" SET "databaseName" = 'daii_test_does_not_exist' WHERE "companyId" = $1`, [a.id]);
      const plan = await service.plan(rootNew);
      expect(plan.blockers).toHaveLength(1);
      expect(plan.blockers[0]).toContain(a.id);
      expect(plan.planned).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('restore points', () => {
    it('policy `create`: one verified pre_update backup per Company that has something pending — none for a Company with nothing to do', async () => {
      const a = await addCompany('Aardvark', ['core']);
      const done = await addCompany('Done', ['core']);
      await runMigrationsForDatabase(rootNew, dbCfg(done.db), ['core']); // already up to date
      const plan = await service.plan(rootNew);
      const ev = await service.ensureBackups(plan, ACTOR);
      expect(backups.createBackup).toHaveBeenCalledTimes(1);
      expect(backups.createBackup).toHaveBeenCalledWith('pre_update', ACTOR, a.id);
      expect(ev).toEqual([{ companyId: a.id, backupRunId: expect.any(String), basis: 'created' }]);
    });

    it('policy `create`: a backup that does not verify BLOCKS (nothing is migrated by this call, by construction)', async () => {
      const a = await addCompany('Aardvark', ['core']);
      backups.createBackup.mockImplementation(async (_t: string, _u: string, companyId: string) => {
        const id = randomUUID();
        await control.query(`INSERT INTO "backup_runs" ("id","trigger","companyId","status","sourceAppVersion") VALUES ($1,'pre_update',$2,'failed','1.0.0')`, [id, companyId]);
        return { id };
      });
      const plan = await service.plan(rootNew);
      await expect(service.ensureBackups(plan, ACTOR)).rejects.toBeInstanceOf(CompanyFanoutBlockedError);
      expect((await dbFingerprint(a.db)).tables).not.toContain('core_new');
    });

    it('policy `require-recent`: no verified backup => BLOCKED; a verified recent one is accepted (basis `recent`); an OLD one is not', async () => {
      cfgMock.releaseDeploy.companyBackupPolicy = 'require-recent';
      const a = await addCompany('Aardvark', ['core']);
      const plan = await service.plan(rootNew);
      await expect(service.ensureBackups(plan, ACTOR)).rejects.toThrow(/no verified backup newer than 24h/);

      const old = randomUUID();
      await control.query(`INSERT INTO "backup_runs" ("id","trigger","companyId","status","sourceAppVersion","completedAt") VALUES ($1,'manual',$2,'completed','1.0.0', now() - interval '48 hours')`, [old, a.id]);
      await control.query(`INSERT INTO "backup_artifacts" ("backupRunId","type","filePath","sizeBytes","checksumSha256","status") VALUES ($1,'database','o.dump',1,$2,'verified')`, [old, 'b'.repeat(64)]);
      await expect(service.ensureBackups(plan, ACTOR)).rejects.toBeInstanceOf(CompanyFanoutBlockedError);

      const fresh = randomUUID();
      await control.query(`INSERT INTO "backup_runs" ("id","trigger","companyId","status","sourceAppVersion","completedAt") VALUES ($1,'manual',$2,'completed','1.0.0', now() - interval '2 hours')`, [fresh, a.id]);
      await control.query(`INSERT INTO "backup_artifacts" ("backupRunId","type","filePath","sizeBytes","checksumSha256","status") VALUES ($1,'database','f.dump',1,$2,'verified')`, [fresh, 'c'.repeat(64)]);
      expect(await service.ensureBackups(plan, ACTOR)).toEqual([{ companyId: a.id, backupRunId: fresh, basis: 'recent' }]);
      expect(backups.createBackup).not.toHaveBeenCalled(); // require-recent never creates one
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('migrate', () => {
    it('HAPPY PATH: every applicable READY Company is migrated READY -> MIGRATING -> READY; the SUSPENDED one and the never-had tag are untouched; verify is clean; a re-run is a no-op; evidence is in the audit chain', async () => {
      const a = await addCompany('Aardvark', ['core']);
      const b = await addCompany('Badger', ['core', 'sales']);
      const c = await addCompany('Camel', ['core', 'sales', 'hr']);
      const d = await addCompany('Dormouse', ['core', 'sales'], 'SUSPENDED');
      const dBefore = await dbFingerprint(d.db);
      const transitions: Array<[string, string]> = [];
      const upd = jest.spyOn(companies, 'update');
      upd.mockImplementation(async (id: string, data: Partial<Pick<Company, 'name' | 'status'>>) => {
        transitions.push([id, String(data.status)]);
        return CompanyService.prototype.update.call(companies, id, data);
      });

      const plan = await service.plan(rootNew);
      const ev = await service.ensureBackups(plan, ACTOR);
      const releaseId = randomUUID();
      const result = await service.migrate(plan, rootNew, ACTOR, releaseId, ev);

      expect(result.ok).toBe(true);
      expect(result.outcomes.map((o) => o.status)).toEqual(['migrated', 'migrated', 'migrated']);
      expect(result.outcomes.map((o) => o.finalCompanyStatus)).toEqual(['READY', 'READY', 'READY']);
      for (const x of [a, b, c]) expect(transitions.filter(([id]) => id === x.id).map(([, s]) => s)).toEqual(['MIGRATING', 'READY']);
      expect((await dbFingerprint(a.db)).tables).toEqual(expect.arrayContaining(['core_new']));
      expect((await dbFingerprint(a.db)).tables).not.toContain('sales_new'); // Aardvark never had sales
      expect((await dbFingerprint(b.db)).tables).toEqual(expect.arrayContaining(['core_new', 'sales_new']));
      expect((await dbFingerprint(c.db)).tables).toEqual(expect.arrayContaining(['core_new', 'sales_new', 'hr_new']));
      for (const x of [a, b, c, d]) expect((await dbFingerprint(x.db)).tables).not.toContain('mfg_first'); // a tag no Company ever had is never applied
      expect(await dbFingerprint(d.db)).toEqual(dBefore); // the SUSPENDED Company: bit-for-bit untouched
      expect(await statusOf(d.id)).toBe('SUSPENDED');
      expect(await service.verify(plan, rootNew)).toEqual({});

      const events = (await auditActions('release.deploy.company_migration_%')).filter((e) => (e.after as { companyId?: string }).companyId && [a.id, b.id, c.id].includes((e.after as { companyId: string }).companyId));
      expect(events.map((e) => e.action).sort()).toEqual(Array(3).fill('release.deploy.company_migration_started').concat(Array(3).fill('release.deploy.company_migration_succeeded')).sort());
      const started = events.find((e) => e.action.endsWith('_started') && (e.after as { companyId: string }).companyId === b.id)!;
      expect(started.after.backupRunId).toBe(ev.find((x) => x.companyId === b.id)!.backupRunId);
      expect(JSON.stringify(events)).not.toMatch(/password|credential/i);
      expect((await audit.verifyChain()).valid).toBe(true);

      // idempotent: nothing pending any more, a second pass runs nothing and does not even enter MIGRATING
      transitions.length = 0;
      const plan2 = await service.plan(rootNew);
      expect(plan2.planned.every((p) => p.pending.length === 0)).toBe(true);
      const again = await service.migrate(plan2, rootNew, ACTOR, releaseId);
      expect(again.outcomes.map((o) => o.status)).toEqual(['noop', 'noop', 'noop']);
      expect(transitions).toEqual([]);
      upd.mockRestore();
    });

    it('STOPS AT THE FIRST FAILURE: the earlier Company stays migrated (forward-only), the failing one is rolled back by its own transaction and provably unchanged -> READY, the later one is NOT TOUCHED', async () => {
      const a = await addCompany('Aardvark', ['core']);
      const b = await addCompany('Badger', ['core', 'sales']);
      const c = await addCompany('Camel', ['core', 'sales', 'hr']);
      const bBefore = await dbFingerprint(b.db);
      const cBefore = await dbFingerprint(c.db);

      const plan = await service.plan(rootFail);
      const result = await service.migrate(plan, rootFail, ACTOR, randomUUID());

      expect(result.ok).toBe(false);
      expect(result.outcomes.map((o) => o.status)).toEqual(['migrated', 'failed', 'not_attempted']);
      expect(result.outcomes[1].error).toContain('injected failure in SalesNew');
      expect((await dbFingerprint(a.db)).tables).toContain('core_new'); // forward-only: kept
      expect(await dbFingerprint(b.db)).toEqual(bBefore); // the whole batch (including its core migration) rolled back
      expect(await dbFingerprint(c.db)).toEqual(cBefore); // never attempted
      expect(result.outcomes[1].finalCompanyStatus).toBe('READY'); // provably unchanged -> reopened
      for (const x of [a, b, c]) expect(await statusOf(x.id)).toBe('READY');
      const failed = (await auditActions('release.deploy.company_migration_failed')).find((e) => (e.after as { companyId: string }).companyId === b.id)!;
      expect(failed.result).toBe('failure');
      expect(failed.after.databaseProvablyUnchanged).toBe(true);
      expect(failed.after.stage).toBe('migration');
    });

    it('a Company that is no longer READY at its turn is NOT migrated and the sweep stops (LA-1 re-check at execution time)', async () => {
      const a = await addCompany('Aardvark', ['core']);
      const b = await addCompany('Badger', ['core', 'sales']);
      const plan = await service.plan(rootNew);
      await companies.update(a.id, { status: 'SUSPENDED' }); // suspended between plan and turn
      const before = await dbFingerprint(a.db);
      const result = await service.migrate(plan, rootNew, ACTOR, randomUUID());
      expect(result.outcomes.map((o) => o.status)).toEqual(['failed', 'not_attempted']);
      expect(result.outcomes[0].error).toContain('SUSPENDED');
      expect(await dbFingerprint(a.db)).toEqual(before);
      expect((await dbFingerprint(b.db)).tables).not.toContain('core_new');
      expect(await statusOf(a.id)).toBe('SUSPENDED');
    });

    it('verify() reports a Company that still has pending migrations (the independent post-condition)', async () => {
      const a = await addCompany('Aardvark', ['core']);
      const plan = await service.plan(rootNew); // planned but never migrated
      expect(await service.verify(plan, rootNew)).toEqual({ [`${PREFIX}-Aardvark`]: ['CoreNew1790900001001'] });
      expect((await dbFingerprint(a.db)).tables).not.toContain('core_new');
    });
  });
});
