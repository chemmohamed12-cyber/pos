import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Installation } from './installation.entity';
import { InstallationBootstrapService } from './installation-bootstrap.service';
import { EntitlementService } from './entitlement.service';
import { AuditRecord } from '../audit/audit-record.entity';
import { AuditService } from '../audit/audit.service';
import { Company } from '../company/company.entity';
import { runMigrationsForDatabase } from '../release-orchestration/company-migration-runner';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * Post-incident review of release 1.1.4 (2026-10-09), against REAL Postgres on the isolated instance (refuses the shared dev server): a platform database whose
 * migrations ran but that never had a licence applied has NO `installation` row, and creating a Company then violates `companies_installationId_fkey`. The first test
 * reproduces that defect; the rest prove the fix — implicit unsigned row in `unlicensed-full`, nothing invented in `enforced`, idempotent, race-safe, never overwriting,
 * and entitlement semantics unchanged.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const USERNAME = process.env.DB_USER ?? '';
const PASSWORD = process.env.DB_PASSWORD ?? '';
const DB = `daii_test_ib_${randomUUID().slice(0, 8)}`;
const describeIsolated = PORT && PORT !== 5433 && USERNAME ? describe : describe.skip;

describeIsolated('Installation bootstrap — real Postgres (isolated instance only)', () => {
  jest.setTimeout(300_000);
  let ds: DataSource;
  let audit: AuditService;
  const cfg = (mode: 'unlicensed-full' | 'enforced') => ({ entitlement: { mode, publicKeys: [], clockToleranceMinutes: 10 } }) as unknown as AppConfigService;
  const service = (mode: 'unlicensed-full' | 'enforced') => new InstallationBootstrapService(ds.getRepository(Installation), cfg(mode), audit);
  const rows = async () => ds.query(`SELECT * FROM "installation"`);
  const auditCount = async () => Number((await ds.query(`SELECT count(*) n FROM audit_records WHERE action = 'entitlement.installation.initialized'`))[0].n);
  const insertCompany = (name: string) => ds.query(`INSERT INTO "companies" ("id","installationId","name","status") VALUES ($1,'installation',$2,'PROVISIONING')`, [randomUUID(), name]);
  const reset = async () => {
    await ds.query(`DELETE FROM "companies"`);
    await ds.query(`DELETE FROM "installation" WHERE "id" = 'installation'`);
    await ds.query(`DELETE FROM "audit_records" WHERE action = 'entitlement.installation.initialized'`);
  };

  beforeAll(async () => {
    const admin = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres' });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${DB}"`);
    await admin.destroy();
    const base = { host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: DB };
    const m = await runMigrationsForDatabase(process.cwd(), base, ['core']);
    if (!m.success) throw new Error(`migration failed: ${m.error}`);
    ds = new DataSource({ type: 'postgres', ...base, synchronize: false, entities: [Installation, AuditRecord, Company] });
    await ds.initialize();
    audit = new AuditService(ds);
  });
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    const admin = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: USERNAME, password: PASSWORD, database: 'postgres' });
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await admin.destroy();
  });
  beforeEach(reset);

  it('REPRODUCES THE INCIDENT: a migrated platform with no installation row cannot create a Company (companies_installationId_fkey)', async () => {
    expect(await rows()).toHaveLength(0);
    await expect(insertCompany('Acme')).rejects.toThrow(/companies_installationId_fkey/);
  });

  it('unlicensed-full: creates the implicit UNSIGNED DAII_STANDARD row — no manifest, no signature, no kid, state `unlicensed` — audited once; Company creation then works', async () => {
    expect(await service('unlicensed-full').ensure()).toBe('created');
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'installation', editionCode: 'DAII_STANDARD', editionVersion: '1.0.0', status: 'active', verificationState: 'unlicensed', manifestSignature: null, manifestKid: null, issuedAt: null, entitlementManifest: {} });
    expect(r[0].installationId).toMatch(/^implicit-[0-9a-f]{32}$/);
    expect(await auditCount()).toBe(1);
    await expect(insertCompany('Acme')).resolves.toBeDefined();
  });

  it('idempotent: a second ensure() (an application restart) changes nothing and audits nothing more', async () => {
    const s = service('unlicensed-full');
    await s.ensure();
    const before = await rows();
    expect(await s.ensure()).toBe('present');
    expect(await rows()).toEqual(before);
    expect(await auditCount()).toBe(1);
  });

  it('race-safe: eight concurrent application starts produce exactly ONE row and ONE audit record', async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => service('unlicensed-full').ensure()));
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'present')).toHaveLength(7);
    expect(await rows()).toHaveLength(1);
    expect(await auditCount()).toBe(1);
  });

  it('NEVER overwrites an existing row — a licensed-looking row is returned untouched', async () => {
    await service('unlicensed-full').ensure();
    await ds.query(`UPDATE "installation" SET "editionCode"='PRO', "manifestSignature"='sig', "manifestKid"='k1', "verificationState"='verified', "customerName"='Real Customer' WHERE id='installation'`);
    const before = await rows();
    expect(await service('unlicensed-full').ensure()).toBe('present');
    expect(await rows()).toEqual(before);
  });

  it('enforced: NEVER invents a row (no licence is fabricated) — absent stays absent, the foreign key still refuses a Company', async () => {
    expect(await service('enforced').ensure()).toBe('absent_enforced');
    expect(await rows()).toHaveLength(0);
    expect(await auditCount()).toBe(0);
    await expect(insertCompany('Acme')).rejects.toThrow(/companies_installationId_fkey/);
  });

  it('enforced with an existing row: reported present, untouched', async () => {
    await service('unlicensed-full').ensure();
    expect(await service('enforced').ensure()).toBe('present');
  });

  it('entitlement semantics are UNCHANGED: with or without the implicit row the application resolves the same implicit unlicensed DAII_STANDARD edition', async () => {
    const events = { publish: jest.fn(async () => undefined) };
    const make = (withBootstrap: boolean) =>
      new EntitlementService(ds.getRepository(Installation), ds, cfg('unlicensed-full'), audit, events as never, withBootstrap ? service('unlicensed-full') : undefined);
    const absent = make(false);
    await absent.reload(); // no row
    expect(await absent.isInstallationInitialized()).toBe(false);
    const withoutRow = absent.resolve();

    const boot = make(true);
    await boot.onModuleInit(); // ensure() then reload()
    expect(await boot.isInstallationInitialized()).toBe(true);
    const withRow = boot.resolve();

    expect(withRow.editionCode).toBe(withoutRow.editionCode);
    expect(withRow.verificationState).toBe('unlicensed');
    expect(withRow.status).toBe(withoutRow.status);
    expect([...withRow.modules].sort()).toEqual([...withoutRow.modules].sort());
    expect([...withRow.features].sort()).toEqual([...withoutRow.features].sort());
  });
});
