import { BackupOperationService } from './backup-operation.service';
import { BackupOperation } from './backup-operation.entity';

describe('BackupOperationService — Backup/DR Architecture V1 (Track D §Step 4, 2026-09-24)', () => {
  let service: BackupOperationService;
  const rows = new Map<string, BackupOperation>();
  let idSeq = 0;

  const repoMock = {
    create: jest.fn((data: Partial<BackupOperation>) => ({ id: `op-${++idSeq}`, createdAt: new Date(), updatedAt: new Date(), ...data }) as BackupOperation),
    save: jest.fn(async (row: BackupOperation) => {
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(async (where: { id: string }, patch: Partial<BackupOperation>) => {
      const existing = rows.get(where.id);
      if (existing) rows.set(where.id, { ...existing, ...patch });
    }),
    findOneOrFail: jest.fn(async ({ where }: { where: { id: string } }) => {
      const found = rows.get(where.id);
      if (!found) throw new Error('not found');
      return found;
    }),
    find: jest.fn(async ({ where }: { where: { status: string } }) => [...rows.values()].filter((r) => r.status === where.status)),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rows.clear();
    idSeq = 0;
    service = new BackupOperationService(repoMock as never);
  });

  it('start() creates a PENDING operation with a fresh correlationId and zero attempts', async () => {
    const op = await service.start(null, 'run-1');
    expect(op.status).toBe('PENDING');
    expect(op.attempts).toBe(0);
    expect(op.correlationId).toBeTruthy();
    expect(op.nextRetryAt).toBeNull();
  });

  it('the lifecycle: PENDING -> RUNNING -> COMPLETED, nextRetryAt cleared', async () => {
    const op = await service.start('company-1', 'run-1');
    await service.markRunning(op.id);
    expect(rows.get(op.id)!.status).toBe('RUNNING');
    await service.markCompleted(op.id);
    expect(rows.get(op.id)!.status).toBe('COMPLETED');
    expect(rows.get(op.id)!.nextRetryAt).toBeNull();
  });

  it('markFailed under the retry cap sets FAILED with a future nextRetryAt — NOT terminal', async () => {
    const op = await service.start('company-1', 'run-1');
    await service.markFailed(op.id, 'pg_dump failed', 5);
    const updated = rows.get(op.id)!;
    expect(updated.status).toBe('FAILED');
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toBe('pg_dump failed');
    expect(updated.nextRetryAt).not.toBeNull();
    expect(updated.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('markFailed at the retry cap becomes terminal — nextRetryAt cleared, never picked up again', async () => {
    const op = await service.start('company-1', 'run-1');
    for (let i = 0; i < 5; i++) {
      await service.markFailed(op.id, `attempt ${i}`, 5);
    }
    const terminal = rows.get(op.id)!;
    expect(terminal.status).toBe('FAILED');
    expect(terminal.attempts).toBe(5);
    expect(terminal.nextRetryAt).toBeNull();
  });

  it('findRetryable returns only FAILED operations (RETRYING/COMPLETED/PENDING excluded)', async () => {
    const failedOp = await service.start('company-1', 'run-1');
    await service.markFailed(failedOp.id, 'boom', 5);
    const completedOp = await service.start('company-2', 'run-2');
    await service.markCompleted(completedOp.id);

    const retryable = await service.findRetryable();
    const ids = retryable.map((r) => r.id);
    expect(ids).toContain(failedOp.id);
    expect(ids).not.toContain(completedOp.id);
  });
});
