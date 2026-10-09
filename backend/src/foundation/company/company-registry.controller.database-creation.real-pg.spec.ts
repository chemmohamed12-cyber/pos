import { randomUUID } from 'crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CompanyRegistryController } from './company-registry.controller';

/**
 * Post-incident review (production, release 1.1.5): creating a Company still answered "An unexpected error occurred" after the installation row existed. The step after
 * the gate — `CREATE DATABASE` for the Company — ran raw, AFTER the Company row had been inserted. On a shared PostgreSQL host the application's database user usually
 * lacks CREATEDB, so every attempt failed with a generic 500 and left an orphan `PROVISIONING` Company (that status has no edge to FAILED).
 * Real Postgres on the isolated instance: a role WITHOUT CREATEDB reproduces it; the fix is a clear 422 and NOTHING created.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const ADMIN = process.env.DB_USER ?? '';
const ADMIN_PW = process.env.DB_PASSWORD ?? '';
const ROLE = `daii_test_nocreatedb_${randomUUID().slice(0, 6)}`;
const ROLE_PW = 'nocreatedb-test-pw-1234567890';
const describeIsolated = PORT && PORT !== 5433 && ADMIN ? describe : describe.skip;

describeIsolated('CompanyRegistryController.create — physical database creation (real Postgres, isolated instance only)', () => {
  jest.setTimeout(120_000);
  const adminCfg = { type: 'postgres' as const, host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: 'postgres' };
  const createdDatabases: string[] = [];

  async function withAdmin<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
    const ds = new DataSource(adminCfg);
    await ds.initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  }

  const build = (username: string, password: string) => {
    const companyRegistry = { provision: jest.fn(async () => ({ id: 'company-1', name: 'Acme', status: 'PROVISIONING' })), findById: jest.fn(async () => ({ id: 'company-1', status: 'PROVISIONING', name: 'Acme' })) };
    const databaseProvisioning = { provision: jest.fn(async (_p: { databaseName: string }) => { throw new Error('STOP-AFTER-PROVISIONING'); }), assertInitialAdminExists: jest.fn(async () => undefined) };
    const databaseRegistry = { findByCompanyId: jest.fn(async () => null) };
    const entitlement = { isInstallationInitialized: jest.fn(async () => true) };
    const controller = new CompanyRegistryController(
      companyRegistry as never, {} as never, databaseRegistry as never, databaseProvisioning as never,
      { database: { host: HOST, port: PORT, username, password, database: 'x' }, companyDatabase: { mode: 'create', maintenanceDatabase: 'postgres', adminUser: null, adminPassword: null, pool: [] }, releaseExecution: { appRoot: process.cwd() } } as never, entitlement as never,
    );
    return { controller, companyRegistry, databaseProvisioning };
  };
  const dto = { name: 'Acme', initialAdminUserId: '00000000-0000-4000-8000-000000000001' } as never;

  beforeAll(async () => {
    await withAdmin((ds) => ds.query(`CREATE ROLE "${ROLE}" LOGIN NOCREATEDB NOSUPERUSER PASSWORD '${ROLE_PW}'`));
  });
  afterAll(async () => {
    await withAdmin(async (ds) => {
      for (const d of createdDatabases) await ds.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      await ds.query(`DROP ROLE IF EXISTS "${ROLE}"`);
    });
  });

  it('a database user WITHOUT CREATEDB (the shared-host situation) => 422 COMPANY_DATABASE_CREATION_FAILED naming the real reason, and NO Company row is created', async () => {
    const { controller, companyRegistry, databaseProvisioning } = build(ROLE, ROLE_PW);
    const err = await controller.create(dto).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    const body = err.getResponse() as { code: string; stage: string; detail: string; message: string };
    expect(body.code).toBe('COMPANY_DATABASE_CREATION_FAILED');
    expect(body.stage).toBe('create-database');
    expect(body.detail).toMatch(/permission denied to create database/i);
    expect(body.message).toContain('nothing was created');
    expect(companyRegistry.provision).not.toHaveBeenCalled(); // no orphan PROVISIONING Company
    expect(databaseProvisioning.provision).not.toHaveBeenCalled();
  });

  it('a user that CAN create databases: the database is created FIRST, and only then the Company row, then provisioning (order proven)', async () => {
    const { controller, companyRegistry, databaseProvisioning } = build(ADMIN, ADMIN_PW);
    const order: string[] = [];
    companyRegistry.provision.mockImplementation(async () => { order.push('company-row'); return { id: 'company-1', name: 'Acme', status: 'PROVISIONING' }; });
    databaseProvisioning.provision.mockImplementation(async (p: { databaseName: string }) => { order.push('provisioning'); createdDatabases.push(p.databaseName); throw new Error('STOP-AFTER-PROVISIONING'); });
    const exists = (name: string) => withAdmin(async (ds) => (await ds.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).length === 1);
    let dbExistedAtProvisioning = false;
    databaseProvisioning.provision.mockImplementation(async (p: { databaseName: string }) => {
      order.push('provisioning');
      createdDatabases.push(p.databaseName);
      dbExistedAtProvisioning = await exists(p.databaseName);
      throw new Error('STOP-AFTER-PROVISIONING');
    });
    await expect(controller.create(dto)).rejects.toThrow('STOP-AFTER-PROVISIONING');
    expect(order).toEqual(['company-row', 'provisioning']);
    expect(dbExistedAtProvisioning).toBe(true); // the physical database already existed when provisioning started
  });
});
