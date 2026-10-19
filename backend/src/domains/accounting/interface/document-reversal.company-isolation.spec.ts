import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../inventory-warehouse/application/warehouse-transactions.service';
import { InventoryPostingDispatchService } from '../../inventory-warehouse/application/inventory-posting-dispatch.service';
import { WarehouseTransactionsController } from '../../inventory-warehouse/interface/warehouse-transactions.controller';
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

describe('Document reversal (slice R) - every original movement reversed exactly: issue restores its original cost, receipts/adjustments/counts mirror their journal, transfers go back; atomic, idempotent - real-Postgres, A/B', () => {
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
  const worker = randomUUID(); // creates documents
  const supervisor = randomUUID(); // approves / posts
  const nobody = randomUUID(); // holds no role
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '4201' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
    'inventory.document_sod_enforced': 'off',
    'inventory.receipt_approval_required': 'off',
  };
  const ids: Record<Key, Record<string, string>> = { A: {}, B: {} };
  const periodIds: { closed: string; open: string } = { closed: '', open: '' };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'C2 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `c2-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
    for (const [uid, label, withRole] of [[worker, 'worker', true], [supervisor, 'supervisor', true], [nobody, 'nobody', false]] as Array<[string, string, boolean]>) {
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, `C3 ${label}`, `c3-${label}-${k}@test.local`]);
      if (withRole) await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), uid, role[0].id]);
    }
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_rev', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry, valuation as never, cfg);
    dispatch = new InventoryPostingDispatchService(events, policyRegistry);
    controller = new WarehouseTransactionsController(whTx, {} as never, {} as never, dispatch);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    ids.A.p = (await products.createProduct('R-P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
    ids.A.p2 = (await products.createProduct('R-P2', 'Product Two', '10.00', actor, null, dsA.manager)).id;
    ids.A.p3 = (await products.createProduct('R-P3', 'Product Three', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('C2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
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
  const lines = async (journalEntryId: string): Promise<string[]> =>
    ((await (await dsOf('A')).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    )) as Array<{ code: string; dr: string; cr: string }>).map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  const stateOf = async (id: string) => (await (await dsOf('A')).query(`SELECT "currentState" AS s FROM process_instances WHERE "definitionKey" = 'warehouse_transaction' AND "entityId" = $1`, [id]))[0].s as string;
  const pos = async (w: string, p: string) => {
    const r = (await valuation.getValuedPositions(undefined, { warehouseIds: [w], productId: p }, (await dsOf('A')).manager))[0];
    return r ? [r.quantity, r.totalValueBase, r.averageCostBase] : [0, '0.0000', null];
  };
  const stock = async (w: string, p: string) => Number((await (await dsOf('A')).query(`SELECT coalesce(sum(quantity),0)::int AS q FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2`, [w, p]))[0].q);
  const asManager = async () => (await dsOf('A')).manager;
  const reversalOf = async (docId: string) => (await (await dsOf('A')).query(`SELECT id, "createdByUserId" AS c FROM warehouse_transactions WHERE "reversalOfTransactionId" = $1`, [docId])) as Array<{ id: string; c: string }>;
  const eventsOf = async (docId: string) =>
    (await (await dsOf('A')).query(`SELECT status, "journalEntryId", payload->>'glKind' AS "glKind" FROM accounting_financial_events WHERE payload->>'referenceId' = $1 ORDER BY "receivedAt"`, [docId])) as Array<{ status: string; journalEntryId: string | null; glKind: string }>;
  const sansOutbox = (s: Awaited<ReturnType<typeof snapshot>>) => ({ ...s, outbox: 0 });

  async function call(action: string, id: string, as: string = supervisor): Promise<Loose> {
    const dsA = await dsOf('A');
    return (await controller.transition({ user: { id: as }, companyContext: { dataSource: dsA } } as never, id, { action } as never)) as Loose;
  }
  type Kind = 'receipt' | 'issue' | 'transfer' | 'adjustment';
  /** create + post a document through the real workflow; returns its id */
  async function post(kind: Kind, w: string, rows: Array<[string, number, string?]>, dest?: string): Promise<string> {
    const m = await asManager();
    const d = await whTx.createTransaction(kind, w, kind === 'transfer' ? dest! : null, rows.map(([productId, quantity, unitCostBase]) => ({ productId, quantity, unitCostBase: kind === 'receipt' ? unitCostBase : undefined })), null, 'r test', null, worker, undefined, m, kind === 'receipt' ? 'FOUND_STOCK' : null);
    const s = await call('submit', d.id, worker);
    if (s.state !== 'posted') expect((await call('approve', d.id, supervisor)).state).toBe('posted');
    await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: d.id }]);
    return d.id;
  }
  async function countDoc(w: string, p: string, physical: number): Promise<string> {
    const m = await asManager();
    const d = await whTx.startCount(w, [p], worker, m);
    const ls = await whTx.getLines(d.id, m);
    await whTx.recordCountResults(d.id, [{ lineId: ls[0].id, physicalQuantity: physical }], m);
    await call('submit', d.id, worker);
    expect((await call('approve', d.id, supervisor)).state).toBe('posted');
    await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: d.id }]);
    return d.id;
  }
  const P1 = () => ids.A.p;
  const P2 = () => ids.A.p2;
  const P3 = () => ids.A.p3;

  // ==========================================================================================================================================================
  // DOCUMENT REVERSAL (slice R). Semantics: every ORIGINAL stock movement is reversed exactly - valuation row inverted at its recorded cost, journal mirrored; transfer = a transfer back.
  // Hand-computed chain on WH / P1:  R1 receipt 10 @ 5.00 (10 u / 50.0000) -> I1 issue 4 at the average 5.0000 = COGS 20.00 (6 u / 30.0000) -> R2 receipt 10 @ 8.00 (16 u / 110.0000, avg 6.8750)
  //   reverse I1: the 4 units come back at the ORIGINAL cost 20.00 -> 20 u / 130.0000 (avg 6.5000), GL 130.00  (NOT 4 x 6.8750 = 27.50 -> 137.5000)
  //   reverse R2 (after later movements, 10 units still on hand): Dr 4201 80.00 / Cr 1120 80.00 -> 10 u / 50.0000 (avg 5.0000), GL 50.00
  // ==========================================================================================================================================================
  it('1. ISSUE reversal after later movements restores the ORIGINAL issued cost (no second consumption): valuation = GL, journal = mirror, document reversed', async () => {
    const m = await asManager();
    const r1 = await post('receipt', ids.A.wh, [[P1(), 10, '5.00']]);
    const i1 = await post('issue', ids.A.wh, [[P1(), 4]]);
    const r2 = await post('receipt', ids.A.wh, [[P1(), 10, '8.00']]);
    ids.A.r1 = r1;
    ids.A.r2 = r2;
    expect(await pos(ids.A.wh, P1())).toEqual([16, '110.0000', '6.8750']);
    expect(await glInventory()).toBe('110.0000');
    const [issueEvent] = await eventsOf(i1);
    expect(await lines(issueEvent.journalEntryId!)).toEqual(['1120 C 20.00', '5101 D 20.00']);

    const res = await call('reverse', i1);
    expect(res.state).toBe('reversed');
    expect(res.financialPosting.status).toBe('posted');
    const [rev] = await reversalOf(i1);
    const [revEvent] = await eventsOf(rev.id);
    expect([revEvent.glKind, revEvent.status]).toEqual(['movement_reversal', 'POSTED']);
    expect(await lines(revEvent.journalEntryId!)).toEqual(['1120 D 20.00', '5101 C 20.00']); // the mirror of the original
    expect(await pos(ids.A.wh, P1())).toEqual([20, '130.0000', '6.5000']); // original cost restored: 110 + 20, not 110 + 27.50
    expect(await stock(ids.A.wh, P1())).toBe(20);
    expect(await glInventory()).toBe('130.0000');
    expect(await stateOf(i1)).toBe('reversed');
    expect(await stateOf(rev.id)).toBe('posted');
    expect(((await recon.preview({}, m)) as Loose).classification).toBe('matched');
    expect((await m.query(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'warehouse_transaction.reversed' AND "resourceId" = $1`, [i1]))[0].n).toBe(1);
  });

  it('2. RECEIPT reversal (D3-B, with cost and reason) after later movements: mirror Dr reason account / Cr Inventory at the original value; the average follows the totals; needs the stock on hand', async () => {
    const m = await asManager();
    const res = await call('reverse', ids.A.r2); // 10 @ 8.00; 20 units are on hand, 10 must leave
    expect(res.state).toBe('reversed');
    expect(res.financialPosting.status).toBe('posted');
    const [rev] = await reversalOf(ids.A.r2);
    const [e] = await eventsOf(rev.id);
    expect(await lines(e.journalEntryId!)).toEqual(['1120 C 80.00', '4201 D 80.00']);
    expect(await pos(ids.A.wh, P1())).toEqual([10, '50.0000', '5.0000']);
    expect(await glInventory()).toBe('50.0000');
    expect(((await recon.preview({}, m)) as Loose).classification).toBe('matched');
    expect(await valuation.checkHistoryConsistency(m)).toEqual([]);

    // a receipt whose units were used cannot be reversed: WH2 / P1 receives 5 @ 2.00, 3 are issued (2 left), the reversal needs 5
    const r3 = await post('receipt', ids.A.wh2, [[P1(), 5, '2.00']]);
    const i2 = await post('issue', ids.A.wh2, [[P1(), 3]]);
    expect(await pos(ids.A.wh2, P1())).toEqual([2, '4.0000', '2.0000']);
    const before = await snapshot();
    await expect(call('reverse', r3)).rejects.toThrow(/must leave but only 2 are available/);
    expect(sansOutbox(await snapshot())).toEqual(sansOutbox(before)); // nothing written
    expect(await stateOf(r3)).toBe('posted');
    expect(await reversalOf(r3)).toEqual([]);
    // reverse the issue first (3 units back at their original cost 6.00) and the receipt reversal is then possible
    await call('reverse', i2);
    expect(await pos(ids.A.wh2, P1())).toEqual([5, '10.0000', '2.0000']);
    await call('reverse', r3);
    expect(await pos(ids.A.wh2, P1())).toEqual([0, '0.0000', null]);
    expect(await stock(ids.A.wh2, P1())).toBe(0);
    expect(((await recon.preview({}, m)) as Loose).classification).toBe('matched');
  });

  it('3. TRANSFER reversal is a forward transfer back (Model A, no journal); it needs the stock at the destination', async () => {
    const m = await asManager();
    await post('receipt', ids.A.wh, [[P2(), 6, '3.00']]);
    const journals = (await snapshot()).journals;
    const t1 = await post('transfer', ids.A.wh, [[P2(), 2]], ids.A.wh2);
    expect(await pos(ids.A.wh, P2())).toEqual([4, '12.0000', '3.0000']);
    expect(await pos(ids.A.wh2, P2())).toEqual([2, '6.0000', '3.0000']);
    const res = await call('reverse', t1);
    expect(res.state).toBe('reversed');
    const [rev] = (await m.query(`SELECT id, type, "warehouseId" AS w, "destinationWarehouseId" AS d FROM warehouse_transactions WHERE "reversalOfTransactionId" = $1`, [t1])) as Array<{ id: string; type: string; w: string; d: string }>;
    expect([rev.type, rev.w, rev.d]).toEqual(['transfer', ids.A.wh2, ids.A.wh]); // swapped
    expect(await pos(ids.A.wh, P2())).toEqual([6, '18.0000', '3.0000']);
    expect(await pos(ids.A.wh2, P2())).toEqual([0, '0.0000', null]);
    expect((await snapshot()).journals).toBe(journals); // no journal either way
    // refused when the destination no longer holds the units
    const t2 = await post('transfer', ids.A.wh, [[P2(), 2]], ids.A.wh2);
    await post('issue', ids.A.wh2, [[P2(), 1]]); // WH2 now holds 1
    const before = await snapshot();
    await expect(call('reverse', t2)).rejects.toThrow(/Insufficient stock/);
    expect(sansOutbox(await snapshot())).toEqual(sansOutbox(before));
    expect(await stateOf(t2)).toBe('posted');
    expect(((await recon.preview({}, m)) as Loose).classification).toBe('matched');
  });

  it('4. COUNT / ADJUSTMENT reversal restores the original value through the mirror of the loss / gain journal', async () => {
    const m = await asManager();
    await post('receipt', ids.A.wh, [[P3(), 10, '4.00']]);
    // count: system 10, shelf 8 -> variance -2 at the average 4.0000 = loss 8.00
    const c1 = await countDoc(ids.A.wh, P3(), 8);
    expect(await pos(ids.A.wh, P3())).toEqual([8, '32.0000', '4.0000']);
    const [ce] = await eventsOf(c1);
    expect(await lines(ce.journalEntryId!)).toEqual(['1120 C 8.00', '5201 D 8.00']);
    await call('reverse', c1);
    const [crev] = await reversalOf(c1);
    expect(await lines((await eventsOf(crev.id))[0].journalEntryId!)).toEqual(['1120 D 8.00', '5201 C 8.00']);
    expect(await pos(ids.A.wh, P3())).toEqual([10, '40.0000', '4.0000']);
    expect(await stock(ids.A.wh, P3())).toBe(10);
    // adjustment: +3 found at the average 4.0000 = gain 12.00; a later issue of 2; then the reversal (3 units must leave, 11 are on hand)
    const a1 = await post('adjustment', ids.A.wh, [[P3(), 3]]);
    expect(await pos(ids.A.wh, P3())).toEqual([13, '52.0000', '4.0000']);
    await post('issue', ids.A.wh, [[P3(), 2]]); // COGS 8.00 -> 11 u / 44.0000
    await call('reverse', a1);
    const [arev] = await reversalOf(a1);
    expect(await lines((await eventsOf(arev.id))[0].journalEntryId!)).toEqual(['1120 C 12.00', '4201 D 12.00']);
    expect(await pos(ids.A.wh, P3())).toEqual([8, '32.0000', '4.0000']); // 44 - 12
    expect(await glInventory()).toBe((Number((await valuation.getValuedOnHandTotal(undefined, m)).reduce((s, w) => s + Number(w.totalValueBase), 0))).toFixed(4));
    expect(((await recon.preview({}, m)) as Loose).classification).toBe('matched');
  });

  it('5. IDEMPOTENT and SAFE: a second reversal is refused, parallel reversals produce one effect, a reversal of a reversal and of a non-posted document are refused, pending / closed-period reversals write nothing and leave the original `posted`', async () => {
    const m = await asManager();
    const doc = await post('issue', ids.A.wh, [[P1(), 1]]);
    await call('reverse', doc);
    const afterOne = await snapshot();
    await expect(call('reverse', doc)).rejects.toThrow(/only posted transactions/);
    expect(await snapshot()).toEqual(afterOne);
    const [rev] = await reversalOf(doc);
    await expect(call('reverse', rev.id)).rejects.toThrow(/cannot itself be reversed/);
    const draft = await whTx.createTransaction('issue', ids.A.wh, null, [{ productId: P1(), quantity: 1 }], null, 'draft', null, worker, undefined, m, null);
    await expect(call('reverse', draft.id)).rejects.toThrow(/only posted transactions/);

    // parallel reversals of a fresh issue: exactly one effect
    const par = await post('issue', ids.A.wh, [[P1(), 1]]);
    const stock0 = await cnt('A', 'stock_movements');
    const settled = await Promise.allSettled([call('reverse', par), call('reverse', par)]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
    expect(await cnt('A', 'stock_movements')).toBe(stock0 + 1);
    expect(await reversalOf(par)).toHaveLength(1);

    // the original posting is still PENDING (dispatch off): the reversal is refused until it posts
    const prev = process.env.INVENTORY_IN_REQUEST_DISPATCH;
    process.env.INVENTORY_IN_REQUEST_DISPATCH = 'off';
    let pend: string;
    try {
      const d = await whTx.createTransaction('issue', ids.A.wh, null, [{ productId: P1(), quantity: 1 }], null, 'pending', null, worker, undefined, m, null);
      await call('submit', d.id, worker);
      await call('approve', d.id, supervisor);
      pend = d.id;
    } finally {
      process.env.INVENTORY_IN_REQUEST_DISPATCH = prev;
      if (prev === undefined) delete process.env.INVENTORY_IN_REQUEST_DISPATCH;
    }
    const s1 = await snapshot();
    await expect(call('reverse', pend)).rejects.toThrow(/GL posting is "pending"/);
    expect(await snapshot()).toEqual(s1);
    await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: pend }]);

    // today's period is closed: the reversal (dated now) is refused and, being ONE transaction, the original is NOT left half-reversed
    await setPeriod(periodIds.open, 'closed');
    const s2 = await snapshot();
    await expect(call('reverse', pend)).rejects.toThrow(/not open/);
    expect(await snapshot()).toEqual(s2);
    expect(await stateOf(pend)).toBe('posted');
    expect(await reversalOf(pend)).toEqual([]);
    await setPeriod(periodIds.open, 'open');
    expect((await call('reverse', pend)).state).toBe('reversed'); // the retry works once
  });

  it('6. ATOMIC: a failure half-way through a multi-line reversal rolls EVERYTHING back (no reversal document, original still posted); the retry reverses once', async () => {
    const m = await asManager();
    const d = await post('issue', ids.A.wh, [[P1(), 1], [P2(), 1]]);
    const real = inventory.recordMovement.bind(inventory);
    let calls = 0;
    const spy = jest.spyOn(inventory, 'recordMovement').mockImplementation(async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated failure on the second reversing movement');
      return real(...args);
    });
    const before = await snapshot();
    try {
      await expect(call('reverse', d)).rejects.toThrow(/simulated failure/);
    } finally {
      spy.mockRestore();
    }
    expect(sansOutbox(await snapshot())).toEqual(sansOutbox(before));
    expect(await stateOf(d)).toBe('posted');
    expect(await reversalOf(d)).toEqual([]);
    expect((await call('reverse', d)).state).toBe('reversed');
    expect(await reversalOf(d)).toHaveLength(1);
    expect(await eventsOf((await reversalOf(d))[0].id)).toHaveLength(2);
    expect(await valuation.checkHistoryConsistency(m)).toEqual([]);
  });

  it('7. CONSISTENCY and COMPANY ISOLATION: every event POSTED, journals balanced, valuation = GL, history consistent; Company B untouched', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    expect((await dsA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n).toBe(0);
    expect(await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`)).toEqual([]);
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    expect([p.status, p.classification, p.driftBase]).toEqual(['matched', 'matched', '0.0000']);
    expect(Number((await dsA.query(`SELECT coalesce(sum("onHandQuantity"),0)::text AS q FROM inventory_valuation_state`))[0].q)).toBe(Number((await dsA.query(`SELECT coalesce(sum(quantity),0)::text AS q FROM stock_movements`))[0].q));
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await recon.preview({}, dsA.manager);
    });
    for (const t of ['stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'warehouse_transactions']) {
      expect({ t, n: await cnt('B', t) }).toEqual({ t, n: 0 });
    }
    expect(((await recon.preview({}, dsB.manager)) as Loose).classification).toBe('matched');
  });
});
