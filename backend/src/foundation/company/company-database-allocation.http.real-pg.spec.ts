import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest');
import { DataSource } from 'typeorm';
import { CompanyRegistryController } from './company-registry.controller';
import { CompanyRegistryService } from './company-registry.service';
import { CompanyActivationService } from './company-activation.service';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseProvisioningService } from '../database-provisioning/database-provisioning.service';
import { AppConfigService } from '../configuration/app-config.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PlatformGuard } from '../platform/platform.guard';
import { CompanyDatabaseConfig } from './company-database-allocator';

/**
 * Production (release 1.1.5): `POST /api/installation/companies` answered 500 because the application role could not open the maintenance database `postgres`
 * (`no pg_hba.conf entry`). This drives the REAL HTTP route and the REAL allocator against a REAL PostgreSQL (isolated instance only) in both modes:
 * `create` (maintenance database / admin role) and `pool` (databases pre-created through the hosting provider).
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const ADMIN = process.env.DB_USER ?? '';
const ADMIN_PW = process.env.DB_PASSWORD ?? '';
const describeIsolated = PORT && PORT !== 5433 && ADMIN ? describe : describe.skip;
const tag = randomUUID().slice(0, 6);
const ROLE_PW = 'nocreatedb-test-pw-1234567890';

describeIsolated('POST /installation/companies — Company database allocation (real Postgres, isolated instance only)', () => {
  jest.setTimeout(120_000);
  const toDrop: string[] = [];
  const roles: string[] = [];
  const adminCfg = { type: 'postgres' as const, host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: 'postgres' };

  async function withAdmin<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
    const ds = new DataSource(adminCfg);
    await ds.initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  }
  const exists = (name: string) => withAdmin(async (ds) => (await ds.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).length === 1);
  const mkDb = async (name: string, withTable = false) => {
    toDrop.push(name);
    await withAdmin((ds) => ds.query(`CREATE DATABASE "${name}"`));
    if (withTable) {
      const ds = new DataSource({ ...adminCfg, database: name });
      await ds.initialize();
      await ds.query('CREATE TABLE leftover (id int)');
      await ds.destroy();
    }
  };

  async function boot(cfg: CompanyDatabaseConfig, appUser = ADMIN, appPw = ADMIN_PW) {
    const used: string[] = [];
    const companies: Array<{ id: string; name: string }> = [];
    const provisioned: string[] = [];
    const companyRegistry = {
      provision: jest.fn(async (_i: string, name: string) => { const c = { id: randomUUID(), name, status: 'PROVISIONING' }; companies.push(c); return c; }),
      findById: jest.fn(async (id: string) => ({ ...companies.find((c) => c.id === id)!, status: 'READY' })),
    };
    const databaseProvisioning = {
      provision: jest.fn(async (p: { databaseName: string }) => { used.push(p.databaseName); provisioned.push(p.databaseName); return { migratedNames: [], roleSeedResult: {}, entitlementApplied: false, initialAdmin: { id: 'm1' } }; }),
    };
    const databaseRegistry = { usedDatabaseNames: jest.fn(async () => [...used]), findByCompanyId: jest.fn(async () => ({ status: 'ACTIVE' })) };
    const config = { database: { host: HOST, port: PORT, username: appUser, password: appPw, database: 'x' }, companyDatabase: cfg, releaseExecution: { appRoot: process.cwd() } };
    const module = await Test.createTestingModule({
      controllers: [CompanyRegistryController],
      providers: [
        { provide: CompanyRegistryService, useValue: companyRegistry },
        { provide: CompanyActivationService, useValue: {} },
        { provide: DatabaseRegistryService, useValue: databaseRegistry },
        { provide: DatabaseProvisioningService, useValue: databaseProvisioning },
        { provide: AppConfigService, useValue: config },
        { provide: EntitlementService, useValue: { isInstallationInitialized: async () => true } },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(PlatformGuard).useValue({ canActivate: () => true })
      .compile();
    const app: INestApplication = module.createNestApplication();
    await app.init();
    return { app, companies, provisioned, companyRegistry, used };
  }
  const post = (app: INestApplication, name = 'Acme') => request(app.getHttpServer()).post('/installation/companies').send({ name, initialAdminUserId: '00000000-0000-4000-8000-000000000001' });
  const poolCfg = (pool: string[]): CompanyDatabaseConfig => ({ mode: 'pool', maintenanceDatabase: 'postgres', adminUser: null, adminPassword: null, pool });

  afterAll(async () => {
    await withAdmin(async (ds) => {
      for (const d of toDrop) await ds.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      for (const r of roles) await ds.query(`DROP ROLE IF EXISTS "${r}"`);
    });
  });

  it('POOL: creates a Company on a pre-created empty database; the next Company takes the next one; nothing is created twice', async () => {
    const a = `pool_a_${tag}`, b = `pool_b_${tag}`;
    await mkDb(a); await mkDb(b);
    const { app, provisioned, companies } = await boot(poolCfg([a, b]));
    expect((await post(app, 'One')).status).toBe(201);
    expect((await post(app, 'Two')).status).toBe(201);
    expect(provisioned).toEqual([a, b]);
    expect(companies).toHaveLength(2);
    expect((await post(app, 'Three')).status).toBe(422); // exhausted
    expect(companies).toHaveLength(2);
    await app.close();
  });

  it('POOL: a non-empty or unreachable database is never used; exhaustion => 422 COMPANY_DATABASE_POOL_EXHAUSTED naming each reason, and NO Company row is created', async () => {
    const dirty = `pool_dirty_${tag}`;
    await mkDb(dirty, true);
    const { app, companies } = await boot(poolCfg([dirty, `pool_missing_${tag}`]));
    const res = await post(app);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMPANY_DATABASE_POOL_EXHAUSTED');
    expect(res.body.detail).toMatch(/not empty/);
    expect(res.body.detail).toMatch(/not reachable/);
    expect(res.body.detail).not.toContain(ADMIN_PW);
    expect(companies).toHaveLength(0);
    await app.close();
  });

  it('POOL: retry after the operator adds a database succeeds with no duplicate Company and no orphan', async () => {
    const first = `pool_r1_${tag}`;
    await mkDb(first);
    const empty = await boot(poolCfg([]));
    expect((await post(empty.app)).status).toBe(422);
    expect(empty.companies).toHaveLength(0);
    await empty.app.close();
    const ok = await boot(poolCfg([first]));
    expect((await post(ok.app)).status).toBe(201);
    expect(ok.companies).toHaveLength(1);
    await ok.app.close();
  });

  it('POOL: two simultaneous requests with ONE database => exactly one Company, the other is refused', async () => {
    const only = `pool_one_${tag}`;
    await mkDb(only);
    const { app, companies } = await boot(poolCfg([only]));
    const [r1, r2] = await Promise.all([post(app, 'X'), post(app, 'Y')]);
    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    expect(companies).toHaveLength(1);
    await app.close();
  });

  it('CREATE: maintenance database unreachable (the production message) => 422 COMPANY_DATABASE_CREATION_FAILED and nothing is created', async () => {
    const { app, companies } = await boot({ mode: 'create', maintenanceDatabase: `no_such_maintenance_${tag}`, adminUser: null, adminPassword: null, pool: [] });
    const res = await post(app);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMPANY_DATABASE_CREATION_FAILED');
    expect(res.body.message).toMatch(/COMPANY_DB_MODE=pool/);
    expect(companies).toHaveLength(0);
    await app.close();
  });

  it('CREATE: application role lacks CREATEDB but a dedicated admin role is configured => the database is created with the admin role and the Company is created', async () => {
    const role = `daii_nocreate_${tag}`;
    roles.push(role);
    await withAdmin((ds) => ds.query(`CREATE ROLE "${role}" LOGIN NOCREATEDB PASSWORD '${ROLE_PW}'`));
    const without = await boot({ mode: 'create', maintenanceDatabase: 'postgres', adminUser: null, adminPassword: null, pool: [] }, role, ROLE_PW);
    const refused = await post(without.app);
    expect(refused.status).toBe(422);
    expect(refused.body.detail).toMatch(/permission denied to create database/i);
    expect(without.companies).toHaveLength(0);
    await without.app.close();

    const withAdminRole = await boot({ mode: 'create', maintenanceDatabase: 'postgres', adminUser: ADMIN, adminPassword: ADMIN_PW, pool: [] }, role, ROLE_PW);
    const ok = await post(withAdminRole.app);
    expect(ok.status).toBe(201);
    toDrop.push(withAdminRole.provisioned[0]);
    expect(await exists(withAdminRole.provisioned[0])).toBe(true);
    expect(withAdminRole.companies).toHaveLength(1);
    await withAdminRole.app.close();
  });
});
