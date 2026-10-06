import { DatabaseRegistryService } from './database-registry.service';
import { DatabaseRegistry } from './database-registry.entity';
import { DatabaseCredential } from './database-credential.entity';
import { DatabaseCredentialCipherService } from './database-credential-cipher.service';

describe('DatabaseRegistryService', () => {
  let service: DatabaseRegistryService;
  const registries = new Map<string, DatabaseRegistry>();
  const credentials = new Map<string, DatabaseCredential>();
  let idSeq = 0;

  const registryRepoMock = {
    create: jest.fn((data: Partial<DatabaseRegistry>) => ({ id: `registry-${++idSeq}`, createdAt: new Date(), ...data }) as DatabaseRegistry),
    save: jest.fn(async (registry: DatabaseRegistry) => {
      registries.set(registry.id, registry);
      return registry;
    }),
    findOne: jest.fn(async ({ where }: { where: { id?: string; companyId?: string } }) => {
      if (where.id) return registries.get(where.id) ?? null;
      if (where.companyId) return [...registries.values()].find((r) => r.companyId === where.companyId) ?? null;
      return null;
    }),
  };
  const credentialRepoMock = {
    create: jest.fn((data: Partial<DatabaseCredential>) => ({ id: `credential-${++idSeq}`, createdAt: new Date(), ...data }) as DatabaseCredential),
    save: jest.fn(async (credential: DatabaseCredential) => {
      credentials.set(credential.databaseRegistryId, credential);
      return credential;
    }),
    findOne: jest.fn(async ({ where }: { where: { databaseRegistryId: string } }) => credentials.get(where.databaseRegistryId) ?? null),
  };
  const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as never);

  beforeEach(() => {
    registries.clear();
    credentials.clear();
    idSeq = 0;
    jest.clearAllMocks();
    service = new DatabaseRegistryService(registryRepoMock as never, credentialRepoMock as never, cipher);
  });

  describe('register', () => {
    it('creates a registry row and a separate, encrypted credential row', async () => {
      const registry = await service.register(
        { companyId: 'company-1', host: 'db-host', port: 5432, databaseName: 'company_1_db', status: 'ACTIVE' },
        'plaintext-db-password',
      );
      expect(registry.companyId).toBe('company-1');
      expect(registry.host).toBe('db-host');

      const storedCredential = credentials.get(registry.id);
      expect(storedCredential).toBeDefined();
      expect(storedCredential!.encryptedValue).not.toContain('plaintext-db-password');
    });
  });

  describe('the normal registry read path never exposes the credential — V7 Area 3\'s own required security test', () => {
    it('findByCompanyId returns no credential field at all', async () => {
      await service.register(
        { companyId: 'company-1', host: 'db-host', port: 5432, databaseName: 'company_1_db', status: 'ACTIVE' },
        'plaintext-db-password',
      );
      const found = await service.findByCompanyId('company-1');
      expect(found).not.toBeNull();
      expect(Object.keys(found as object)).not.toContain('encryptedValue');
      expect(Object.keys(found as object)).not.toContain('credential');
      expect(Object.keys(found as object)).not.toContain('password');
      expect(JSON.stringify(found)).not.toContain('plaintext-db-password');
    });

    it('findById returns no credential field at all', async () => {
      const registry = await service.register(
        { companyId: 'company-1', host: 'db-host', port: 5432, databaseName: 'company_1_db', status: 'ACTIVE' },
        'plaintext-db-password',
      );
      const found = await service.findById(registry.id);
      expect(JSON.stringify(found)).not.toContain('plaintext-db-password');
    });
  });

  describe('getDecryptedCredential — the one deliberate exception path', () => {
    it('returns the original plaintext when called explicitly', async () => {
      const registry = await service.register(
        { companyId: 'company-1', host: 'db-host', port: 5432, databaseName: 'company_1_db', status: 'ACTIVE' },
        'plaintext-db-password',
      );
      const decrypted = await service.getDecryptedCredential(registry.id);
      expect(decrypted).toBe('plaintext-db-password');
    });

    it('returns null for a registry with no stored credential', async () => {
      const decrypted = await service.getDecryptedCredential('no-such-registry');
      expect(decrypted).toBeNull();
    });
  });
});
