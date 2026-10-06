import {
  CompanyConnectionManagerService,
  CompanyDatabaseNotActiveError,
  CompanyDatabaseNotProvisionedError,
} from './company-connection-manager.service';
import { DatabaseRegistryService } from './database-registry.service';
import { DatabaseRegistry } from './database-registry.entity';

const fakeDataSource = (overrides: Partial<{ isInitialized: boolean }> = {}) => ({
  isInitialized: overrides.isInitialized ?? true,
  initialize: jest.fn(async function (this: { isInitialized: boolean }) {
    this.isInitialized = true;
  }),
  destroy: jest.fn(async function (this: { isInitialized: boolean }) {
    this.isInitialized = false;
  }),
});

jest.mock('./company-datasource-factory', () => ({
  createCompanyDataSource: jest.fn(() => fakeDataSource()),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCompanyDataSource } = jest.requireMock('./company-datasource-factory') as {
  createCompanyDataSource: jest.Mock;
};

describe('CompanyConnectionManagerService — Multi-Company Area 9 (Background Jobs Gap Fix)', () => {
  let service: CompanyConnectionManagerService;
  const registryMock = {
    findByCompanyId: jest.fn(),
    getDecryptedCredential: jest.fn(),
    findAllActive: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    createCompanyDataSource.mockImplementation(() => fakeDataSource());
    service = new CompanyConnectionManagerService(registryMock as unknown as DatabaseRegistryService);
  });

  describe('listActiveCompanyIds', () => {
    it('returns the companyId of every ACTIVE registry, nothing else', async () => {
      registryMock.findAllActive.mockResolvedValue([
        { companyId: 'company-1' },
        { companyId: 'company-2' },
      ] as DatabaseRegistry[]);
      const ids = await service.listActiveCompanyIds();
      expect(ids).toEqual(['company-1', 'company-2']);
    });
  });

  describe('getDataSource', () => {
    const activeRegistry = { id: 'registry-1', companyId: 'company-1', host: 'h', port: 5432, databaseName: 'db1', status: 'ACTIVE' } as DatabaseRegistry;

    it('refuses a Company with no DatabaseRegistry entry — never falls back to any other connection', async () => {
      registryMock.findByCompanyId.mockResolvedValue(null);
      await expect(service.getDataSource('company-x')).rejects.toThrow(CompanyDatabaseNotProvisionedError);
      expect(createCompanyDataSource).not.toHaveBeenCalled();
    });

    it('refuses a Company whose database is not ACTIVE — never silently connects anyway', async () => {
      registryMock.findByCompanyId.mockResolvedValue({ ...activeRegistry, status: 'PROVISIONING' });
      await expect(service.getDataSource('company-1')).rejects.toThrow(CompanyDatabaseNotActiveError);
      expect(createCompanyDataSource).not.toHaveBeenCalled();
    });

    it('opens a real connection using the decrypted credential, scoped to that Company only', async () => {
      registryMock.findByCompanyId.mockResolvedValue(activeRegistry);
      registryMock.getDecryptedCredential.mockResolvedValue(JSON.stringify({ username: 'u1', password: 'p1' }));

      const ds = await service.getDataSource('company-1');

      expect(createCompanyDataSource).toHaveBeenCalledWith({ host: 'h', port: 5432, username: 'u1', password: 'p1', database: 'db1' });
      expect(ds.isInitialized).toBe(true);
    });

    it('caches and reuses the same DataSource for a repeat call (never reopens per sweep tick)', async () => {
      registryMock.findByCompanyId.mockResolvedValue(activeRegistry);
      registryMock.getDecryptedCredential.mockResolvedValue(JSON.stringify({ username: 'u1', password: 'p1' }));

      const first = await service.getDataSource('company-1');
      const second = await service.getDataSource('company-1');

      expect(first).toBe(second);
      expect(createCompanyDataSource).toHaveBeenCalledTimes(1);
    });

    it('reopens when the connection target changed underneath it (Area 4 retry path via updateConnection)', async () => {
      registryMock.findByCompanyId.mockResolvedValueOnce(activeRegistry).mockResolvedValueOnce({ ...activeRegistry, host: 'new-host' });
      registryMock.getDecryptedCredential.mockResolvedValue(JSON.stringify({ username: 'u1', password: 'p1' }));

      await service.getDataSource('company-1');
      await service.getDataSource('company-1');

      expect(createCompanyDataSource).toHaveBeenCalledTimes(2);
      expect(createCompanyDataSource).toHaveBeenLastCalledWith({ host: 'new-host', port: 5432, username: 'u1', password: 'p1', database: 'db1' });
    });

    it('never returns a connection for one Company reused as another Company\'s connection (cache is keyed per Company, never shared)', async () => {
      registryMock.findByCompanyId.mockImplementation(async (companyId: string) => ({ ...activeRegistry, companyId, databaseName: `db_${companyId}` }));
      registryMock.getDecryptedCredential.mockResolvedValue(JSON.stringify({ username: 'u1', password: 'p1' }));

      const dsA = await service.getDataSource('company-a');
      const dsB = await service.getDataSource('company-b');

      expect(dsA).not.toBe(dsB);
      expect(createCompanyDataSource).toHaveBeenNthCalledWith(1, expect.objectContaining({ database: 'db_company-a' }));
      expect(createCompanyDataSource).toHaveBeenNthCalledWith(2, expect.objectContaining({ database: 'db_company-b' }));
    });
  });

  describe('onModuleDestroy', () => {
    it('destroys every cached connection', async () => {
      registryMock.findByCompanyId.mockResolvedValue({ id: 'r1', companyId: 'company-1', host: 'h', port: 5432, databaseName: 'db1', status: 'ACTIVE' });
      registryMock.getDecryptedCredential.mockResolvedValue(JSON.stringify({ username: 'u', password: 'p' }));
      const ds = await service.getDataSource('company-1');

      await service.onModuleDestroy();

      expect(ds.destroy).toHaveBeenCalled();
    });
  });
});
