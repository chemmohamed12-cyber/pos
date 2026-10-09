import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest');
import { CompanyRegistryController } from './company-registry.controller';
import { CompanyRegistryService } from './company-registry.service';
import { CompanyActivationService } from './company-activation.service';
import { CompanyService } from './company.service';
import { Company } from './company.entity';
import { MembershipService } from './membership.service';
import { Membership } from './membership.entity';
import { DatabaseRegistryService } from '../database-registry/database-registry.service';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';
import { DatabaseCredential } from '../database-registry/database-credential.entity';
import { DatabaseCredentialCipherService } from '../database-registry/database-credential-cipher.service';
import { DatabaseProvisioningService } from '../database-provisioning/database-provisioning.service';
import { AppConfigService } from '../configuration/app-config.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { UsersService } from '../identity/users.service';
import { User } from '../identity/user.entity';
import { JwtAuthGuard } from '../authentication/jwt-auth.guard';
import { PlatformGuard } from '../platform/platform.guard';
import * as roleSeeding from './company-role-seeding';
import * as membershipRole from './membership-role-provisioning';
import { ReleaseHealthCheckService } from '../release/release-health-check.service';
import * as migrationRunner from '../release-orchestration/company-migration-runner';

/**
 * Pool mode, FULL flow, nothing mocked below the HTTP layer: real control-plane database (migrated), real CompanyRegistry / DatabaseRegistry / DatabaseProvisioning
 * (full Company migrations, role seeding, initial admin, health check) on a pre-created pooled database, real allocator. Isolated PostgreSQL only.
 * Proves: the allocation is durable (derived from the registry table, so an application restart cannot hand a database out twice), failures leave no orphan
 * Company, and a failure AFTER allocation is resumable on the SAME database and SAME Company via POST :id/retry-provisioning.
 */
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 0;
const ADMIN = process.env.DB_USER ?? '';
const ADMIN_PW = process.env.DB_PASSWORD ?? '';
const describeIsolated = PORT && PORT !== 5433 && ADMIN ? describe : describe.skip;
const tag = randomUUID().slice(0, 6);
const CP = `daii_test_pool_cp_${tag}`;
const APP_ROLE = `daii_pool_app_${tag}`;
const APP_PW = 'pool-app-test-pw-1234567890';

describeIsolated('Company database pool — full provisioning flow over HTTP (real Postgres, isolated instance only)', () => {
  jest.setTimeout(600_000);
  const toDrop: string[] = [CP];
  let cp: DataSource;
  let adminUserId: string;
  const adminCfg = { type: 'postgres' as const, host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: 'postgres' };

  async function withAdmin<T>(fn: (ds: DataSource) => Promise<T>, database = 'postgres'): Promise<T> {
    const ds = new DataSource({ ...adminCfg, database });
    await ds.initialize();
    try {
      return await fn(ds);
    } finally {
      await ds.destroy();
    }
  }
  const mkPooled = async (name: string, owner = ADMIN) => {
    toDrop.push(name);
    await withAdmin((ds) => ds.query(`CREATE DATABASE "${name}" OWNER "${owner}"`));
  };
  const tablesIn = (name: string) => withAdmin(async (ds) => (await ds.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`))[0].n, name);

  /** A brand-new application instance over the SAME control-plane database — i.e. a restart. */
  async function bootApp(pool: string[], appUser = ADMIN, appPw = ADMIN_PW): Promise<INestApplication> {
    const companyRegistry = new CompanyRegistryService(new CompanyService(cp.getRepository(Company)));
    const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as unknown as AppConfigService);
    const databaseRegistry = new DatabaseRegistryService(cp.getRepository(DatabaseRegistry), cp.getRepository(DatabaseCredential), cipher);
    const provisioning = new DatabaseProvisioningService(companyRegistry, databaseRegistry, new MembershipService(cp.getRepository(Membership)), new UsersService(cp.getRepository(User)));
    const config = {
      database: { host: HOST, port: PORT, username: appUser, password: appPw, database: CP },
      companyDatabase: { mode: 'pool', maintenanceDatabase: 'postgres', adminUser: null, adminPassword: null, pool },
      releaseExecution: { appRoot: process.cwd() },
    };
    const module = await Test.createTestingModule({
      controllers: [CompanyRegistryController],
      providers: [
        { provide: CompanyRegistryService, useValue: companyRegistry },
        { provide: CompanyActivationService, useValue: {} },
        { provide: DatabaseRegistryService, useValue: databaseRegistry },
        { provide: DatabaseProvisioningService, useValue: provisioning },
        { provide: AppConfigService, useValue: config },
        { provide: EntitlementService, useValue: { isInstallationInitialized: async () => true } },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(PlatformGuard).useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    return app;
  }
  const body = (extra: Record<string, unknown> = {}) => ({ name: 'Acme', initialAdminUserId: adminUserId, tags: ['core'], roleModuleCodes: ['sales'], ...extra });
  const companiesCount = async () => (await cp.query(`SELECT count(*)::int n FROM companies`))[0].n;

  beforeAll(async () => {
    await withAdmin((ds) => ds.query(`CREATE DATABASE "${CP}"`));
    const { runMigrationsForDatabase } = await import('../release-orchestration/company-migration-runner');
    const migrated = await runMigrationsForDatabase(process.cwd(), { host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: CP }, ['core']);
    if (!migrated.success) throw new Error(`control-plane migration failed: ${migrated.error}`);
    cp = new DataSource({ type: 'postgres', host: HOST, port: PORT, username: ADMIN, password: ADMIN_PW, database: CP, entities: [Company, DatabaseRegistry, DatabaseCredential, Membership, User], synchronize: false });
    await cp.initialize();
    await cp.query(`INSERT INTO "installation" ("id","installationId","customerName","editionCode","editionVersion","entitlementManifest") VALUES ('installation','test-installation','Test','DAII_STANDARD','1.0.0','{}')`);
    adminUserId = (await new UsersService(cp.getRepository(User)).create({ fullName: 'Pool Admin', email: `pool-admin-${tag}@test.local` })).id;
  });
  afterAll(async () => {
    await cp?.destroy();
    await withAdmin(async (ds) => {
      for (const d of toDrop) await ds.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      await ds.query(`DROP ROLE IF EXISTS "${APP_ROLE}"`);
    });
  });

  it('full flow + restart durability + exhaustion + unknown admin leaves nothing behind', async () => {
    const p1 = `pool_f1_${tag}`, p2 = `pool_f2_${tag}`;
    await mkPooled(p1); await mkPooled(p2);

    const bad = await bootApp([p1, p2]);
    const rejected = await request(bad.getHttpServer()).post('/installation/companies').send(body({ initialAdminUserId: randomUUID() }));
    expect(rejected.status).toBe(400);
    expect(await companiesCount()).toBe(0); // no orphan Company
    expect((await cp.query(`SELECT count(*)::int n FROM database_registries`))[0].n).toBe(0); // no consumed allocation
    expect(await tablesIn(p1)).toBe(0); // the pooled database is untouched
    await bad.close();

    const app1 = await bootApp([p1, p2]);
    const first = await request(app1.getHttpServer()).post('/installation/companies').send(body());
    expect(first.status).toBe(201);
    expect(first.body.data.company.status).toBe('READY');
    expect((await cp.query(`SELECT "databaseName", status FROM database_registries`))[0]).toEqual({ databaseName: p1, status: 'ACTIVE' });
    expect(await tablesIn(p1)).toBeGreaterThan(50); // full Company migrations ran in the pooled database
    expect((await withAdmin((ds) => ds.query(`SELECT count(*)::int n FROM roles`), p1))[0].n).toBeGreaterThan(0); // role catalog seeded
    await app1.close();

    // RESTART: a fresh application instance must not hand p1 out again.
    const app2 = await bootApp([p1, p2]);
    const second = await request(app2.getHttpServer()).post('/installation/companies').send(body({ name: 'Second' }));
    expect(second.status).toBe(201);
    expect((await cp.query(`SELECT "databaseName" FROM database_registries ORDER BY "createdAt"`)).map((r: { databaseName: string }) => r.databaseName)).toEqual([p1, p2]);
    const third = await request(app2.getHttpServer()).post('/installation/companies').send(body({ name: 'Third' }));
    expect(third.status).toBe(422);
    expect(third.body.code).toBe('COMPANY_DATABASE_POOL_EXHAUSTED');
    expect(await companiesCount()).toBe(2);
    await app2.close();
  });

  it('a failure AFTER allocation is resumable on the SAME database and SAME Company (no duplicate, no second allocation)', async () => {
    await withAdmin((ds) => ds.query(`CREATE ROLE "${APP_ROLE}" LOGIN NOSUPERUSER NOCREATEDB PASSWORD '${APP_PW}'`));
    const p3 = `pool_f3_${tag}`, p4 = `pool_f4_${tag}`;
    await mkPooled(p3); await mkPooled(p4);
    await withAdmin((ds) => ds.query(`GRANT CONNECT ON DATABASE "${p3}" TO "${APP_ROLE}"`));
    await withAdmin((ds) => ds.query(`GRANT CONNECT ON DATABASE "${p4}" TO "${APP_ROLE}"`));
    const before = await companiesCount();

    // the application role may connect but cannot create anything => migrations fail AFTER the database was allocated
    const app = await bootApp([p3, p4], APP_ROLE, APP_PW);
    const failed = await request(app.getHttpServer()).post('/installation/companies').send(body({ name: 'Resumable' }));
    expect(failed.status).toBe(422);
    expect(failed.body.stage).toBe('migrations');
    const companyId: string = failed.body.companyId;
    expect(await companiesCount()).toBe(before + 1);
    expect((await cp.query(`SELECT status FROM database_registries WHERE "companyId"=$1`, [companyId]))[0].status).toBe('FAILED');

    // the operator fixes the cause (ownership of the pooled database), then resumes — same Company, same database
    await withAdmin((ds) => ds.query(`ALTER DATABASE "${p3}" OWNER TO "${APP_ROLE}"`));
    const resumed = await request(app.getHttpServer()).post(`/installation/companies/${companyId}/retry-provisioning`).send(body({ name: 'Resumable' }));
    expect(resumed.status).toBe(201);
    expect(resumed.body.data.company.id).toBe(companyId);
    expect(resumed.body.data.company.status).toBe('READY');
    expect(await companiesCount()).toBe(before + 1); // no duplicate Company
    const rows = await cp.query(`SELECT "databaseName", status FROM database_registries WHERE "companyId"=$1`, [companyId]);
    expect(rows).toEqual([{ databaseName: p3, status: 'ACTIVE' }]); // same database, no second allocation
    expect(await tablesIn(p4)).toBe(0); // the next pooled database was never touched

    // a READY Company is not retryable
    const again = await request(app.getHttpServer()).post(`/installation/companies/${companyId}/retry-provisioning`).send(body());
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('COMPANY_NOT_RETRYABLE');
    await app.close();
  });

  // Every provisioning stage, failed on purpose AFTER the database was allocated, then resumed: same Company, same database, no duplicate, no second allocation.
  const stages: Array<{ stage: string; inject: () => jest.SpyInstance }> = [
    { stage: 'migrations', inject: () => jest.spyOn(migrationRunner, 'runMigrationsForDatabase').mockResolvedValueOnce({ success: false, error: 'injected migration fault', ranMigrationNames: [] } as never) },
    { stage: 'role-seeding', inject: () => jest.spyOn(roleSeeding, 'seedCompanyRoleTemplates').mockRejectedValueOnce(new Error('injected role-seeding fault')) },
    { stage: 'initial-admin', inject: () => jest.spyOn(membershipRole, 'provisionUserRoleForMembership').mockRejectedValueOnce(new Error('injected initial-admin fault')) },
    { stage: 'health-check', inject: () => jest.spyOn(ReleaseHealthCheckService.prototype, 'check').mockResolvedValueOnce({ ok: false, detail: { injected: true } } as never) },
    { stage: 'health-check', inject: () => jest.spyOn(ReleaseHealthCheckService.prototype, 'check').mockRejectedValueOnce(new Error('injected health-check crash')) },
  ];
  it.each(stages.map((s, i) => [`${s.stage} (case ${i + 1})`, s.stage, s.inject] as const))(
    'fault injected at stage %s: FAILED + resumable on the SAME Company and database',
    async (_label, stage, inject) => {
      const db = `pool_s_${randomUUID().slice(0, 8)}`, spare = `pool_x_${randomUUID().slice(0, 8)}`;
      await mkPooled(db); await mkPooled(spare);
      const before = await companiesCount();
      const app = await bootApp([db, spare]);
      const spy = inject();
      const failed = await request(app.getHttpServer()).post('/installation/companies').send(body({ name: `Stage-${stage}` }));
      spy.mockRestore();
      expect(failed.status).toBe(422);
      expect(failed.body.stage).toBe(stage);
      const companyId: string = failed.body.companyId;
      expect(await companiesCount()).toBe(before + 1);
      expect((await cp.query(`SELECT status FROM database_registries WHERE "companyId"=$1`, [companyId]))[0].status).toBe('FAILED');

      const resumed = await request(app.getHttpServer()).post(`/installation/companies/${companyId}/retry-provisioning`).send(body());
      expect(resumed.status).toBe(201);
      expect(resumed.body.data.company.id).toBe(companyId);
      expect(resumed.body.data.company.status).toBe('READY');
      expect(await companiesCount()).toBe(before + 1);
      expect(await cp.query(`SELECT "databaseName", status FROM database_registries WHERE "companyId"=$1`, [companyId])).toEqual([{ databaseName: db, status: 'ACTIVE' }]);
      expect(await tablesIn(spare)).toBe(0); // no second allocation
      await app.close();
    },
  );
});
