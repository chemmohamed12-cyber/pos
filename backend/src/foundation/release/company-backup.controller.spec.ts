import { UnauthorizedException } from '@nestjs/common';
import { CompanyBackupController } from './company-backup.controller';
import { BackupRun } from './backup-run.entity';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 10, D2-mirrored dual
 * path). Proves the self-service controller derives the Company EXCLUSIVELY
 * from `req.companyContext.companyId` — the value `CompanyContextGuard`
 * already validated fresh against `Membership` for this request's token —
 * never from any client-suppliable input, same confused-deputy defense as
 * `CompanyMembershipController`.
 */
describe('CompanyBackupController — Track D §Step 10 (2026-09-24)', () => {
  const findMock = jest.fn().mockResolvedValue([]);
  const dataSourceMock = { getRepository: jest.fn(() => ({ find: findMock })) };
  const backupManagerMock = { createBackup: jest.fn() };
  const restoreManagerMock = { preflight: jest.fn(), confirmAndRestore: jest.fn() };
  let controller: CompanyBackupController;

  beforeEach(() => {
    jest.clearAllMocks();
    findMock.mockResolvedValue([]);
    controller = new CompanyBackupController(backupManagerMock as never, restoreManagerMock as never, dataSourceMock as never);
  });

  it('list() scopes the query to req.companyContext.companyId, not any client-suppliable value', async () => {
    const req = { companyContext: { companyId: 'company-1' } } as never;
    await controller.list(req);
    expect(dataSourceMock.getRepository).toHaveBeenCalledWith(BackupRun);
    expect(findMock).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'company-1' } }));
  });

  it('list() throws UnauthorizedException if companyContext is somehow missing (guard should have prevented this)', async () => {
    await expect(controller.list({} as never)).rejects.toThrow(UnauthorizedException);
  });

  it('create() passes req.companyContext.companyId to BackupManagerService — no :companyId route param exists on this controller', async () => {
    const req = { user: { id: 'user-1' }, companyContext: { companyId: 'company-1' } } as never;
    backupManagerMock.createBackup.mockResolvedValue({ id: 'run-1' });

    await controller.create(req);

    expect(backupManagerMock.createBackup).toHaveBeenCalledWith('manual', 'user-1', 'company-1');
  });

  it('preflightRestore() forwards req.companyContext.companyId — never a companyId from the request body', async () => {
    const req = { user: { id: 'user-1' }, companyContext: { companyId: 'company-1' } } as never;
    restoreManagerMock.preflight.mockResolvedValue({ id: 'restore-1' });

    await controller.preflightRestore(req, 'backup-run-1');

    expect(restoreManagerMock.preflight).toHaveBeenCalledWith('backup-run-1', 'user-1', 'company-1');
  });

  it('confirmRestore() does not pass companyId at all — RestoreManagerService re-validates from the stored RestoreOperation, never trusts this request for which Company gets restored', async () => {
    const req = { user: { id: 'user-1' }, companyContext: { companyId: 'company-1' } } as never;
    restoreManagerMock.confirmAndRestore.mockResolvedValue({ id: 'restore-1', status: 'completed' });

    await controller.confirmRestore(req, 'restore-1');

    expect(restoreManagerMock.confirmAndRestore).toHaveBeenCalledWith('restore-1', 'user-1');
  });
});
