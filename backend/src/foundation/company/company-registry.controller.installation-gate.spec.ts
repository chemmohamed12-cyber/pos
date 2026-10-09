import { HttpStatus } from '@nestjs/common';
import { CompanyRegistryController } from './company-registry.controller';
import * as allocator from './company-database-allocator';
import { DaiiException } from '../error-contract/daii-exception';

/**
 * Post-incident review of release 1.1.4: creating a Company on a platform with no installation row failed with a raw foreign-key violation that reached the operator as
 * "An unexpected error occurred". The controller now refuses first, with the real reason, before anything is created.
 */
describe('CompanyRegistryController.create — installation gate', () => {
  function build(initialized: boolean) {
    const companyRegistry = { provision: jest.fn(async () => { throw new Error('STOP-AFTER-PROVISION'); }) };
    const databaseProvisioning = { provision: jest.fn() };
    const entitlement = { isInstallationInitialized: jest.fn(async () => initialized) };
    const controller = new CompanyRegistryController(
      companyRegistry as never, {} as never, {} as never, databaseProvisioning as never, { database: {}, companyDatabase: { mode: 'create', maintenanceDatabase: 'postgres', adminUser: null, adminPassword: null, pool: [] }, releaseExecution: {} } as never, entitlement as never,
    );
    return { controller, companyRegistry, databaseProvisioning, entitlement };
  }
  const dto = { name: 'Acme', initialAdminUserId: '00000000-0000-4000-8000-000000000001' } as never;

  it('platform not initialised => 409 INSTALLATION_NOT_INITIALIZED with an actionable message, and NOTHING is created (no company row, no database)', async () => {
    const { controller, companyRegistry, databaseProvisioning } = build(false);
    const err = await controller.create(dto).catch((e) => e);
    expect(err).toBeInstanceOf(DaiiException);
    expect(err.code).toBe('INSTALLATION_NOT_INITIALIZED');
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.message).toMatch(/unlicensed-full/);
    expect(err.message).toMatch(/entitlement\/apply/);
    expect(companyRegistry.provision).not.toHaveBeenCalled();
    expect(databaseProvisioning.provision).not.toHaveBeenCalled();
  });

  it('platform initialised => creation proceeds exactly as before (provision is reached with the singleton installation id)', async () => {
    const { controller, companyRegistry } = build(true);
    // the database-allocation step is covered against real Postgres in company-database-allocation.http.real-pg.spec.ts
    (controller as unknown as { databaseRegistry: unknown }).databaseRegistry = { usedDatabaseNames: async () => [] };
    jest.spyOn(allocator, 'allocateCompanyDatabase').mockResolvedValue({ databaseName: 'company_x', origin: 'created' });
    await expect(controller.create(dto)).rejects.toThrow('STOP-AFTER-PROVISION');
    expect(companyRegistry.provision).toHaveBeenCalledWith('installation', 'Acme');
  });
});
