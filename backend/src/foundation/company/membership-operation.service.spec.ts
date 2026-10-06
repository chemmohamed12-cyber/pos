import { MembershipOperationService } from './membership-operation.service';
import { MembershipOperation } from './membership-operation.entity';

describe('MembershipOperationService — Multi-Company Membership HTTP Management (D5, 2026-09-24)', () => {
  let service: MembershipOperationService;
  const rows = new Map<string, MembershipOperation>();
  let idSeq = 0;

  const repoMock = {
    create: jest.fn((data: Partial<MembershipOperation>) => ({ id: `op-${++idSeq}`, createdAt: new Date(), updatedAt: new Date(), ...data }) as MembershipOperation),
    save: jest.fn(async (row: MembershipOperation) => {
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(async (where: { id: string }, patch: Partial<MembershipOperation>) => {
      const existing = rows.get(where.id);
      if (existing) rows.set(where.id, { ...existing, ...patch });
    }),
    findOneOrFail: jest.fn(async ({ where }: { where: { id: string } }) => {
      const found = rows.get(where.id);
      if (!found) throw new Error('not found');
      return found;
    }),
    find: jest.fn(async ({ where }: { where: { status: string; attempts: unknown } }) =>
      [...rows.values()].filter((r) => r.status === where.status),
    ),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rows.clear();
    idSeq = 0;
    service = new MembershipOperationService(repoMock as never);
  });

  it('start() creates a PENDING operation with a fresh correlationId and zero attempts', async () => {
    const op = await service.start('user-1', 'company-1', 'grant', null, 'accountant');
    expect(op.status).toBe('PENDING');
    expect(op.attempts).toBe(0);
    expect(op.correlationId).toBeTruthy();
  });

  it('the lifecycle: PENDING -> APPLYING -> COMPLETED', async () => {
    const op = await service.start('user-1', 'company-1', 'grant', null, 'accountant');
    await service.markApplying(op.id);
    expect(rows.get(op.id)!.status).toBe('APPLYING');
    await service.markCompleted(op.id);
    expect(rows.get(op.id)!.status).toBe('COMPLETED');
  });

  it('markFailed increments attempts and records the error, leaving the operation retryable', async () => {
    const op = await service.start('user-1', 'company-1', 'grant', null, 'accountant');
    await service.markFailed(op.id, 'boom');
    const updated = rows.get(op.id)!;
    expect(updated.status).toBe('FAILED');
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toBe('boom');
  });

  it('findRetryable returns FAILED operations under the attempt cap', async () => {
    const op = await service.start('user-1', 'company-1', 'grant', null, 'accountant');
    await service.markFailed(op.id, 'boom');
    const retryable = await service.findRetryable(5);
    expect(retryable.map((r) => r.id)).toContain(op.id);
  });
});
