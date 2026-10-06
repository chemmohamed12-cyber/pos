import { NotFoundException } from '@nestjs/common';
import { DatabaseRegistryService } from './database-registry.service';
import { DatabaseCredentialCipherService } from './database-credential-cipher.service';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 5 — Option A,
 * decided). Proves the narrow credential-access API composes the exact
 * `DatabaseConfig` shape `PgDumpRunnerService` needs, and refuses cleanly
 * (never silently) when the Company has no registry/credential.
 */
describe('DatabaseRegistryService.getConnectionConfigForCompany — Track D §Step 5 (2026-09-24)', () => {
  let service: DatabaseRegistryService;
  const registryRepoMock = { findOne: jest.fn() };
  const credentialRepoMock = { findOne: jest.fn() };
  const cipher = new DatabaseCredentialCipherService({ databaseCredentialEncryptionKey: 'a'.repeat(32) } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DatabaseRegistryService(registryRepoMock as never, credentialRepoMock as never, cipher);
  });

  it('composes the exact DatabaseConfig shape from the registry row + decrypted credential', async () => {
    registryRepoMock.findOne.mockResolvedValue({ id: 'registry-1', companyId: 'company-1', host: 'h', port: 5432, databaseName: 'db1', status: 'ACTIVE' });
    const encrypted = cipher.encrypt(JSON.stringify({ username: 'u1', password: 'p1' }));
    credentialRepoMock.findOne.mockResolvedValue({ databaseRegistryId: 'registry-1', encryptedValue: encrypted });

    const config = await service.getConnectionConfigForCompany('company-1');

    expect(config).toEqual({ host: 'h', port: 5432, username: 'u1', password: 'p1', database: 'db1' });
  });

  it('throws NotFoundException — never returns a partial/empty config — when the Company has no registry', async () => {
    registryRepoMock.findOne.mockResolvedValue(null);
    await expect(service.getConnectionConfigForCompany('ghost-company')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the registry exists but has no stored credential', async () => {
    registryRepoMock.findOne.mockResolvedValue({ id: 'registry-1', companyId: 'company-1', host: 'h', port: 5432, databaseName: 'db1', status: 'ACTIVE' });
    credentialRepoMock.findOne.mockResolvedValue(null);
    await expect(service.getConnectionConfigForCompany('company-1')).rejects.toThrow(NotFoundException);
  });
});
