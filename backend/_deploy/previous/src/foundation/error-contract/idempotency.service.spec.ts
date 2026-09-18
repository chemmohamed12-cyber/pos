import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyRecord } from './idempotency-record.entity';

/**
 * Main paths + the invariant that matters per CTO Execution Policy §5:
 * a replayed key never re-executes the operation, and a same-key race
 * still yields exactly one winning result for all callers.
 */
describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let store: Map<string, IdempotencyRecord>;

  const repoMock = {
    findOne: jest.fn(async ({ where }: { where: { scope: string; key: string } }) =>
      store.get(`${where.scope}::${where.key}`) ?? null,
    ),
    create: jest.fn((data: Partial<IdempotencyRecord>) => data as IdempotencyRecord),
    save: jest.fn(async (record: IdempotencyRecord) => {
      const storeKey = `${record.scope}::${record.key}`;
      if (store.has(storeKey)) {
        throw new Error('duplicate key value violates unique constraint');
      }
      store.set(storeKey, record);
      return record;
    }),
  };

  beforeEach(async () => {
    store = new Map();
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [IdempotencyService, { provide: getRepositoryToken(IdempotencyRecord), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(IdempotencyService);
  });

  it('runs the operation when no key is supplied', async () => {
    let calls = 0;
    const result = await service.withIdempotency('POST /x', undefined, async () => {
      calls++;
      return { ok: true };
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true });
  });

  it('runs the operation exactly once for a given key and returns the same result on replay', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      return { orderId: 'so-1', callNumber: calls };
    };
    const first = await service.withIdempotency('POST /sales-orders', 'key-1', op);
    const second = await service.withIdempotency('POST /sales-orders', 'key-1', op);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('scopes keys independently — the same key under a different scope runs its own operation', async () => {
    await service.withIdempotency('POST /sales-orders', 'key-1', async () => ({ from: 'orders' }));
    const result = await service.withIdempotency('POST /deposits', 'key-1', async () => ({ from: 'deposits' }));
    expect(result).toEqual({ from: 'deposits' });
  });

  it('resolves a same-key race to exactly one winning result, even when both callers pass their initial findOne check', async () => {
    // True concurrency: both callers' findOne() returns null (neither sees
    // the other's write yet), both run their operation, both attempt
    // save() — the DB's unique constraint lets exactly one insert win.
    // Simulated here by controlling findOne's return sequence directly,
    // since a single-threaded mock can't otherwise race two calls.
    const winnerRecord = { scope: 'POST /sales-orders', key: 'race-key', statusCode: 200, responseBody: { orderId: 'so-winner' } } as IdempotencyRecord;

    repoMock.findOne
      .mockResolvedValueOnce(null) // loser's pre-check: not cached yet
      .mockResolvedValueOnce(winnerRecord); // loser's post-conflict re-fetch: winner already committed

    repoMock.save.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    const loserResult = await service.withIdempotency('POST /sales-orders', 'race-key', async () => ({
      orderId: 'so-loser',
    }));

    expect(loserResult).toEqual({ orderId: 'so-winner' });
  });
});
