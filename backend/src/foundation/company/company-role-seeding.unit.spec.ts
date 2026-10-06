/**
 * Supplementary, mocked unit coverage — proves `seedCompanyRoleTemplates`
 * constructs a narrow, purpose-built DataSource and delegates to the
 * EXISTING, unmodified `ModuleRoleTemplateSeeder` correctly. Real-Postgres
 * proof (does this actually seed `roles`/`role_permissions` in a genuine
 * Company database) is bundled with the same CREATEDB-blocked pending
 * item recorded for Area 4/16 — see the Build Sequencing Plan.
 */
const dsInitializeMock = jest.fn(async () => undefined);
const dsDestroyMock = jest.fn(async () => undefined);
const getRepositoryMock = jest.fn((entity: unknown) => ({ __entity: entity }));
let dsIsInitialized = false;

jest.mock('typeorm', () => ({
  ...jest.requireActual('typeorm'),
  DataSource: jest.fn().mockImplementation(() => ({
    initialize: async () => {
      dsIsInitialized = true;
      await dsInitializeMock();
    },
    destroy: async () => {
      dsIsInitialized = false;
      await dsDestroyMock();
    },
    get isInitialized() {
      return dsIsInitialized;
    },
    getRepository: getRepositoryMock,
  })),
}));

const seedForModuleMock = jest.fn(async (code: string) => (code === 'sales' ? { roles: 2, grants: 3 } : { roles: 1, grants: 1 }));
jest.mock('../module-role-templates/module-role-template.seeder', () => ({
  ModuleRoleTemplateSeeder: jest.fn().mockImplementation(() => ({ seedForModule: seedForModuleMock })),
}));

import { seedCompanyRoleTemplates } from './company-role-seeding';
import { ModuleRoleTemplateSeeder } from '../module-role-templates/module-role-template.seeder';

describe('seedCompanyRoleTemplates — mocked (supplementary to the real-Postgres proof)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dsIsInitialized = false;
  });

  it('seeds every requested module code and aggregates the totals', async () => {
    const result = await seedCompanyRoleTemplates({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales', 'hr']);
    expect(result).toEqual({ roles: 3, grants: 4 });
    expect(seedForModuleMock).toHaveBeenCalledWith('sales');
    expect(seedForModuleMock).toHaveBeenCalledWith('hr');
    expect(dsDestroyMock).toHaveBeenCalledTimes(1);
  });

  it('seeds nothing and destroys cleanly when no module codes are given', async () => {
    const result = await seedCompanyRoleTemplates({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, []);
    expect(result).toEqual({ roles: 0, grants: 0 });
    expect(seedForModuleMock).not.toHaveBeenCalled();
  });

  it('reuses ModuleRoleTemplateSeeder unmodified, constructed against the Company-scoped repositories', async () => {
    await seedCompanyRoleTemplates({ host: 'h', port: 1, username: 'u', password: 'p', database: 'd' }, ['sales']);
    expect(ModuleRoleTemplateSeeder).toHaveBeenCalledTimes(1);
    expect(getRepositoryMock).toHaveBeenCalledTimes(2); // Role, RolePermission
  });
});
