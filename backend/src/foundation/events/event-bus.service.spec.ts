import { EntityManager } from 'typeorm';
import { EventBusService } from './event-bus.service';
import { EventOutbox } from './event-outbox.entity';

/**
 * Unit coverage for the Event Engine's dispatch modes (Multi-Company Area 9 `manager?` param,
 * ADR-075 Company context). The real-Postgres A/B proof lives in
 * `event-engine.company-isolation.spec.ts`; here the claim/lease SQL is stubbed.
 */
describe('EventBusService.dispatchPending — ambient vs Company dispatch', () => {
  let service: EventBusService;
  let ambientRows: EventOutbox[];
  let ambientRepo: { find: jest.Mock; save: jest.Mock };
  const connections = { companyIdOf: jest.fn(() => 'company-a') };

  const makeRepo = (rows: EventOutbox[]) => ({
    find: jest.fn(async () => rows.filter((r) => r.status === 'pending')),
    save: jest.fn(async (row: EventOutbox) => {
      const idx = rows.findIndex((r) => r.id === row.id);
      rows[idx] = row;
      return row;
    }),
  });

  /** A root (non-transaction) Company manager whose claim query returns `claimed` and records every UPDATE. */
  const makeCompanyManager = (claimed: Array<{ id: number; topic: string; payload: Record<string, unknown>; attempts: number }>) => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (/WITH claimed AS/.test(sql)) return claimed;
      updates.push({ sql, params });
      return [];
    });
    const manager = { query, connection: { id: 'ds-a' }, queryRunner: undefined, getRepository: jest.fn() } as unknown as EntityManager;
    return { manager, updates, query };
  };

  beforeEach(() => {
    ambientRows = [{ id: 1, topic: 'ambient.topic', payload: {}, schemaVersion: 1, status: 'pending', attempts: 0, createdAt: new Date(), dispatchedAt: null }];
    ambientRepo = makeRepo(ambientRows);
    connections.companyIdOf.mockClear();
    service = new EventBusService(ambientRepo as never, connections as never);
  });

  it('without a manager, dispatches from the ambient outbox and runs EVERY handler (ambient and company scope) with a null ctx', async () => {
    const seen: Array<{ scope: string; ctx: unknown }> = [];
    service.subscribe('ambient.topic', async (_p, ctx) => void seen.push({ scope: 'ambient', ctx }));
    service.subscribe('ambient.topic', async (_p, ctx) => void seen.push({ scope: 'company', ctx }), { scope: 'company' });

    const result = await service.dispatchPending();

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(seen).toEqual([
      { scope: 'ambient', ctx: { manager: null, companyId: null } },
      { scope: 'company', ctx: { manager: null, companyId: null } },
    ]);
    expect(ambientRows[0].status).toBe('dispatched');
  });

  it("with a Company root manager, claims from THAT manager's outbox (never the ambient one) and runs only company-scope handlers with {manager, companyId}", async () => {
    const { manager, updates } = makeCompanyManager([{ id: 7, topic: 'finance.x', payload: { a: 1 }, attempts: 0 }]);
    const ambientHandler = jest.fn();
    const companyHandler = jest.fn();
    service.subscribe('finance.x', ambientHandler);
    service.subscribe('finance.x', companyHandler, { scope: 'company' });

    const result = await service.dispatchPending(50, manager);

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(ambientHandler).not.toHaveBeenCalled();
    expect(companyHandler).toHaveBeenCalledWith({ a: 1 }, { manager, companyId: 'company-a' });
    expect(ambientRepo.find).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual([7, 'dispatched']);
  });

  it("marks a Company-outbox row 'skipped' when its topic has only ambient-scope subscribers — never run, never silently 'dispatched'", async () => {
    const { manager, updates } = makeCompanyManager([{ id: 8, topic: 'commerce.product.created', payload: {}, attempts: 0 }]);
    const ambientHandler = jest.fn();
    service.subscribe('commerce.product.created', ambientHandler);

    const result = await service.dispatchPending(50, manager);

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(ambientHandler).not.toHaveBeenCalled();
    expect(updates[0].params).toEqual([8, 'skipped']);
  });

  it('a topic with no subscribers at all stays plain dispatched (unchanged historical behavior)', async () => {
    const { manager, updates } = makeCompanyManager([{ id: 9, topic: 'nobody.listens', payload: {}, attempts: 0 }]);
    const result = await service.dispatchPending(50, manager);
    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(updates[0].params).toEqual([9, 'dispatched']);
  });

  it('a failing company handler returns the row to pending with attempts+1; the 5th failure marks it failed', async () => {
    const { manager, updates } = makeCompanyManager([
      { id: 10, topic: 'finance.x', payload: {}, attempts: 0 },
      { id: 11, topic: 'finance.x', payload: {}, attempts: 4 },
    ]);
    service.subscribe('finance.x', async () => { throw new Error('boom'); }, { scope: 'company' });

    const result = await service.dispatchPending(50, manager);

    expect(result).toEqual({ dispatched: 0, failed: 2 });
    expect(updates.map((u) => u.params)).toEqual([[10, 'pending'], [11, 'failed']]);
  });

  it('dispatchAfterCommit: no-op inside an ACTIVE transaction; Company dispatch for a root manager; ambient with no manager', async () => {
    const txManager = { queryRunner: { isTransactionActive: true }, query: jest.fn(), getRepository: jest.fn() } as unknown as EntityManager;
    expect(await service.dispatchAfterCommit(txManager)).toEqual({ dispatched: 0, failed: 0 });
    expect((txManager.query as jest.Mock)).not.toHaveBeenCalled();
    expect(ambientRepo.find).not.toHaveBeenCalled();

    const { manager, query } = makeCompanyManager([]);
    await service.dispatchAfterCommit(manager);
    expect(query).toHaveBeenCalled();
    expect(ambientRepo.find).not.toHaveBeenCalled();

    await service.dispatchAfterCommit(undefined);
    expect(ambientRepo.find).toHaveBeenCalledTimes(1);
  });

  it("an explicit manager that is inside a transaction dispatches inline from that manager's repo (caller's choice), still Company-scoped", async () => {
    const rows: EventOutbox[] = [{ id: 3, topic: 'finance.x', payload: { z: 1 }, schemaVersion: 1, status: 'pending', attempts: 0, createdAt: new Date(), dispatchedAt: null }];
    const repo = makeRepo(rows);
    const txManager = { queryRunner: { isTransactionActive: true }, connection: {}, getRepository: jest.fn(() => repo) } as unknown as EntityManager;
    const ambientHandler = jest.fn();
    const companyHandler = jest.fn();
    service.subscribe('finance.x', ambientHandler);
    service.subscribe('finance.x', companyHandler, { scope: 'company' });

    const result = await service.dispatchPending(50, txManager);

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(ambientHandler).not.toHaveBeenCalled();
    expect(companyHandler).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe('dispatched');
    expect(ambientRepo.find).not.toHaveBeenCalled();
  });
});
