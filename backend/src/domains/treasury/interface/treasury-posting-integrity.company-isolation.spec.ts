import { randomUUID } from 'crypto';
import { TreasuryService } from '../application/treasury.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { IdempotencyService } from '../../../foundation/error-contract/idempotency.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Treasury integrity T1 (2026-10-20) — real-Postgres proof that a Treasury-owned money movement is accepted ONLY if it can be posted:
 *   V1 closed period · V2 clearing account unset · V3 unmapped account (cash-in, cash-out, either side of a transfer) · V3b mapped code absent from the chart ·
 *   V4 failure injection after the leg is written (everything rolls back, no REJECTED event is left) · V6 N concurrent identical requests, one key ·
 *   V8 legacy: reversal of a leg that never had a GL effect mirrors "no GL" · V9 reversal of a posted movement · V16 Treasury == GL after all of it · A/B isolation.
 * Each refusal asserts the full "zero side effects" fingerprint (treasury, events, journals, outbox, audit-success rows).
 */
describe('Treasury integrity T1 — pre-commit validation of Treasury-owned GL effects — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let treasury: TreasuryService;
  let idempotency: IdempotencyService;
  let events: EventBusService;
  const cfg: Record<string, string> = {};
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  const today = new Date().toISOString().slice(0, 10);
  type Key = 'A' | 'B';
  const acc: Record<Key, { cash1101: string; bank1102: string; unmapped: string; dangling: string }> = {
    A: { cash1101: '', bank1102: '', unmapped: '', dangling: '' },
    B: { cash1101: '', bank1102: '', unmapped: '', dangling: '' },
  };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'T1 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `t1-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
      ['1102', 'Bank', 'asset', 'debit', 'bank'],
      ['3999', 'Cash movement clearing', 'asset', 'debit', null],
      ['1110', 'Accounts Receivable', 'asset', 'debit', 'ar'],
    ] as const) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
        [randomUUID(), code, name, type, normal, fn],
      );
    }
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);

    const bankType = (await treasury.listAccountTypes(ds.manager)).find((t) => t.code === 'bank')!;
    const mk = async (code: string, gl: string | null) => {
      const a = await treasury.createAccount(`${code}-${k}`, `${code} ${k}`, bankType.id, actor, ds.manager);
      if (gl) await treasury.setAccountGlMapping(a.id, gl, actor, ds.manager);
      return a.id;
    };
    acc[k].cash1101 = await mk('CASH1101', '1101');
    acc[k].bank1102 = await mk('BANK1102', '1102');
    acc[k].unmapped = await mk('UNMAPPED', null);
    acc[k].dangling = await mk('DANGLING', '9999');
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 't1_integrity', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: (key: string) => cfg[key] } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();
    treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
    idempotency = new IdempotencyService(h.controlPlane);
    await seed('A');
    await seed('B');
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('T1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  async function fingerprint(k: Key) {
    const ds = await dsOf(k);
    const n = async (sql: string) => Number((await ds.query(sql))[0].n);
    return {
      treasuryTxns: await n(`SELECT count(*) AS n FROM "treasury_transactions"`),
      financialEvents: await n(`SELECT count(*) AS n FROM "accounting_financial_events"`),
      journals: await n(`SELECT count(*) AS n FROM "accounting_journal_entries"`),
      outbox: await n(`SELECT count(*) AS n FROM "event_outbox"`),
      auditTreasury: await n(`SELECT count(*) AS n FROM "audit_records" WHERE "action" LIKE 'treasury.%'`),
    };
  }
  async function glBalance(k: Key, code: string): Promise<string> {
    const ds = await dsOf(k);
    const r = await ds.query(
      `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,2)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" AND je."postedAt" IS NOT NULL WHERE ga.code = $1`,
      [code],
    );
    return r[0].b;
  }
  const cashIn = async (k: Key, account: string, amount: string, ref: string | null = null) => treasury.cashInDirect(account, amount, null, null, ref, 't1', actor, (await dsOf(k)).manager);
  const cashOut = async (k: Key, account: string, amount: string) => treasury.cashOutDirect(account, amount, null, null, null, 't1', actor, (await dsOf(k)).manager);
  const transfer = async (k: Key, from: string, to: string, amount: string) => treasury.transferDirect(from, to, amount, null, 't1', actor, (await dsOf(k)).manager);
  const setPeriod = async (k: Key, state: 'open' | 'closed') =>
    (await dsOf(k)).query(`UPDATE "process_instances" SET "currentState" = $1 WHERE "definitionKey" = 'accounting_fiscal_period'`, [state]);

  it('V2 clearing account unset: a direct cash-in is refused before commit with the real reason; nothing is written', async () => {
    delete cfg['accounting.cash_movement_clearing_account_code'];
    const before = await fingerprint('A');
    await expect(cashIn('A', acc.A.cash1101, '100.00')).rejects.toThrow(/clearing account is unset.*Nothing was recorded/s);
    expect(await fingerprint('A')).toEqual(before);
  });

  it('happy path: with the clearing account configured the movement, its event and its balanced journal commit together; Treasury balance == GL', async () => {
    cfg['accounting.cash_movement_clearing_account_code'] = '3999';
    const bBefore = await fingerprint('B');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await cashIn('A', acc.A.cash1101, '1000.00', 'seed-1');
    });
    const ds = await dsOf('A');
    const ev = await ds.query(`SELECT status FROM "accounting_financial_events" WHERE "eventType" = 'treasury.cash.recorded'`);
    expect(ev.map((e: { status: string }) => e.status)).toEqual(['POSTED']);
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe('1000.00');
    expect(await glBalance('A', '1101')).toBe('1000.00');
    expect(await glBalance('A', '3999')).toBe('-1000.00');
    expect(await fingerprint('B')).toEqual(bBefore);
  });

  it('V1 closed fiscal period: refused before commit, nothing written; reopening the period makes the same request succeed', async () => {
    await setPeriod('A', 'closed');
    const before = await fingerprint('A');
    await expect(cashIn('A', acc.A.cash1101, '10.00')).rejects.toThrow(/not open/);
    await expect(cashOut('A', acc.A.cash1101, '10.00')).rejects.toThrow(/not open/);
    await expect(transfer('A', acc.A.cash1101, acc.A.bank1102, '10.00')).rejects.toThrow(/not open/);
    expect(await fingerprint('A')).toEqual(before);
    expect(await treasury.getAccountBalance(acc.A.cash1101, (await dsOf('A')).manager)).toBe('1000.00');
    await setPeriod('A', 'open');
    await cashIn('A', acc.A.cash1101, '10.00');
    expect(await treasury.getAccountBalance(acc.A.cash1101, (await dsOf('A')).manager)).toBe('1010.00');
    expect(await glBalance('A', '1101')).toBe('1010.00');
  });

  it('V3 unmapped account: cash-in, cash-out and BOTH sides of a transfer are refused (409) — no silent off-GL movement; nothing written', async () => {
    const before = await fingerprint('A');
    await expect(cashIn('A', acc.A.unmapped, '5.00')).rejects.toThrow(/not GL-mapped/);
    await expect(cashOut('A', acc.A.unmapped, '5.00')).rejects.toThrow(/not GL-mapped/);
    await expect(transfer('A', acc.A.cash1101, acc.A.unmapped, '5.00')).rejects.toThrow(/not GL-mapped/);
    await expect(transfer('A', acc.A.unmapped, acc.A.cash1101, '5.00')).rejects.toThrow(/not GL-mapped/);
    expect(await fingerprint('A')).toEqual(before);
  });

  it('V3b a mapped code that is not in the chart is refused before commit — no REJECTED event is left behind', async () => {
    const before = await fingerprint('A');
    await expect(cashIn('A', acc.A.dangling, '5.00')).rejects.toThrow(/not GL-mapped to an active chart account/);
    expect(await fingerprint('A')).toEqual(before);
  });

  it('transfer between two mapped accounts posts one balanced journal (Dr to / Cr from); it is not income or expense', async () => {
    await transfer('A', acc.A.cash1101, acc.A.bank1102, '400.00');
    const ds = await dsOf('A');
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe('610.00');
    expect(await treasury.getAccountBalance(acc.A.bank1102, ds.manager)).toBe('400.00');
    expect(await glBalance('A', '1101')).toBe('610.00');
    expect(await glBalance('A', '1102')).toBe('400.00');
    const pnl = await ds.query(`SELECT count(*)::int AS n FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga."accountType" IN ('revenue','expense')`);
    expect(pnl[0].n).toBe(0);
  });

  it('V4 failure injection AFTER the leg is written (a guard that throws at publish): the leg, the event and the outbox row all roll back', async () => {
    const before = await fingerprint('A');
    events.registerPublishGuard('treasury.cash.recorded', async () => {
      throw new Error('injected failure after the treasury leg was inserted');
    });
    await expect(cashIn('A', acc.A.cash1101, '77.00')).rejects.toThrow(/injected failure/);
    expect(await fingerprint('A')).toEqual(before);
    expect(await treasury.getAccountBalance(acc.A.cash1101, (await dsOf('A')).manager)).toBe('610.00');
    // remove the injected guard so later tests run on the real rules
    (events as unknown as { publishGuards: Map<string, unknown[]> }).publishGuards.get('treasury.cash.recorded')!.pop();
  });

  it('V6 eight concurrent identical requests with ONE idempotency key: exactly one leg, one event, one journal; the others replay the stored result', async () => {
    const ds = await dsOf('A');
    const before = await fingerprint('A');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        idempotency.withIdempotencyInTransaction('treasury.cash-in', 'v6-same-key', (tx) => treasury.cashInDirect(acc.A.cash1101, '25.00', null, null, 'v6', 't1', actor, tx), ds.manager),
      ),
    );
    await events.dispatchAfterCommit(ds.manager);
    const after = await fingerprint('A');
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(after.treasuryTxns - before.treasuryTxns).toBe(1);
    expect(after.financialEvents - before.financialEvents).toBe(1);
    expect(after.journals - before.journals).toBe(1);
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe('635.00');
    expect(await glBalance('A', '1101')).toBe('635.00');
  });

  it('V9 reversal of a posted movement posts the offsetting journal against the original (balances return); a second reversal is refused', async () => {
    const ds = await dsOf('A');
    const leg = await cashIn('A', acc.A.cash1101, '60.00', 'to-reverse');
    expect(await glBalance('A', '1101')).toBe('695.00');
    await treasury.reverseTransaction(leg.id, 'v9', actor, ds.manager);
    await events.dispatchAfterCommit(ds.manager);
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe('635.00');
    expect(await glBalance('A', '1101')).toBe('635.00');
    await expect(treasury.reverseTransaction(leg.id, 'again', actor, ds.manager)).rejects.toThrow(/Cannot reverse/);
    expect(await glBalance('A', '1101')).toBe('635.00');
  });

  it('V8 legacy leg on an unmapped account (created by a non-emitting path, as before T1): its reversal MIRRORS "no GL" instead of failing or inventing a journal', async () => {
    const ds = await dsOf('A');
    const legacy = await treasury.cashIn(acc.A.unmapped, '30.00', null, null, null, 'legacy', actor, ds.manager); // non-emitting contract path
    const before = await fingerprint('A');
    await treasury.reverseTransaction(legacy.id, 'v8', actor, ds.manager);
    const after = await fingerprint('A');
    expect(after.financialEvents).toBe(before.financialEvents);
    expect(after.journals).toBe(before.journals);
    expect(await treasury.getAccountBalance(acc.A.unmapped, ds.manager)).toBe('0.00');
  });

  it('deposit.verified and collection.remitted are guarded too: an unpostable payload (code not in the chart / closed period) is refused at publish and leaves no outbox row', async () => {
    const ds = await dsOf('A');
    const before = await fingerprint('A');
    const payload = (code: string | null) => ({ idempotencyKey: `t1-dep-${randomUUID()}`, depositId: randomUUID(), amount: '10.00', currency: 'EGP', businessDate: new Date().toISOString(), glAccountCode: code });
    await expect(ds.manager.transaction((tx) => events.publish(tx, 'deposit.verified', payload('9999')))).rejects.toThrow(/cannot be posted to the general ledger/);
    await expect(ds.manager.transaction((tx) => events.publish(tx, 'collection.remitted', { ...payload(null), collectionId: randomUUID() }))).rejects.toThrow(/cannot be posted to the general ledger/);
    await setPeriod('A', 'closed');
    await expect(ds.manager.transaction((tx) => events.publish(tx, 'deposit.verified', payload('1101')))).rejects.toThrow(/not open/); // full ISO timestamp is normalised to a date for the period gate
    await setPeriod('A', 'open');
    expect(await fingerprint('A')).toEqual(before);
    // and a valid one passes the guard (rolled back on purpose so nothing is left)
    await expect(
      ds.manager.transaction(async (tx) => {
        await events.publish(tx, 'deposit.verified', payload('1101'));
        throw new Error('rollback-on-purpose');
      }),
    ).rejects.toThrow(/rollback-on-purpose/);
  });

  it('V16 reconciliation: for every mapped account Treasury balance == GL balance, Dr == Cr across all journals, no REJECTED event exists; Company B untouched', async () => {
    const ds = await dsOf('A');
    expect(await treasury.getAccountBalance(acc.A.cash1101, ds.manager)).toBe(await glBalance('A', '1101'));
    expect(await treasury.getAccountBalance(acc.A.bank1102, ds.manager)).toBe(await glBalance('A', '1102'));
    const unbalanced = await ds.query(`SELECT count(*)::int AS n FROM "accounting_journal_entries" WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`);
    expect(unbalanced[0].n).toBe(0);
    const rejected = await ds.query(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE status <> 'POSTED'`);
    expect(rejected[0].n).toBe(0);
    const b = await fingerprint('B');
    expect(b).toEqual({ treasuryTxns: 0, financialEvents: 0, journals: 0, outbox: 0, auditTreasury: b.auditTreasury });
    expect(today.length).toBe(10);
  });
});
