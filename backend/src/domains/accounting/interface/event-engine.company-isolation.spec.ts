import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { CompanyEventDispatcherScheduler } from '../../../foundation/events/company-event-dispatcher.scheduler';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { CompanyConnectionManagerService } from '../../../foundation/database-registry/company-connection-manager.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * D10 — Event Engine Company Context (ADR-075, 2026-10-04). Real-Postgres proof that an event published
 * inside Company A is processed against Company A's own database — the GL journal lands in A and nowhere
 * else (not B, not the ambient connection) — including when both Companies carry the SAME event type,
 * idempotency key, source entity id and account codes. Matrix §50 / Decision Package 2 "Required proof".
 *
 * The control-plane connection plays the ambient DataSource and has ONLY the 'core' migrations (no
 * accounting tables): any handler that falls back to it fails loudly. The ambient outbox repository is
 * inert (`{}`): touching it throws.
 */
describe('Event Engine — Company context (D10) — real-Postgres', () => {
  jest.setTimeout(300_000);
  let h: TwoCompanyHarness;
  let events: EventBusService;
  const actorUserId = randomUUID();

  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const AMOUNT = { A: '40.00', B: '75.00' } as const;
  const TOPIC = 'treasury.transfer.completed';
  type Key = 'A' | 'B';

  const idOf = (k: Key) => (k === 'A' ? h.companyAId : h.companyBId);
  const dsOf = (k: Key) => h.connections.getDataSource(idOf(k));

  async function seedCompanyData(companyId: string) {
    const ds = await h.connections.getDataSource(companyId);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actorUserId, 'D10 Test', `d10-${companyId}@test.local`]);
    // SAME account codes in both Companies (different row ids) — a code lookup that hit the wrong DB would still "find" an account.
    await ds.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive")
       VALUES ($1,'1000','Cash','asset','debit',true,true,true), ($2,'1001','Bank','asset','debit',true,true,true)`,
      [randomUUID(), randomUUID()],
    );
    const fiscalYearId = randomUUID();
    const fiscalPeriodId = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,$2,$3,$4)`, [fiscalYearId, 'FY', `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,$3,$4,$5)`, [fiscalPeriodId, fiscalYearId, 'P', `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fiscalYearId, randomUUID(), fiscalPeriodId],
    );
  }

  const transferPayload = (k: Key, overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: `d10:${randomUUID()}`,
    businessDate: today,
    orgUnitId: null,
    currency: 'EGP',
    sourceEntityType: 'treasury_transaction',
    sourceEntityId: randomUUID(),
    amount: AMOUNT[k],
    fromAccountCode: '1000',
    toAccountCode: '1001',
    reference: `D10-${k}`,
    ...overrides,
  });

  async function publishIn(k: Key, topic: string, payload: Record<string, unknown>) {
    const ds = await dsOf(k);
    await ds.manager.transaction(async (m) => {
      await events.publish(m, topic, payload);
    });
    return ds;
  }

  /** The journal a financial event (by idempotency key) produced in ONE Company's database, or null if that DB has no such event. */
  async function postedIn(k: Key, idempotencyKey: string): Promise<{ status: string; debit: string } | null> {
    const ds = await dsOf(k);
    const rows: Array<{ status: string; debit: string | null }> = await ds.query(
      `SELECT fe."status", (SELECT sum(jl."debitBase") FROM "accounting_journal_lines" jl WHERE jl."journalEntryId" = fe."journalEntryId") AS debit
         FROM "accounting_financial_events" fe WHERE fe."idempotencyKey" = $1`,
      [idempotencyKey],
    );
    return rows.length === 0 ? null : { status: rows[0].status, debit: Number(rows[0].debit ?? 0).toFixed(2) };
  }

  async function outboxStatus(k: Key, idempotencyKeyOrN: string, topic = TOPIC): Promise<string[]> {
    const ds = await dsOf(k);
    const rows: Array<{ status: string }> = await ds.query(
      `SELECT status FROM "event_outbox" WHERE topic = $1 AND (payload->>'idempotencyKey' = $2 OR payload->>'n' = $2) ORDER BY id`,
      [topic, idempotencyKeyOrN],
    );
    return rows.map((r) => r.status);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({
      namePrefix: 'event_engine_company_ctx',
      extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'],
    });
    await seedCompanyData(h.companyAId);
    await seedCompanyData(h.companyBId);

    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;

    for (const id of [h.companyAId, h.companyBId]) {
      const ds = await h.connections.getDataSource(id);
      await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    }

    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);

    // The REAL production wiring: onModuleInit registers the real V1 finance handlers and subscribes
    // to every SUBSCRIBED_TOPIC (scope 'company') — nothing test-specific about the GL path.
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();
  });

  afterAll(async () => {
    await h.teardown();
  });

  it('A/B isolation with IDENTICAL event type, idempotency key, source entity and account codes: each event posts ONLY in its own Company (and B\'s DataSource is never requested while A dispatches)', async () => {
    const shared = { idempotencyKey: `d10:same:${randomUUID()}`, sourceEntityId: randomUUID() };
    const dsA = await publishIn('A', TOPIC, transferPayload('A', shared));
    const dsB = await publishIn('B', TOPIC, transferPayload('B', shared));
    expect(await outboxStatus('A', shared.idempotencyKey)).toEqual(['pending']);
    expect(await outboxStatus('B', shared.idempotencyKey)).toEqual(['pending']);

    // A dispatches: lands in A (40.00); B is untouched — no financial event there, outbox row still pending.
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      expect(await events.dispatchPending(50, dsA.manager)).toEqual({ dispatched: 1, failed: 0 });
    });
    expect(await postedIn('A', shared.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.A });
    expect(await postedIn('B', shared.idempotencyKey)).toBeNull();
    expect(await outboxStatus('B', shared.idempotencyKey)).toEqual(['pending']);

    // …and the reverse: B dispatches, lands in B (75.00); A's journal is unchanged.
    await assertDataSourceNeverRequestedFor(h.connections, h.companyAId, async () => {
      expect(await events.dispatchPending(50, dsB.manager)).toEqual({ dispatched: 1, failed: 0 });
    });
    expect(await postedIn('B', shared.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.B });
    expect(await postedIn('A', shared.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.A });
    expect(await outboxStatus('A', shared.idempotencyKey)).toEqual(['dispatched']);
    expect(await outboxStatus('B', shared.idempotencyKey)).toEqual(['dispatched']);
  });

  it('dispatchAfterCommit: a no-op inside an ACTIVE transaction (rows not committed); Company dispatch after commit with the root manager', async () => {
    const payload = transferPayload('A');
    const dsA = await dsOf('A');
    await dsA.manager.transaction(async (m) => {
      await events.publish(m, TOPIC, payload);
      expect(await events.dispatchAfterCommit(m)).toEqual({ dispatched: 0, failed: 0 });
    });
    expect(await postedIn('A', payload.idempotencyKey)).toBeNull();
    expect(await outboxStatus('A', payload.idempotencyKey)).toEqual(['pending']);

    // (earlier postings leave follow-on outbox rows with no subscribers in the same Company outbox; those drain too)
    const flushed = await events.dispatchAfterCommit(dsA.manager);
    expect(flushed.failed).toBe(0);
    expect(flushed.dispatched).toBeGreaterThanOrEqual(1);
    expect(await outboxStatus('A', payload.idempotencyKey)).toEqual(['dispatched']);
    expect(await postedIn('A', payload.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.A });
    expect(await postedIn('B', payload.idempotencyKey)).toBeNull();
  });

  it('per-Company scheduler sweep: each Company\'s outbox is processed with that Company\'s manager; a Company whose connection fails does not stop the other', async () => {
    const pa = transferPayload('A');
    const pb = transferPayload('B');
    await publishIn('A', TOPIC, pa);
    await publishIn('B', TOPIC, pb);

    const scheduler = new CompanyEventDispatcherScheduler(events, h.connections);
    const summary = await scheduler.runOnce();
    expect(summary.companies).toBe(2);
    expect(summary.dispatched).toBeGreaterThanOrEqual(2);
    expect(await postedIn('A', pa.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.A });
    expect(await postedIn('B', pb.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.B });
    expect(await postedIn('A', pb.idempotencyKey)).toBeNull();
    expect(await postedIn('B', pa.idempotencyKey)).toBeNull();

    // Failure isolation: Company A's connection throws; Company B is still swept.
    const qa = transferPayload('A');
    const qb = transferPayload('B');
    await publishIn('A', TOPIC, qa);
    await publishIn('B', TOPIC, qb);
    const flaky = {
      listActiveCompanyIds: async () => [h.companyAId, h.companyBId],
      getDataSource: async (id: string) => {
        if (id === h.companyAId) throw new Error('simulated Company A connection failure');
        return h.connections.getDataSource(id);
      },
      companyIdOf: (ds: unknown) => h.connections.companyIdOf(ds as never),
    } as unknown as CompanyConnectionManagerService;
    const flakySummary = await new CompanyEventDispatcherScheduler(events, flaky).runOnce();
    expect(flakySummary.companies).toBe(1);
    expect(await postedIn('B', qb.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.B });
    expect(await postedIn('A', qa.idempotencyKey)).toBeNull();
    expect(await outboxStatus('A', qa.idempotencyKey)).toEqual(['pending']); // untouched, retried by the next healthy sweep
    await new CompanyEventDispatcherScheduler(events, h.connections).runOnce();
    expect(await postedIn('A', qa.idempotencyKey)).toEqual({ status: 'POSTED', debit: AMOUNT.A });
  });

  it('subscriber classification: an ambient-only subscriber is NEVER run on a Company event (row → skipped); a Company-scope subscriber runs with {manager, companyId}; ambient sibling on the same topic does not', async () => {
    const ambientCalls: unknown[] = [];
    const companyCalls: Array<{ companyId: string | null; hasManager: boolean; n: unknown }> = [];
    events.subscribe('d10.ambient.only', async (p) => void ambientCalls.push(p));
    events.subscribe('d10.mixed', async (p) => void ambientCalls.push(p));
    events.subscribe('d10.mixed', async (p, ctx) => void companyCalls.push({ companyId: ctx.companyId, hasManager: ctx.manager !== null, n: p.n }), { scope: 'company' });

    await publishIn('A', 'd10.ambient.only', { n: 'amb-1' });
    await publishIn('B', 'd10.mixed', { n: 'mix-1' });
    await events.dispatchPending(50, (await dsOf('A')).manager);
    await events.dispatchPending(50, (await dsOf('B')).manager);

    expect(ambientCalls).toEqual([]);
    expect(await outboxStatus('A', 'amb-1', 'd10.ambient.only')).toEqual(['skipped']);
    expect(companyCalls).toEqual([{ companyId: h.companyBId, hasManager: true, n: 'mix-1' }]);
    expect(await outboxStatus('B', 'mix-1', 'd10.mixed')).toEqual(['dispatched']);
  });

  it('concurrent claims (FOR UPDATE SKIP LOCKED): three simultaneous dispatchers process every row exactly once', async () => {
    const seen = new Map<string, number>();
    events.subscribe(
      'd10.concurrent',
      async (p) => {
        await new Promise((r) => setTimeout(r, 40));
        const n = String(p.n);
        seen.set(n, (seen.get(n) ?? 0) + 1);
      },
      { scope: 'company' },
    );
    const dsA = await dsOf('A');
    for (let i = 0; i < 6; i++) await publishIn('A', 'd10.concurrent', { n: `c-${i}` });

    const results = await Promise.all([1, 2, 3].map(() => events.dispatchPending(2, dsA.manager)));
    // drain whatever the batch limit left behind
    await events.dispatchPending(50, dsA.manager);

    const total = results.reduce((s, r) => s + r.dispatched, 0);
    expect(total).toBeLessThanOrEqual(6);
    expect([...seen.keys()].sort()).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4', 'c-5']);
    for (const count of seen.values()) expect(count).toBe(1);
    const ds = dsA;
    const rows: Array<{ status: string }> = await ds.query(`SELECT status FROM "event_outbox" WHERE topic = 'd10.concurrent'`);
    expect(rows.map((r) => r.status)).toEqual(Array(6).fill('dispatched'));
  });

  it('lease recovery: a row stuck "processing" past the lease (crashed dispatcher) is reclaimed; a freshly leased row is not', async () => {
    const handled: string[] = [];
    events.subscribe('d10.lease', async (p) => void handled.push(String(p.n)), { scope: 'company' });
    const dsA = await dsOf('A');
    await dsA.query(`INSERT INTO "event_outbox" (topic, payload, status, "dispatchedAt") VALUES ('d10.lease', '{"n":"stale"}', 'processing', now() - interval '10 minutes')`);
    await dsA.query(`INSERT INTO "event_outbox" (topic, payload, status, "dispatchedAt") VALUES ('d10.lease', '{"n":"fresh"}', 'processing', now())`);

    const result = await events.dispatchPending(50, dsA.manager);

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(handled).toEqual(['stale']);
    expect(await outboxStatus('A', 'stale', 'd10.lease')).toEqual(['dispatched']);
    expect(await outboxStatus('A', 'fresh', 'd10.lease')).toEqual(['processing']);
  });

  it('a failing Company handler leaves the row retryable in THAT Company only (attempts incremented, back to pending)', async () => {
    events.subscribe('d10.fails', async () => { throw new Error('boom'); }, { scope: 'company' });
    const dsA = await publishIn('A', 'd10.fails', { n: 'f-1' });
    expect(await events.dispatchPending(50, dsA.manager)).toEqual({ dispatched: 0, failed: 1 });
    const rows: Array<{ status: string; attempts: number }> = await dsA.query(`SELECT status, attempts FROM "event_outbox" WHERE topic = 'd10.fails'`);
    expect(rows).toEqual([{ status: 'pending', attempts: 1 }]);
    const none: unknown[] = await (await dsOf('B')).query(`SELECT 1 FROM "event_outbox" WHERE topic = 'd10.fails'`);
    expect(none).toEqual([]);
  });

  it('type sanity: a transaction manager is accepted by dispatchAfterCommit (compile-time contract)', () => {
    const fn: (m?: EntityManager) => Promise<unknown> = (m) => events.dispatchAfterCommit(m);
    expect(typeof fn).toBe('function');
  });
});
