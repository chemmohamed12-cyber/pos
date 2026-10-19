import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../inventory-warehouse/application/warehouse-transactions.service';
import { InventoryPostingDispatchService } from '../../inventory-warehouse/application/inventory-posting-dispatch.service';
import { WarehouseTransactionsController } from '../../inventory-warehouse/interface/warehouse-transactions.controller';
import { InventoryController } from '../../inventory-warehouse/interface/inventory.controller';
import { ProductsService } from '../../commerce/application/products.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../application/financial-events/inventory-costing-handler.service';
import { InventoryPostingPolicyService } from '../application/inventory-posting-policy.service';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { LedgerService } from '../application/ledger.service';
import { InventoryReconciliationService } from '../application/inventory-reconciliation.service';
import { PostingStatusService } from '../application/posting-status.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Inventory lifecycle, slice C2 (CTO authorisation 2026-10-18) - real PostgreSQL, Company A with Company B as the untouched witness.
 *  (A) IN-REQUEST POSTING DISPATCH: a document / movement request dispatches its financial events itself after its transaction commits, and REPORTS the truth
 *      about the GL side (`financialPosting`): never "posted" while an event is pending or rejected, never a hidden failure, safe under retry and overlap.
 *  (B) EXPLICIT BUSINESS DATE: the document's own date reaches the movement event, the valuation history row, the journal; validated before any write
 *      (calendar date, not in the future, open fiscal period); never replaced by the processing date.
 * The pipeline is the real one (service -> outbox -> event bus -> financial event -> costing handler -> journal -> ledger) with the REAL posting policy and
 * fiscal gate bound; the controller is called directly (guards are covered elsewhere). Every expected value is computed by hand. No tolerance anywhere.
 *
 * Fiscal calendar of the test Company (relative to today): one fiscal year [today-60 .. today+300]; period P1 [today-60 .. today-20] CLOSED; period P2
 * [today-19 .. today+300] OPEN. A date at today-30 is in the closed period; today-70 has no fiscal year at all.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe('Inventory lifecycle C2 - in-request posting dispatch and explicit business-date propagation - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let whTx: WarehouseTransactionsService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let valuation: InventoryValuationService;
  let ledger: LedgerService;
  let recon: InventoryReconciliationService;
  let dispatch: InventoryPostingDispatchService;
  let controller: WarehouseTransactionsController;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const at = (d: number) => new Date(`${daysFrom(d)}T12:00:00Z`);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '4201' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
  };
  const ids: Record<Key, { wh: string; wh2: string; p: string }> = { A: { wh: '', wh2: '', p: '' }, B: { wh: '', wh2: '', p: '' } };
  const periodIds: { closed: string; open: string } = { closed: '', open: '' };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'C2 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `c2-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    for (const [code, name, type, normal, fn] of [
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['3105', 'Opening Balance Equity', 'equity', 'credit', null],
      ['4201', 'Inventory Adjustment Gain', 'revenue', 'credit', null],
      ['5201', 'Inventory Adjustment Loss', 'expense', 'debit', null],
      ['5101', 'Cost of Goods Sold', 'expense', 'debit', null],
    ] as Array<[string, string, string, string, string | null]>) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
        [randomUUID(), code, name, type, normal, fn],
      );
    }
    const fy = randomUUID();
    const p1 = randomUUID();
    const p2 = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, daysFrom(-60), daysFrom(300)]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P1',$3,$4), ($5,$2,'P2',$6,$7)`, [p1, fy, daysFrom(-60), daysFrom(-20), p2, daysFrom(-19), daysFrom(300)]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'closed'), ($5,'accounting_fiscal_period','FiscalPeriod',$6,'open')`,
      [randomUUID(), fy, randomUUID(), p1, randomUUID(), p2],
    );
    if (k === 'A') {
      periodIds.closed = p1;
      periodIds.open = p2;
    }
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    ids[k].wh = (await inventory.createWarehouse(`WH-${k}`, `Main ${k}`, null, null, null, 'main', ds.manager)).id;
    ids[k].wh2 = (await inventory.createWarehouse(`WH2-${k}`, `Second ${k}`, null, null, null, 'main', ds.manager)).id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c2', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const cfg = { get: (key: string) => config[key] } as unknown as ConfigurationEngineService;
    const currencies = new CurrencyService(h.controlPlane, audit);
    const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, cfg, dimensions);

    valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    const handlerRegistry = new FinancialEventHandlerRegistry();
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, handlerRegistry, cfg);
    financialEvents.onModuleInit();
    new InventoryCostingHandlerService(handlerRegistry, valuation).onModuleInit();
    ledger = new LedgerService(h.controlPlane);
    const postingStatus = new PostingStatusService(h.controlPlane, ledger);
    recon = new InventoryReconciliationService(h.controlPlane, ledger, audit, valuation);

    // accounting binds ITS policy (reason map, fiscal gate, financial status) into the foundation holder, exactly as AccountingModule does at init.
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry, fiscalPeriods, postingStatus).onModuleInit();

    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policyRegistry);
    const dsA0 = await dsOf('A');
    const authorization = new AuthorizationService(dsA0.getRepository(Role), dsA0.getRepository(UserRole));
    whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry, valuation as never);
    dispatch = new InventoryPostingDispatchService(events, policyRegistry);
    controller = new WarehouseTransactionsController(whTx, {} as never, {} as never, dispatch);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    ids.A.p = (await products.createProduct('C2-P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('C2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const req = () => ({ user: { id: actor }, companyContext: { dataSource: undefined as never } }) as never;
  async function call(action: string, id: string): Promise<Loose> {
    const dsA = await dsOf('A');
    const r = req() as Loose;
    r.companyContext.dataSource = dsA;
    return (await controller.transition(r as never, id, { action } as never)) as Loose;
  }
  async function newDoc(type: 'receipt' | 'issue' | 'transfer', over: { qty?: number; cost?: string; date?: Date; dest?: string } = {}) {
    const dsA = await dsOf('A');
    return whTx.createTransaction(
      type,
      ids.A.wh,
      type === 'transfer' ? (over.dest ?? ids.A.wh2) : null,
      [{ productId: ids.A.p, quantity: over.qty ?? 5, unitCostBase: type === 'receipt' ? (over.cost ?? '4.00') : undefined }],
      null,
      'c2 test',
      null,
      actor,
      over.date,
      dsA.manager,
      type === 'receipt' ? 'FOUND_STOCK' : null,
    );
  }
  const eventsFor = async (docId: string) =>
    (await (await dsOf('A')).query(
      `SELECT fe.status, fe."rejectionReason", fe."journalEntryId", fe.id, fe.payload->>'businessDate' AS "eventDate", fe.payload->>'glKind' AS "glKind"
         FROM accounting_financial_events fe WHERE fe.payload->>'referenceId' = $1 ORDER BY fe."receivedAt"`,
      [docId],
    )) as Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null; id: string; eventDate: string; glKind: string }>;
  const journalDate = async (journalEntryId: string) => (await (await dsOf('A')).query(`SELECT "businessDate"::text AS d FROM accounting_journal_entries WHERE id = $1`, [journalEntryId]))[0].d as string;
  const valuationRows = async () =>
    (await (await dsOf('A')).query(`SELECT kind, "businessDate"::text AS d, "valueDeltaBase"::text AS v, quantity FROM inventory_valuation_movements ORDER BY "createdAt", id`)) as Array<{ kind: string; d: string; v: string; quantity: number }>;
  const glInventory = async (asOf?: string) => (await ledger.getAccountLedger((await (await dsOf('A')).query(`SELECT id FROM accounting_gl_accounts WHERE code = '1120'`))[0].id, asOf ? { to: asOf } : {}, (await dsOf('A')).manager)).closingBalanceBase;
  const snapshot = async () => ({
    stock: await cnt('A', 'stock_movements'),
    valuationRows: await cnt('A', 'inventory_valuation_movements'),
    valuationState: (await (await dsOf('A')).query(`SELECT "onHandQuantity"::text AS q, "totalValueBase"::text AS v FROM inventory_valuation_state ORDER BY "warehouseId"`)) as unknown[],
    outbox: await cnt('A', 'event_outbox'),
    events: await cnt('A', 'accounting_financial_events'),
    journals: await cnt('A', 'accounting_journal_entries'),
  });
  const setPeriod = async (periodId: string, state: 'open' | 'closed') =>
    (await dsOf('A')).query(`UPDATE process_instances SET "currentState" = $2 WHERE "entityId" = $1 AND "definitionKey" = 'accounting_fiscal_period'`, [periodId, state]);

  // ==========================================================================================================================================================
  it('1. DOCUMENT dated today-3 posts IN THE REQUEST (no sweep): response says posted; journal, event and valuation row carry today-3, the stock row keeps its record time', async () => {
    const D = daysFrom(-3);
    const dsA = await dsOf('A');
    const doc = await newDoc('receipt', { qty: 5, cost: '4.00', date: at(-3) });
    const before = await cnt('A', 'accounting_journal_entries');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      const res = await call('submit', doc.id);
      expect(res.state).toBe('posted');
      expect(res.financialPosting).toMatchObject({ status: 'posted', dispatchEnabled: true, message: 'Posted to the General Ledger.' });
    });
    expect(await cnt('A', 'accounting_journal_entries')).toBe(before + 1); // the journal exists although no sweep ran
    expect(await cnt('A', 'event_outbox')).toBeGreaterThan(0);
    expect(await dsA.query(`SELECT count(*)::int AS n FROM event_outbox WHERE topic = 'inventory.movement.recorded' AND status <> 'dispatched'`)).toEqual([{ n: 0 }]); // nothing left waiting
    const [e] = await eventsFor(doc.id);
    expect(e.status).toBe('POSTED');
    expect(e.eventDate).toBe(D);
    expect(await journalDate(e.journalEntryId!)).toBe(D);
    const vr = await valuationRows();
    expect(vr.map((r) => [r.kind, r.d, r.v])).toEqual([['receipt', D, '20.0000']]);
    const createdAt = (await dsA.query(`SELECT ("createdAt" AT TIME ZONE 'UTC')::date::text AS d FROM stock_movements`))[0].d as string;
    expect(createdAt).toBe(today); // record time is untouched (D-CR7); the accounting date is the document's
  });

  it('2. HISTORICAL as-of valuation, GL and reconciliation follow the business date: nothing before it, 5 u / 20.0000 from it, then-with-then MATCHED', async () => {
    const dsA = await dsOf('A');
    expect(await valuation.getValuedPositions(daysFrom(-4), {}, dsA.manager)).toEqual([]);
    expect((await valuation.getValuedPositions(daysFrom(-3), {}, dsA.manager)).map((p) => [p.quantity, p.totalValueBase])).toEqual([[5, '20.0000']]);
    expect(await glInventory(daysFrom(-4))).toBe('0.0000');
    expect(await glInventory(daysFrom(-3))).toBe('20.0000');
    for (const asOf of [daysFrom(-4), daysFrom(-3), today]) {
      const p = (await recon.preview({ asOfDate: asOf }, dsA.manager)) as Loose;
      expect([p.status, p.classification, p.driftBase]).toEqual(['matched', 'matched', '0.0000']);
    }
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
  });

  it('3. an ISSUE dated today-1 (approval flow): the cost is applied at ingest with the EVENT date - valuation row, COGS journal and as-of figures all say today-1', async () => {
    const D = daysFrom(-1);
    const dsA = await dsOf('A');
    const doc = await newDoc('issue', { qty: 2, date: at(-1) });
    const submitted = await call('submit', doc.id);
    expect(submitted.financialPosting).toMatchObject({ status: 'none' }); // awaiting approval: no movement, no event
    const approved = await call('approve', doc.id);
    expect(approved.state).toBe('posted');
    expect(approved.financialPosting.status).toBe('posted');
    const [e] = await eventsFor(doc.id);
    expect([e.glKind, e.status, e.eventDate]).toEqual(['dispatch', 'POSTED', D]);
    expect(await journalDate(e.journalEntryId!)).toBe(D);
    const vr = await valuationRows();
    expect(vr.map((r) => [r.kind, r.d, r.v])).toEqual([['receipt', daysFrom(-3), '20.0000'], ['issue', D, '-8.0000']]); // 2 x 4.0000 at the average
    expect((await valuation.getValuedPositions(daysFrom(-2), {}, dsA.manager)).map((p) => [p.quantity, p.totalValueBase])).toEqual([[5, '20.0000']]);
    expect((await valuation.getValuedPositions(D, {}, dsA.manager)).map((p) => [p.quantity, p.totalValueBase])).toEqual([[3, '12.0000']]);
    expect(await glInventory(daysFrom(-2))).toBe('20.0000');
    expect(await glInventory(D)).toBe('12.0000');
    for (const asOf of [daysFrom(-2), D, today]) {
      const p = (await recon.preview({ asOfDate: asOf }, dsA.manager)) as Loose;
      expect([p.status, p.classification, p.driftBase]).toEqual(['matched', 'matched', '0.0000']);
    }
  });

  it('4. a TRANSFER dated today-2 carries its date on the valuation rows (Model A: no journal); an explicit-date manual receipt and an opening import do too; an omitted date is today', async () => {
    const dsA = await dsOf('A');
    const journalsBefore = await cnt('A', 'accounting_journal_entries');
    const doc = await newDoc('transfer', { qty: 1, date: at(-2) });
    expect(await call('submit', doc.id)).toMatchObject({ state: 'submitted' }); // transfers need approval
    expect((await call('approve', doc.id)).state).toBe('posted');
    const rows = await valuationRows();
    const transfer = rows.filter((r) => r.kind === 'transfer_out' || r.kind === 'transfer_in' || r.kind === 'issue' || r.kind === 'receipt').slice(-2);
    expect(transfer.map((r) => [r.kind, r.d]).sort()).toEqual([['issue', daysFrom(-2)], ['receipt', daysFrom(-2)]]); // consume + carry, both dated by the document
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsBefore); // Model A: transfers post no journal
    // explicit date on a direct manual receipt (the POST /inventory/movements path)
    const mr = await inventory.recordManualReceipt(ids.A.wh, ids.A.p, 2, '5.00', 'FOUND_STOCK', null, actor, dsA.manager, daysFrom(-2));
    await dispatch.dispatchAndReport(dsA.manager, [{ referenceType: 'stock_movement', referenceId: mr.id }]);
    const [me] = (await dsA.query(`SELECT fe.status, fe.payload->>'businessDate' AS d, fe."journalEntryId" FROM accounting_financial_events fe WHERE fe."sourceEntityId"::text = $1`, [mr.id])) as Array<{ status: string; d: string; journalEntryId: string }>;
    expect([me.status, me.d, await journalDate(me.journalEntryId)]).toEqual(['POSTED', daysFrom(-2), daysFrom(-2)]);
    // omitted date = today (every unchanged caller)
    const plain = await inventory.recordManualReceipt(ids.A.wh, ids.A.p, 1, '5.00', 'FOUND_STOCK', null, actor, dsA.manager);
    await dispatch.dispatchAndReport(dsA.manager, [{ referenceType: 'stock_movement', referenceId: plain.id }]);
    const [pe] = (await dsA.query(`SELECT fe.payload->>'businessDate' AS d, fe."journalEntryId" FROM accounting_financial_events fe WHERE fe."sourceEntityId"::text = $1`, [plain.id])) as Array<{ d: string; journalEntryId: string }>;
    expect([pe.d, await journalDate(pe.journalEntryId)]).toEqual([today, today]);
    // the whole history is still consistent and reconciled at every date
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
    for (const asOf of [daysFrom(-3), daysFrom(-2), daysFrom(-1), today]) {
      const p = (await recon.preview({ asOfDate: asOf }, dsA.manager)) as Loose;
      expect([asOf, p.status, p.driftBase]).toEqual([asOf, 'matched', '0.0000']);
    }
  });

  it('5. VALIDATION before any write: a future date, a CLOSED period and a date outside every fiscal year are rejected with zero rows written; reopening the period lets the same document post', async () => {
    const dsA = await dsOf('A');
    // future: refused when the document is created
    await expect(newDoc('receipt', { date: at(2) })).rejects.toThrow(/in the future/);
    // closed period (today-30): the document can exist, posting is refused with nothing written
    const closed = await newDoc('receipt', { qty: 3, cost: '6.00', date: at(-30) });
    const before = await snapshot();
    await expect(call('submit', closed.id)).rejects.toThrow(/not open/);
    expect(await snapshot()).toEqual(before);
    // outside every fiscal year (today-70)
    const none = await newDoc('receipt', { qty: 3, cost: '6.00', date: at(-70) });
    const before2 = await snapshot();
    await expect(call('submit', none.id)).rejects.toThrow(/No fiscal year covers/);
    expect(await snapshot()).toEqual(before2);
    // recovery: the period is reopened (fixture for the owner's reopen action) and the SAME document posts exactly once, dated today-30
    await setPeriod(periodIds.closed, 'open');
    const res = await call('approve', closed.id); // the retry route of a no-approval document whose post was refused: it stays 'submitted' (existing workflow), approve -> post
    expect(res.state).toBe('posted');
    expect(res.financialPosting.status).toBe('posted');
    const evs = await eventsFor(closed.id);
    expect(evs).toHaveLength(1);
    expect(await journalDate(evs[0].journalEntryId!)).toBe(daysFrom(-30));
    expect((await call('post', closed.id)).state).toBe('posted'); // a second post is an idempotent no-op
    expect(await eventsFor(closed.id)).toHaveLength(1);
    expect(await cnt('A', 'stock_movements')).toBe(before.stock + 1);
    await setPeriod(periodIds.closed, 'closed');
    // the as-of figures include it from its date, reconciliation still matches then-with-then
    const p = (await recon.preview({ asOfDate: daysFrom(-29) }, dsA.manager)) as Loose;
    expect([p.status, p.driftBase]).toEqual(['matched', '0.0000']);
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
  });

  it('6. POSTING FAILURE is reported truthfully and recovers safely: switch off -> "pending"; the period closes before the sweep -> event REJECTED, response "rejected"; redrive after reopening -> posted once', async () => {
    const dsA = await dsOf('A');
    const prev = process.env.INVENTORY_IN_REQUEST_DISPATCH;
    process.env.INVENTORY_IN_REQUEST_DISPATCH = 'off';
    try {
      const doc = await newDoc('receipt', { qty: 2, cost: '7.00', date: at(-1) });
      const res = await call('submit', doc.id);
      expect(res.state).toBe('posted'); // the document and its stock effect are committed
      expect(res.financialPosting).toMatchObject({ status: 'pending', dispatchEnabled: false, dispatched: 0 }); // NOT claimed as posted
      expect(await eventsFor(doc.id)).toHaveLength(0); // no event yet: it is still in the outbox
      // the period is closed before anything dispatches it
      await setPeriod(periodIds.open, 'closed');
      process.env.INVENTORY_IN_REQUEST_DISPATCH = 'on';
      const rep = await dispatch.dispatchAndReport(dsA.manager, [{ referenceType: '*', referenceId: doc.id }]);
      expect(rep.status).toBe('rejected');
      expect(rep.message).toMatch(/REJECTED/);
      const [e] = await eventsFor(doc.id);
      expect(e.status).toBe('REJECTED');
      expect(e.rejectionReason).toMatch(/not open|period/i);
      // C1 reconciliation shows the value as an itemised, explained "unposted" difference - the failure is visible, not hidden
      const p = (await recon.preview({}, dsA.manager)) as Loose;
      expect(p.status).toBe('drift_found');
      expect(p.classification).toBe('explained');
      expect(p.unexplainedBase).toBe('0.0000');
      expect(p.analysis.categories.find((c: Loose) => c.code === 'unposted_value').amountBase).toBe('14.0000'); // 2 x 7.00
      // recovery: reopen, redrive (twice: the second is a no-op), exactly one journal
      await setPeriod(periodIds.open, 'open');
      const journalsBefore = await cnt('A', 'accounting_journal_entries');
      expect((await financialEvents.redrive(e.id, dsA.manager)).status).toBe('POSTED');
      expect((await financialEvents.redrive(e.id, dsA.manager)).deduped).toBe(true);
      expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsBefore + 1);
      expect((await dispatch.dispatchAndReport(dsA.manager, [{ referenceType: '*', referenceId: doc.id }])).status).toBe('posted');
      const q = (await recon.preview({}, dsA.manager)) as Loose;
      expect([q.status, q.classification, q.driftBase]).toEqual(['matched', 'matched', '0.0000']);
    } finally {
      process.env.INVENTORY_IN_REQUEST_DISPATCH = prev;
      if (prev === undefined) delete process.env.INVENTORY_IN_REQUEST_DISPATCH;
      await setPeriod(periodIds.open, 'open');
    }
  });

  it('7. if the DISPATCH ITSELF throws the document stays committed, the response never says "posted", the events stay queued, and the next dispatch posts them once', async () => {
    const dsA = await dsOf('A');
    const doc = await newDoc('receipt', { qty: 1, cost: '9.00', date: at(0) });
    const original = events.dispatchAfterCommit.bind(events);
    (events as Loose).dispatchAfterCommit = async () => {
      throw new Error('simulated dispatch outage');
    };
    let res: Loose;
    try {
      res = await call('submit', doc.id);
    } finally {
      (events as Loose).dispatchAfterCommit = original;
    }
    expect(res.state).toBe('posted');
    expect(res.financialPosting.status).toBe('pending');
    expect(res.financialPosting.dispatchError).toMatch(/simulated dispatch outage/);
    expect(await eventsFor(doc.id)).toHaveLength(0);
    expect((await dsA.query(`SELECT count(*)::int AS n FROM event_outbox WHERE status = 'pending'`))[0].n).toBeGreaterThan(0);
    const rep = await dispatch.dispatchAndReport(dsA.manager, [{ referenceType: '*', referenceId: doc.id }]);
    expect(rep.status).toBe('posted');
    expect(await eventsFor(doc.id)).toHaveLength(1);
  });

  it('8. DUPLICATE / OVERLAPPING dispatch is safe: parallel dispatchers and repeated calls neither double-post nor lose an event; the same idempotency key is deduped', async () => {
    const dsA = await dsOf('A');
    const process_ = process.env.INVENTORY_IN_REQUEST_DISPATCH;
    process.env.INVENTORY_IN_REQUEST_DISPATCH = 'off';
    const docs = [];
    try {
      for (let i = 0; i < 3; i++) {
        const d = await newDoc('receipt', { qty: 1, cost: '2.00', date: at(0) });
        await call('submit', d.id);
        docs.push(d);
      }
    } finally {
      process.env.INVENTORY_IN_REQUEST_DISPATCH = process_;
      if (process_ === undefined) delete process.env.INVENTORY_IN_REQUEST_DISPATCH;
    }
    const journalsBefore = await cnt('A', 'accounting_journal_entries');
    await Promise.all([events.dispatchAfterCommit(dsA.manager), events.dispatchAfterCommit(dsA.manager), dispatch.dispatchAndReport(dsA.manager, [])]);
    for (let i = 0; i < 3; i++) await dispatch.dispatchAndReport(dsA.manager, []);
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsBefore + 3); // exactly one journal per document
    for (const d of docs) expect(await eventsFor(d.id)).toHaveLength(1);
    // the same financial event key ingested again is a deduplicated no-op, never a second journal
    const [ev] = await eventsFor(docs[0].id);
    const key = (await dsA.query(`SELECT "idempotencyKey" AS k FROM accounting_financial_events WHERE id = $1`, [ev.id]))[0].k as string;
    expect(key).toMatch(/^inventory:movement:/);
    expect((await financialEvents.redrive(ev.id, dsA.manager)).deduped).toBe(true);
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsBefore + 3);
    expect((await dsA.query(`SELECT count(*)::int AS n FROM event_outbox WHERE topic = 'inventory.movement.recorded' AND status <> 'dispatched'`))[0].n).toBe(0);
  });

  it('9. CONSISTENCY across layers and COMPANY ISOLATION: stock = valuation quantity, valuation = GL at every date, journals balanced, Company B untouched', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    const stock = Number((await dsA.query(`SELECT coalesce(sum(quantity),0)::text AS q FROM stock_movements`))[0].q);
    const valued = Number((await dsA.query(`SELECT coalesce(sum("onHandQuantity"),0)::text AS q FROM inventory_valuation_state`))[0].q);
    expect(valued).toBe(stock);
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    expect([p.status, p.classification, p.driftBase, p.subledgerTotalBase === p.glBalanceBase]).toEqual(['matched', 'matched', '0.0000', true]);
    expect(await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`)).toEqual([]);
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
    expect((await dsA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n).toBe(0); // every event is POSTED, including the one test 6 deliberately rejected and re-drove
    // Company B: not one row, and the Platform DataSource was never needed for it
    for (const t of ['stock_movements', 'inventory_valuation_state', 'inventory_valuation_movements', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'warehouse_transactions']) {
      expect({ t, n: await cnt('B', t) }).toEqual({ t, n: 0 });
    }
    const previewB = (await recon.preview({}, dsB.manager)) as Loose;
    expect([previewB.classification, previewB.driftBase]).toEqual(['matched', '0.0000']);
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });

  it('11. the HTTP manual-receipt endpoint: explicit businessDate, in-request dispatch with a truthful report, closed period refused with nothing written', async () => {
    const dsA = await dsOf('A');
    const inventoryController = new InventoryController(inventory, {} as never, {} as never, {} as never, dispatch);
    const r = { user: { id: actor }, companyContext: { dataSource: dsA } } as never;
    const dto = (over: Record<string, unknown>) => ({ warehouseId: ids.A.wh, productId: ids.A.p, quantity: 2, movementType: 'receipt', unitCostBase: '3.00', reasonCode: 'FOUND_STOCK', ...over }) as never;

    const ok = (await inventoryController.recordMovement(r, dto({ businessDate: daysFrom(-2) }))) as Loose;
    expect(ok.financialPosting).toMatchObject({ status: 'posted', dispatchEnabled: true });
    const [e] = (await dsA.query(`SELECT fe.status, fe.payload->>'businessDate' AS d, fe."journalEntryId" FROM accounting_financial_events fe WHERE fe."sourceEntityId"::text = $1`, [ok.id])) as Array<{ status: string; d: string; journalEntryId: string }>;
    expect([e.status, e.d, await journalDate(e.journalEntryId)]).toEqual(['POSTED', daysFrom(-2), daysFrom(-2)]);

    const before = await snapshot();
    await expect(inventoryController.recordMovement(r, dto({ businessDate: daysFrom(-30) }))).rejects.toThrow(/not open/); // closed period
    await expect(inventoryController.recordMovement(r, dto({ businessDate: daysFrom(3) }))).rejects.toThrow(/in the future/);
    await expect(inventoryController.recordMovement(r, dto({ businessDate: '2026-02-30' }))).rejects.toThrow(/valid calendar date/);
    expect(await snapshot()).toEqual(before); // nothing written by any of the three refusals

    const plain = (await inventoryController.recordMovement(r, dto({}))) as Loose; // no date: today, exactly as before
    expect(plain.financialPosting.status).toBe('posted');
    const [pe] = (await dsA.query(`SELECT fe.payload->>'businessDate' AS d FROM accounting_financial_events fe WHERE fe."sourceEntityId"::text = $1`, [plain.id])) as Array<{ d: string }>;
    expect(pe.d).toBe(today);
  });

  it('10. the dispatch service without accounting reports "not_applicable" and never claims a posting', async () => {
    const dsA = await dsOf('A');
    const bare = new InventoryPostingDispatchService(events, new InventoryPostingPolicyRegistry());
    const rep = await bare.dispatchAndReport(dsA.manager, [{ referenceType: 'warehouse_transaction', referenceId: randomUUID() }]);
    expect(rep.status).toBe('not_applicable');
  });
});
