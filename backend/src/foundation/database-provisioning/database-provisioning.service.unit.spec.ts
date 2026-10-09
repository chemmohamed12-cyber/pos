/**
 * Supplementary, mocked unit coverage — proves the sequencing/branch
 * logic of `DatabaseProvisioningService.provision()` (registration vs.
 * retry, failure states, ordering) without a live Postgres connection.
 * Does NOT substitute for `database-provisioning.service.spec.ts`'s
 * real-disposable-database, end-to-end proof (V7 Area 4's literal
 * Verification requirement) — that file is currently skipped pending a
 * CREATEDB-capable Postgres environment; see its own header comment.
 */
const runMigrationsForDatabaseMock = jest.fn();
jest.mock('../release-orchestration/company-migration-runner', () => ({
  runMigrationsForDatabase: (...args: unknown[]) => runMigrationsForDatabaseMock(...args),
}));

const seedCompanyRoleTemplatesMock = jest.fn();
const seedCompanyAdminRoleMock = jest.fn();
const seedCompanyAdministratorRoleMock = jest.fn();
jest.mock('../company/company-role-seeding', () => ({
  seedCompanyRoleTemplates: (...args: unknown[]) => seedCompanyRoleTemplatesMock(...args),
  seedCompanyAdminRole: (...args: unknown[]) => seedCompanyAdminRoleMock(...args),
  seedCompanyAdministratorRole: (...args: unknown[]) => seedCompanyAdministratorRoleMock(...args),
}));

const provisionUserRoleForMembershipMock = jest.fn();
jest.mock('../company/membership-role-provisioning', () => ({
  provisionUserRoleForMembership: (...args: unknown[]) => provisionUserRoleForMembershipMock(...args),
}));

const applyEntitlementManifestToCompanyMock = jest.fn();
jest.mock('../company/company-entitlement-provisioning', () => ({
  applyEntitlementManifestToCompany: (...args: unknown[]) => applyEntitlementManifestToCompanyMock(...args),
}));

const healthCheckMock = jest.fn(async () => ({ ok: true, components: {}, detail: {} }));
jest.mock('../release/release-health-check.service', () => ({
  ReleaseHealthCheckService: jest.fn().mockImplementation(() => ({ check: healthCheckMock })),
}));

const dsInitializeMock = jest.fn(async () => undefined);
const dsDestroyMock = jest.fn(async () => undefined);
// ADR-073 (2026-09-25, Option D) — `applyCompanyAuthorizationSchemaAdjustment` opens its own
// ephemeral DataSource and calls `.query()` on it (the Company-only `DROP CONSTRAINT IF EXISTS`);
// this shared fake DataSource needs a `.query` too, or that new provisioning step throws.
// The adjustment also reads the catalog for FK constraints that reference users(id) (Area 21 extension) — an empty list is the neutral answer.
const dsQueryMock = jest.fn(async (sql?: string) => (typeof sql === 'string' && sql.includes('pg_constraint') ? [] : undefined));
jest.mock('typeorm', () => ({
  ...jest.requireActual('typeorm'),
  DataSource: jest.fn().mockImplementation(() => ({ initialize: dsInitializeMock, destroy: dsDestroyMock, query: dsQueryMock })),
}));

import { NotFoundException } from '@nestjs/common';
import { DatabaseProvisioningService, ProvisioningFailedError } from './database-provisioning.service';
import { Company } from '../company/company.entity';
import { DatabaseRegistry } from '../database-registry/database-registry.entity';

describe('DatabaseProvisioningService — mocked sequencing logic (supplementary to the real-Postgres test)', () => {
  const company = { id: 'company-1', installationId: 'installation', name: 'Acme', status: 'PROVISIONING', createdAt: new Date() } as Company;
  let registry: DatabaseRegistry;

  const companyRegistryMock = {
    findById: jest.fn(async (): Promise<Company | null> => company),
    transitionTo: jest.fn(async () => ({ ...company, status: 'READY' })),
  };
  const databaseRegistryMock = {
    findByCompanyId: jest.fn(async () => null as DatabaseRegistry | null),
    register: jest.fn(async () => registry),
    updateConnection: jest.fn(async () => registry),
    markStatus: jest.fn(async (id: string, status: string) => ({ ...registry, status })),
  };

  let service: DatabaseProvisioningService;
  const membershipsMock = { findByUserAndCompany: jest.fn(), create: jest.fn() };
  const usersMock = { findById: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    registry = { id: 'registry-1', companyId: 'company-1', host: 'h', port: 1, databaseName: 'd', status: 'PROVISIONING', createdAt: new Date() };
    databaseRegistryMock.findByCompanyId = jest.fn(async () => null);
    databaseRegistryMock.register = jest.fn(async () => registry);
    databaseRegistryMock.updateConnection = jest.fn(async () => registry);
    databaseRegistryMock.markStatus = jest.fn(async (_id: string, status: string) => ({ ...registry, status }));
    companyRegistryMock.findById = jest.fn(async () => company);
    companyRegistryMock.transitionTo = jest.fn(async () => ({ ...company, status: 'READY' }));
    runMigrationsForDatabaseMock.mockResolvedValue({ success: true, ranMigrationNames: ['M1'], error: null });
    seedCompanyRoleTemplatesMock.mockResolvedValue({ roles: 2, grants: 3 });
    seedCompanyAdminRoleMock.mockResolvedValue({ created: true, grants: 2 });
    seedCompanyAdministratorRoleMock.mockResolvedValue({ created: true, grants: 5 });
    applyEntitlementManifestToCompanyMock.mockResolvedValue(undefined);
    provisionUserRoleForMembershipMock.mockResolvedValue(undefined);
    healthCheckMock.mockResolvedValue({ ok: true, components: {}, detail: {} });
    usersMock.findById.mockResolvedValue({ id: 'admin-user-1', email: 'admin@x.com', status: 'active' });
    membershipsMock.findByUserAndCompany.mockResolvedValue(null);
    membershipsMock.create.mockImplementation(async (data: { userId: string; companyId: string; roleKey: string }) => ({ id: 'membership-1', ...data, createdAt: new Date() }));
    service = new DatabaseProvisioningService(companyRegistryMock as never, databaseRegistryMock as never, membershipsMock as never, usersMock as never);
  });

  const params = {
    companyId: 'company-1',
    host: 'h',
    port: 1,
    databaseName: 'd',
    username: 'u',
    password: 'p',
    appRoot: '/fake',
    tags: ['core'],
    roleModuleCodes: ['sales'],
    initialAdminUserId: 'admin-user-1',
  };

  it('happy path: registers a fresh database, runs migrations, seeds role templates, grants the initial admin, marks ACTIVE then READY, in order', async () => {
    const callOrder: string[] = [];
    runMigrationsForDatabaseMock.mockImplementation(async () => {
      callOrder.push('migrations');
      return { success: true, ranMigrationNames: ['M1'], error: null };
    });
    seedCompanyRoleTemplatesMock.mockImplementation(async () => {
      callOrder.push('role-seeding');
      return { roles: 2, grants: 3 };
    });
    provisionUserRoleForMembershipMock.mockImplementation(async () => {
      callOrder.push('initial-admin');
    });
    healthCheckMock.mockImplementation(async () => {
      callOrder.push('health-check');
      return { ok: true, components: {}, detail: {} };
    });

    const result = await service.provision(params);

    expect(databaseRegistryMock.register).toHaveBeenCalledTimes(1);
    expect(databaseRegistryMock.updateConnection).not.toHaveBeenCalled();
    expect(runMigrationsForDatabaseMock).toHaveBeenCalledWith('/fake', { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['core']);
    expect(seedCompanyRoleTemplatesMock).toHaveBeenCalledWith({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales']);
    // CTO Decision 3 (2026-10-07): the DEFAULT administrator of a new Company is `company_admin` — the legacy `admin` role is never seeded for it nor granted
    expect(seedCompanyAdministratorRoleMock).toHaveBeenCalledWith({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' });
    expect(seedCompanyAdminRoleMock).not.toHaveBeenCalled();
    expect(provisionUserRoleForMembershipMock).toHaveBeenCalledWith(expect.anything(), 'admin-user-1', 'company_admin');
    expect(callOrder).toEqual(['migrations', 'role-seeding', 'initial-admin', 'health-check']);
    expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'ACTIVE');
    expect(companyRegistryMock.transitionTo).toHaveBeenCalledWith('company-1', 'READY');
    expect(result.readyMarked).toBe(true);
    expect(result.migratedNames).toEqual(['M1']);
    expect(result.roleSeedResult).toEqual({ roles: 2, grants: 3 });
    expect(result.initialAdmin).toMatchObject({ userId: 'admin-user-1', companyId: 'company-1', roleKey: 'company_admin' });
  });

  it('CTO Decisions 2/3: the legacy `admin` administrator is an EXPLICIT opt-in only — it seeds the legacy role (with the module codes) and never company_admin', async () => {
    const result = await service.provision({ ...params, administratorRole: 'admin' });

    expect(seedCompanyAdminRoleMock).toHaveBeenCalledWith({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales']);
    expect(seedCompanyAdministratorRoleMock).not.toHaveBeenCalled();
    expect(provisionUserRoleForMembershipMock).toHaveBeenCalledWith(expect.anything(), 'admin-user-1', 'admin');
    expect(result.initialAdmin).toMatchObject({ userId: 'admin-user-1', companyId: 'company-1', roleKey: 'admin' });
  });

  describe('Area 20: initial admin (2026-09-24, D1/D3/D7 decisions)', () => {
    it('D1: verifies the User exists BEFORE granting anything — a nonexistent user fails the whole attempt with stage "initial-admin"', async () => {
      usersMock.findById.mockRejectedValue(new NotFoundException('no such user'));

      await expect(service.provision(params)).rejects.toMatchObject({ stage: 'initial-admin' } as Partial<ProvisioningFailedError>);
      expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'FAILED');
      expect(companyRegistryMock.transitionTo).not.toHaveBeenCalled();
      expect(membershipsMock.create).not.toHaveBeenCalled();
      expect(healthCheckMock).not.toHaveBeenCalled();
    });

    it('is retry-safe: reuses an existing Membership row instead of erroring on a repeat attempt', async () => {
      membershipsMock.findByUserAndCompany.mockResolvedValue({ id: 'membership-1', userId: 'admin-user-1', companyId: 'company-1', roleKey: 'company_admin' });

      const result = await service.provision(params);

      expect(membershipsMock.create).not.toHaveBeenCalled();
      expect(result.initialAdmin).toMatchObject({ id: 'membership-1', userId: 'admin-user-1', roleKey: 'company_admin' });
    });

    it('Company-DB grant failure marks FAILED, never transitions the Company to READY, throws with stage "initial-admin"', async () => {
      provisionUserRoleForMembershipMock.mockRejectedValue(new Error('role not seeded'));

      await expect(service.provision(params)).rejects.toMatchObject({ stage: 'initial-admin' } as Partial<ProvisioningFailedError>);
      expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'FAILED');
      expect(companyRegistryMock.transitionTo).not.toHaveBeenCalled();
      expect(healthCheckMock).not.toHaveBeenCalled();
    });
  });

  it('defaults roleModuleCodes to empty (does not guess entitlement) when not supplied', async () => {
    const { roleModuleCodes: _omit, ...paramsWithoutRoleModules } = params;
    await service.provision(paramsWithoutRoleModules);
    expect(seedCompanyRoleTemplatesMock).toHaveBeenCalledWith(expect.anything(), []);
  });

  it('role-seeding failure: marks FAILED, never transitions the Company to READY, throws with stage "role-seeding"', async () => {
    seedCompanyRoleTemplatesMock.mockRejectedValue(new Error('role seeding blew up'));

    await expect(service.provision(params)).rejects.toMatchObject({ stage: 'role-seeding' } as Partial<ProvisioningFailedError>);
    expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'FAILED');
    expect(companyRegistryMock.transitionTo).not.toHaveBeenCalled();
    expect(healthCheckMock).not.toHaveBeenCalled();
  });

  it('retry path: an existing registry is updated in place, never re-registered', async () => {
    databaseRegistryMock.findByCompanyId = jest.fn(async () => registry);
    await service.provision(params);
    expect(databaseRegistryMock.register).not.toHaveBeenCalled();
    expect(databaseRegistryMock.updateConnection).toHaveBeenCalledWith('registry-1', { host: 'h', port: 1, databaseName: 'd' });
  });

  it('migration failure: marks FAILED, never transitions the Company to READY, throws with stage "migrations"', async () => {
    runMigrationsForDatabaseMock.mockResolvedValue({ success: false, ranMigrationNames: [], error: 'connection refused' });

    await expect(service.provision(params)).rejects.toMatchObject({ stage: 'migrations' } as Partial<ProvisioningFailedError>);
    expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'FAILED');
    expect(companyRegistryMock.transitionTo).not.toHaveBeenCalled();
  });

  it('health-check failure: marks FAILED, never transitions the Company to READY, throws with stage "health-check"', async () => {
    healthCheckMock.mockResolvedValue({ ok: false, components: { 'database.connectivity': false }, detail: { 'database.connectivity': 'timeout' } });

    await expect(service.provision(params)).rejects.toMatchObject({ stage: 'health-check' } as Partial<ProvisioningFailedError>);
    expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'FAILED');
    expect(companyRegistryMock.transitionTo).not.toHaveBeenCalled();
  });

  it('throws plainly if the Company itself does not exist — never reaches the registry', async () => {
    companyRegistryMock.findById = jest.fn(async () => null);
    await expect(service.provision(params)).rejects.toThrow('Company not found');
    expect(databaseRegistryMock.register).not.toHaveBeenCalled();
  });

  it('Area 7: skips entitlement application entirely when no manifest is supplied — does not guess a default edition', async () => {
    const result = await service.provision(params);
    expect(applyEntitlementManifestToCompanyMock).not.toHaveBeenCalled();
    expect(result.entitlementApplied).toBe(false);
  });

  it('Area 7: applies the supplied manifest when all three entitlement fields are given', async () => {
    const manifest = { edition_code: 'DAII_STANDARD' } as never;
    const entitlementParams = { ...params, entitlementManifest: manifest, entitlementSignature: 'sig', entitlementOptions: { publicKeys: [], clockToleranceMinutes: 5 } };
    const result = await service.provision(entitlementParams);
    expect(applyEntitlementManifestToCompanyMock).toHaveBeenCalledWith({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, manifest, 'sig', entitlementParams.entitlementOptions);
    expect(result.entitlementApplied).toBe(true);
  });

  it('Area 7: entitlement rejection marks FAILED, never transitions the Company to READY, throws with stage "entitlement"', async () => {
    applyEntitlementManifestToCompanyMock.mockRejectedValue(new Error('manifest rejected'));
    const manifest = { edition_code: 'DAII_STANDARD' } as never;
    const entitlementParams = { ...params, entitlementManifest: manifest, entitlementSignature: 'sig', entitlementOptions: { publicKeys: [], clockToleranceMinutes: 5 } };

    await expect(service.provision(entitlementParams)).rejects.toMatchObject({ stage: 'entitlement' } as Partial<ProvisioningFailedError>);
    expect(databaseRegistryMock.markStatus).toHaveBeenCalledWith('registry-1', 'FAILED');
    expect(companyRegistryMock.transitionTo).not.toHaveBeenCalled();
    expect(healthCheckMock).not.toHaveBeenCalled();
  });
});
