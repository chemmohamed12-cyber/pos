import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { OpeningBatchService } from '../../inventory-warehouse/application/opening-batch.service';
import { InventoryPostingDispatchService } from '../../inventory-warehouse/application/inventory-posting-dispatch.service';
import { OpeningBatchController } from '../../inventory-warehouse/interface/opening-batch.controller';
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
import { ApprovalEngineService } from '../../../foundation/approval-engine/approval-engine.service';
import { PermissionService } from '../../../foundation/permission/permission.service';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';
import type { DataSource } from 'typeorm';
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

describe('Inventory lifecycle C4 - the Opening Balance Batch (draft, control totals, two-approver gate, explicit post, lock, reversal, post-movement correction) - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let batches: OpeningBatchService;
  let approvals: ApprovalEngineService;
  let ambient: DataSource;
  let b1 = '';
  let moved = '';
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let valuation: InventoryValuationService;
  let ledger: LedgerService;
  let recon: InventoryReconciliationService;
  let dispatch: InventoryPostingDispatchService;
  const actor = randomUUID();
  const maker = randomUUID(); // creates, submits and posts batches
  const approver1 = randomUUID();
  const approver2 = randomUUID();
  const nobody = randomUUID(); // holds no role at all
  const today = new Date().toISOString().slice(0, 10);
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '4201', opening_balance: '3105' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
    'accounting.inventory_opening_correction_account_code': '3110',
    'inventory.opening_batch_required': false,
  };
  const flagOn = (on: boolean) => {
    config['inventory.opening_batch_required'] = on;
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
    for (const [uid, label, withRole] of [[maker, 'maker', true], [approver1, 'approver1', true], [approver2, 'approver2', true], [nobody, 'nobody', false]] as Array<[string, string, boolean]>) {
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, `C4 ${label}`, `c4-${label}-${k}@test.local`]);
      if (withRole) await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), uid, role[0].id]);
    }
    for (const [code, name, type, normal, fn] of [
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['3105', 'Opening Balance Equity', 'equity', 'credit', null],
      ['4201', 'Inventory Adjustment Gain', 'revenue', 'credit', null],
      ['5201', 'Inventory Adjustment Loss', 'expense', 'debit', null],
      ['5101', 'Cost of Goods Sold', 'expense', 'debit', null],
      ['3110', 'Opening Correction Equity', 'equity', 'credit', null],
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
    ids[k].wh3 = (await inventory.createWarehouse(`WH3-${k}`, `Third ${k}`, null, null, null, 'main', ds.manager)).id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c4', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policyRegistry, cfg);
    dispatch = new InventoryPostingDispatchService(events, policyRegistry);
    ambient = await createAmbientDataSource(h);
    approvals = new ApprovalEngineService(ambient, processEngine, audit, events, new PermissionService(inert, new AuthorizationService(inert, inert)), { get: () => 24 } as never);
    batches = new OpeningBatchService(h.controlPlane, numbering, processEngine, approvals, events, audit, inventory, products as never, policyRegistry);
    await batches.onModuleInit();

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    for (let i = 1; i <= 16; i++) ids.A[`p${i}`] = (await products.createProduct(`C4-P${i}`, `Product ${i}`, '10.00', actor, null, dsA.manager)).id;
    // every user of the test Company carries the admin role; the four opening-batch nodes are granted to it so the live permission check of FA-01 can resolve them
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    for (const node of ['inventory.opening_batch.create', 'inventory.opening_batch.approve', 'inventory.opening_batch.correct', 'inventory.opening_batch.override']) {
      await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, node]);
    }
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('C4 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
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
  const lines = async (journalEntryId: string): Promise<string[]> =>
    ((await (await dsOf('A')).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    )) as Array<{ code: string; dr: string; cr: string }>).map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  const stateOf = async (id: string) => (await (await dsOf('A')).query(`SELECT "currentState" AS s FROM process_instances WHERE "definitionKey" = 'inventory_opening_batch' AND "entityId" = $1`, [id]))[0].s as string;
  const posOf = async (wh: string, p: string) => {
    const r = (await (await dsOf('A')).query(`SELECT "onHandQuantity" AS q, "totalValueBase"::text AS v FROM inventory_valuation_state WHERE "warehouseId" = $1 AND "productId" = $2`, [wh, p]))[0] as { q: number; v: string } | undefined;
    return r ? [r.q, r.v] : [0, '0.0000'];
  };
  const stockOf = async (wh: string, p: string) => Number((await (await dsOf('A')).query(`SELECT coalesce(sum(quantity),0)::int AS q FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2`, [wh, p]))[0].q);
  const D3 = daysFrom(-3);
  /** the approval engine publishes its own outbox event on every decision: everything ELSE must stay identical */
  const sansOutbox = (s: Awaited<ReturnType<typeof snapshot>>) => ({ ...s, outbox: 0 });

  async function asManager() {
    return (await dsOf('A')).manager;
  }
  async function draft(wh: string, rows: Array<[string, number, string]>, cutOff = D3) {
    return batches.createDraft({ warehouseId: wh, cutOffDate: cutOff, lines: rows.map(([productId, quantity, unitCostBase]) => ({ productId, quantity, unitCostBase })) }, maker, await asManager());
  }
  const totalsOf = (rows: Array<[string, number, string]>) => ({
    declaredLineCount: rows.length,
    declaredTotalQuantity: rows.reduce((s, r) => s + r[1], 0),
    declaredTotalValueBase: (Math.round(rows.reduce((s, r) => s + r[1] * Number(r[2]), 0) * 10000) / 10000).toFixed(4),
  });
  /** submit -> two distinct approvers -> approved (nothing posted yet) */
  async function approveBatch(batchId: string, totals: ReturnType<typeof totalsOf> | null) {
    const m = await asManager();
    const v = await batches.submit(batchId, totals, maker, m);
    await approvals.decide(v.batch.approvalRequestId!, approver1, 'approved', null, m);
    await approvals.decide(v.batch.approvalRequestId!, approver2, 'approved', null, m);
    expect(await stateOf(batchId)).toBe('approved');
  }
  async function postAndDispatch(batchId: string) {
    const m = await asManager();
    const r = await batches.post(batchId, maker, m);
    const rep = await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: batchId }]);
    return { r, rep };
  }

  // ==========================================================================================================================================================
  // C4 (ADR-INV-01). Expected values by hand (cut-off D = today-3 unless stated):
  //  B1  WH  : P1 10 @ 5.00 = 50.00, P2 4 @ 2.50 = 10.00        -> lines 2, qty 14, value 60.0000; each line Dr 1120 / Cr 3105 at its value
  //  R1  WH2 : P1 3 @ 4.00 = 12.00, P2 2 @ 6.00 = 12.00 (24.00) -> reversed again at the original values (Dr 3105 / Cr 1120 12.00 each), then a corrected P1 3 @ 4.50 = 13.50
  //  M   WH  : P3 10 @ 3.00 = 30.00; a dispatch of 2 (COGS 6.00) leaves 8 u / 24.00; correction +2 @ 3.00 (Dr 1120 / Cr 3110 6.00) -> 10 u / 30.00; correction -1 at the average
  //            3.00 (Dr 3110 / Cr 1120 3.00) -> 9 u / 27.00.  P&L is never touched by a correction.
  // ==========================================================================================================================================================
  it('1. DRAFT validation: bad cut-off, bad lines and bad warehouses are refused; a good draft writes NOTHING to stock, valuation, outbox, events or journals', async () => {
    const before = await snapshot();
    await expect(draft(ids.A.wh, [[ids.A.p1, 10, '5.00']], daysFrom(2))).rejects.toThrow(/in the future/);
    await expect(draft(ids.A.wh, [[ids.A.p1, 10, '5.00']], '2026-02-30')).rejects.toThrow(/valid calendar date/);
    await expect(draft(ids.A.wh, [[ids.A.p1, 10, '0']])).rejects.toThrow(/positive unit cost/);
    await expect(draft(ids.A.wh, [[ids.A.p1, 0, '5.00']])).rejects.toThrow(/positive whole number/);
    await expect(draft(ids.A.wh, [[ids.A.p1, 1, '5.00'], [ids.A.p1, 2, '5.00']])).rejects.toThrow(/appears twice/);
    await expect(draft(ids.A.wh, [[randomUUID(), 1, '5.00']])).rejects.toThrow(/was not found/);
    await expect(draft(randomUUID(), [[ids.A.p1, 1, '5.00']])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    const v = await draft(ids.A.wh, [[ids.A.p1, 10, '5.00'], [ids.A.p2, 4, '2.50']]);
    expect(v.state).toBe('draft');
    expect(v.batch.batchNumber).toMatch(/^OB-\d{4}-000001$/);
    expect(v.lines.map((l) => [l.quantity, l.lineValueBase, l.isActive])).toEqual([[10, '50.0000', false], [4, '10.0000', false]].sort());
    expect(v.batch.computedTotalValueBase).toBe('60.0000');
    expect(await snapshot()).toEqual(before); // a draft touches nothing
    b1 = v.batch.id;
  });

  it('2. SUBMIT controls: wrong / missing control totals, a closed period, a missing account and an already-moved pair are refused with nothing written and no approval request', async () => {
    const m = await asManager();
    const before = await snapshot();
    const reqCount = async () => Number((await m.query(`SELECT count(*) AS n FROM approval_requests WHERE "requestTypeCode" LIKE 'inventory.opening_batch%'`))[0].n);
    const req0 = await reqCount();
    await expect(batches.submit(b1, null, maker, m)).rejects.toThrow(/control totals .* are required/i);
    await expect(batches.submit(b1, { declaredLineCount: 3, declaredTotalQuantity: 14, declaredTotalValueBase: '60.0000' }, maker, m)).rejects.toThrow(/line count declared 3/);
    await expect(batches.submit(b1, { declaredLineCount: 2, declaredTotalQuantity: 15, declaredTotalValueBase: '60.0000' }, maker, m)).rejects.toThrow(/total quantity declared 15/);
    await expect(batches.submit(b1, { declaredLineCount: 2, declaredTotalQuantity: 14, declaredTotalValueBase: '61.0000' }, maker, m)).rejects.toThrow(/total value declared 61/);
    // cut-off in the CLOSED period (today-30)
    const closed = await draft(ids.A.wh3, [[ids.A.p5, 1, '1.00']], daysFrom(-30));
    await expect(batches.submit(closed.batch.id, totalsOf([[ids.A.p5, 1, '1.00']]), maker, m)).rejects.toThrow(/not open/);
    // the opening-balance account is not configured -> refused BEFORE anything is created
    const saved = config['accounting.inventory_opening_balance_account_code'];
    delete config['accounting.inventory_opening_balance_account_code'];
    await expect(batches.submit(b1, totalsOf([[ids.A.p1, 10, '5.00'], [ids.A.p2, 4, '2.50']]), maker, m)).rejects.toThrow(/not configured/);
    config['accounting.inventory_opening_balance_account_code'] = saved;
    // a pair that already has stock activity (P4 in WH2 received a manual receipt) is not eligible for an opening
    await inventory.recordManualReceipt(ids.A.wh2, ids.A.p4, 1, '1.00', 'FOUND_STOCK', null, maker, m);
    await dispatch.dispatchAndReport(m, []);
    const moved = await draft(ids.A.wh2, [[ids.A.p4, 5, '2.00']]);
    await expect(batches.submit(moved.batch.id, totalsOf([[ids.A.p4, 5, '2.00']]), maker, m)).rejects.toThrow(/already has stock activity/);
    expect(await reqCount()).toBe(req0);
    expect(await stateOf(b1)).toBe('draft');
    // only the deliberate receipt of P4 changed anything
    const after = await snapshot();
    expect(after.stock).toBe(before.stock + 1);
    expect(after.events).toBe(before.events + 1);
    expect(await stateOf(moved.batch.id)).toBe('draft');
  });

  it('3. APPROVAL: two DISTINCT approvers are required (maker, no-role user and a second vote by the same approver are refused); nothing is posted at approval; `post` is separate, explicit and dated at the cut-off', async () => {
    const m = await asManager();
    const totals = totalsOf([[ids.A.p1, 10, '5.00'], [ids.A.p2, 4, '2.50']]);
    expect(totals).toEqual({ declaredLineCount: 2, declaredTotalQuantity: 14, declaredTotalValueBase: '60.0000' });
    const v = await batches.submit(b1, totals, maker, m);
    expect(v.state).toBe('submitted');
    const requestId = v.batch.approvalRequestId!;
    const before = await snapshot();
    await expect(approvals.decide(requestId, maker, 'approved', null, m)).rejects.toThrow(/segregation of duties/);
    await expect(approvals.decide(requestId, nobody, 'approved', null, m)).rejects.toThrow(/Not authorized/);
    await approvals.decide(requestId, approver1, 'approved', null, m);
    expect(await stateOf(b1)).toBe('submitted'); // one approver is not enough
    await expect(approvals.decide(requestId, approver1, 'approved', null, m)).rejects.toThrow(/already recorded a decision/);
    await approvals.decide(requestId, approver2, 'approved', null, m);
    expect(await stateOf(b1)).toBe('approved');
    expect(sansOutbox(await snapshot())).toEqual(sansOutbox(before)); // approval posts NOTHING (stock, valuation, events, journals unchanged)
    // post
    const { r, rep } = await postAndDispatch(b1);
    expect(r.posted).toBe(true);
    expect(r.view.state).toBe('posted');
    expect(rep.status).toBe('posted');
    expect(r.view.lines.every((l) => l.isActive && l.stockMovementId)).toBe(true);
    expect(await posOf(ids.A.wh, ids.A.p1)).toEqual([10, '50.0000']);
    expect(await posOf(ids.A.wh, ids.A.p2)).toEqual([4, '10.0000']);
    const evs = await eventsFor(b1);
    expect(evs.map((e) => [e.glKind, e.status, e.eventDate]).sort()).toEqual([['opening_stock', 'POSTED', D3], ['opening_stock', 'POSTED', D3]]);
    const jl = await Promise.all(evs.map(async (e) => (await lines(e.journalEntryId!)).join(' | ')));
    expect(jl.sort()).toEqual(['1120 D 10.00 | 3105 C 10.00', '1120 D 50.00 | 3105 C 50.00']);
    for (const e of evs) expect(await journalDate(e.journalEntryId!)).toBe(D3);
    expect((await valuationRows()).filter((x) => x.kind === 'receipt').map((x) => x.d).sort()).toEqual([D3, D3, daysFrom(0)].sort()); // two openings dated at the cut-off (+ the P4 receipt, today)
    expect(await glInventory(daysFrom(-4))).toBe('0.0000');
    expect(await glInventory(D3)).toBe('60.0000');
    for (const asOf of [daysFrom(-4), D3, today]) {
      const p = (await recon.preview({ asOfDate: asOf }, m)) as Loose;
      expect([asOf, p.status, p.driftBase]).toEqual([asOf, 'matched', '0.0000']);
    }
  });

  it('4. IDEMPOTENT and LOCKED: a second post is a no-op, parallel posts write one effect, the database refuses a second ACTIVE opening for a pair, and a new opening for a locked pair is refused', async () => {
    const m = await asManager();
    const snap = await snapshot();
    const again = await batches.post(b1, maker, m);
    expect(again.posted).toBe(false);
    expect(await snapshot()).toEqual(snap);
    // parallel posts of a fresh approved batch (WH3: P5 2 @ 1.50 = 3.00)
    const rows: Array<[string, number, string]> = [[ids.A.p5, 2, '1.50']];
    const par = await draft(ids.A.wh3, rows);
    await approveBatch(par.batch.id, totalsOf(rows));
    const stock0 = await cnt('A', 'stock_movements');
    const res = await Promise.allSettled([batches.post(par.batch.id, maker, m), batches.post(par.batch.id, maker, m)]);
    expect(res.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(res.filter((x) => x.status === 'fulfilled' && (x as PromiseFulfilledResult<{ posted: boolean }>).value.posted)).toHaveLength(1);
    expect(await cnt('A', 'stock_movements')).toBe(stock0 + 1);
    await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: par.batch.id }]);
    expect(await eventsFor(par.batch.id)).toHaveLength(1);
    // database-level guarantee: a second ACTIVE line for the same pair violates the partial unique index
    await expect(m.query(`INSERT INTO inventory_opening_batch_lines ("batchId","warehouseId","productId","quantity","lineValueBase","isActive") VALUES ($1,$2,$3,1,'1.0000',true)`, [par.batch.id, ids.A.wh3, ids.A.p5])).rejects.toThrow(/duplicate key|UQ_inv_opening_line_active_pair/);
    // after the lock: another opening for P1/WH is refused at submit
    const dup = await draft(ids.A.wh, [[ids.A.p1, 1, '5.00']]);
    await expect(batches.submit(dup.batch.id, totalsOf([[ids.A.p1, 1, '5.00']]), maker, m)).rejects.toThrow(/already has an active opening line/);
    expect(await stateOf(dup.batch.id)).toBe('draft');
  });

  it('5. REJECTION: a rejected batch returns to draft and posts nothing', async () => {
    const m = await asManager();
    const rows: Array<[string, number, string]> = [[ids.A.p9, 1, '2.00']];
    const v = await draft(ids.A.wh3, rows);
    const before = await snapshot();
    const submitted = await batches.submit(v.batch.id, totalsOf(rows), maker, m);
    await approvals.decide(submitted.batch.approvalRequestId!, approver1, 'rejected', 'not now', m);
    expect(await stateOf(v.batch.id)).toBe('draft');
    expect(sansOutbox(await snapshot())).toEqual(sansOutbox(before));
    await expect(batches.post(v.batch.id, maker, m)).rejects.toThrow(/must be approved/);
  });

  it('6. POST FAILURE is atomic and recoverable: a closed period, activity that appeared after approval, and a failure half-way through leave NOTHING written; the retry posts once', async () => {
    const m = await asManager();
    // (a) the period of the cut-off is closed after approval
    const a: Array<[string, number, string]> = [[ids.A.p8, 3, '2.00']];
    const va = await draft(ids.A.wh3, a, daysFrom(-1));
    await approveBatch(va.batch.id, totalsOf(a));
    await setPeriod(periodIds.open, 'closed');
    const s1 = await snapshot();
    await expect(batches.post(va.batch.id, maker, m)).rejects.toThrow(/not open/);
    expect(await snapshot()).toEqual(s1);
    expect(await stateOf(va.batch.id)).toBe('approved');
    await setPeriod(periodIds.open, 'open');
    expect((await postAndDispatch(va.batch.id)).rep.status).toBe('posted');
    expect(await posOf(ids.A.wh3, ids.A.p8)).toEqual([3, '6.0000']);
    // (b) activity appears on the pair AFTER approval: the post re-validates and refuses the WHOLE batch
    const b: Array<[string, number, string]> = [[ids.A.p6, 1, '2.00'], [ids.A.p7, 1, '2.00']];
    const vb = await draft(ids.A.wh3, b);
    await approveBatch(vb.batch.id, totalsOf(b));
    await inventory.recordManualReceipt(ids.A.wh3, ids.A.p7, 1, '1.00', 'FOUND_STOCK', null, maker, m);
    await dispatch.dispatchAndReport(m, []);
    const s2 = await snapshot();
    await expect(batches.post(vb.batch.id, maker, m)).rejects.toThrow(/already has stock activity/);
    expect(await snapshot()).toEqual(s2); // the untouched line of the batch was NOT posted either
    expect(await stockOf(ids.A.wh3, ids.A.p6)).toBe(0);
    // (c) failure half-way: the second line's movement throws -> the first line's movement is rolled back too
    const c: Array<[string, number, string]> = [[ids.A.p10, 2, '2.00'], [ids.A.p11, 2, '2.00']];
    const vc = await draft(ids.A.wh3, c);
    await approveBatch(vc.batch.id, totalsOf(c));
    const real = inventory.recordMovement.bind(inventory);
    let calls = 0;
    const spy = jest.spyOn(inventory, 'recordMovement').mockImplementation(async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated failure on the second line');
      return real(...args);
    });
    const s3 = await snapshot();
    try {
      await expect(batches.post(vc.batch.id, maker, m)).rejects.toThrow(/simulated failure/);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot()).toEqual(s3);
    expect(await stateOf(vc.batch.id)).toBe('approved');
    expect((await m.query(`SELECT count(*)::int AS n FROM inventory_opening_batch_lines WHERE "batchId" = $1 AND ("isActive" OR "stockMovementId" IS NOT NULL)`, [vc.batch.id]))[0].n).toBe(0);
    // retry: posts once
    expect((await postAndDispatch(vc.batch.id)).rep.status).toBe('posted');
    expect(await posOf(ids.A.wh3, ids.A.p10)).toEqual([2, '4.0000']);
    expect(await posOf(ids.A.wh3, ids.A.p11)).toEqual([2, '4.0000']);
  });

  it('7. REVERSAL of an UNTOUCHED opening (WH2): same two-approver gate, Dr opening / Cr inventory at the ORIGINAL values, the original is reversed and its pairs are eligible again; a MOVED pair cannot be reversed', async () => {
    const m = await asManager();
    const rows: Array<[string, number, string]> = [[ids.A.p1, 3, '4.00'], [ids.A.p2, 2, '6.00']];
    const r1 = await draft(ids.A.wh2, rows);
    await approveBatch(r1.batch.id, totalsOf(rows));
    expect((await postAndDispatch(r1.batch.id)).rep.status).toBe('posted');
    expect(await posOf(ids.A.wh2, ids.A.p1)).toEqual([3, '12.0000']);
    expect(await posOf(ids.A.wh2, ids.A.p2)).toEqual([2, '12.0000']);
    // reversal batch: reason required, same approval gate with the `.correct` node
    await expect(batches.createReversalBatch(r1.batch.id, { cutOffDate: daysFrom(-1), reason: '  ' }, maker, m)).rejects.toThrow(/written reason/);
    const rev = await batches.createReversalBatch(r1.batch.id, { cutOffDate: daysFrom(-1), reason: 'wrong cost entered' }, maker, m);
    expect(rev.batch.kind).toBe('reversal');
    expect(rev.batch.reversalOfBatchId).toBe(r1.batch.id);
    const sub = await batches.submit(rev.batch.id, null, maker, m);
    await approvals.decide(sub.batch.approvalRequestId!, approver1, 'approved', null, m);
    await approvals.decide(sub.batch.approvalRequestId!, approver2, 'approved', null, m);
    const out = await postAndDispatch(rev.batch.id);
    expect(out.rep.status).toBe('posted');
    expect(await stateOf(rev.batch.id)).toBe('posted');
    expect(await stateOf(r1.batch.id)).toBe('reversed');
    expect(await posOf(ids.A.wh2, ids.A.p1)).toEqual([0, '0.0000']);
    expect(await posOf(ids.A.wh2, ids.A.p2)).toEqual([0, '0.0000']);
    expect(await stockOf(ids.A.wh2, ids.A.p1)).toBe(0);
    const revEvents = await eventsFor(rev.batch.id);
    expect(revEvents.map((e) => [e.glKind, e.status, e.eventDate]).sort()).toEqual([['opening_reversal', 'POSTED', daysFrom(-1)], ['opening_reversal', 'POSTED', daysFrom(-1)]]);
    expect((await Promise.all(revEvents.map(async (e) => (await lines(e.journalEntryId!)).join(' | ')))).sort()).toEqual(['1120 C 12.00 | 3105 D 12.00', '1120 C 12.00 | 3105 D 12.00']);
    expect((await m.query(`SELECT count(*)::int AS n FROM inventory_opening_batch_lines WHERE "batchId" = $1 AND "isActive"`, [r1.batch.id]))[0].n).toBe(0);
    // the pairs are eligible again: a CORRECTED opening posts
    const fixed: Array<[string, number, string]> = [[ids.A.p1, 3, '4.50']];
    const r2 = await draft(ids.A.wh2, fixed);
    await approveBatch(r2.batch.id, totalsOf(fixed));
    expect((await postAndDispatch(r2.batch.id)).rep.status).toBe('posted');
    expect(await posOf(ids.A.wh2, ids.A.p1)).toEqual([3, '13.5000']);
    // a MOVED pair: open P3 (WH), dispatch 2, then the reversal is refused (and a refused reversal changes nothing)
    const mrows: Array<[string, number, string]> = [[ids.A.p3, 10, '3.00']];
    const mb = await draft(ids.A.wh, mrows);
    await approveBatch(mb.batch.id, totalsOf(mrows));
    expect((await postAndDispatch(mb.batch.id)).rep.status).toBe('posted');
    await inventory.recordMovement(ids.A.wh, ids.A.p3, -2, 'dispatch', 'sales_order', randomUUID(), maker, m);
    await dispatch.dispatchAndReport(m, []);
    expect(await posOf(ids.A.wh, ids.A.p3)).toEqual([8, '24.0000']); // 10 @ 3.00 less 2 at the average 3.00 (COGS 6.00)
    moved = mb.batch.id;
    const badRev = await batches.createReversalBatch(mb.batch.id, { cutOffDate: daysFrom(-1), reason: 'try' }, maker, m);
    const s = await snapshot();
    await expect(batches.submit(badRev.batch.id, null, maker, m)).rejects.toThrow(/later stock movements.*correction batch/);
    expect(await snapshot()).toEqual(s);
  });

  it('8. CORRECTION AFTER STOCK HAS MOVED (O-1): an approved, traceable batch posts to the EQUITY correction account and never touches profit and loss; unsafe corrections are refused', async () => {
    const m = await asManager();
    const sCfg = config['accounting.inventory_opening_correction_account_code'];
    // unset / not equity -> refused at submit, nothing written
    delete config['accounting.inventory_opening_correction_account_code'];
    const c0 = await batches.createCorrectionBatch(moved, { cutOffDate: daysFrom(-1), reason: 'add 2 units', lines: [{ productId: ids.A.p3, deltaQuantity: 2, unitCostBase: '3.00' }] }, maker, m);
    await expect(batches.submit(c0.batch.id, null, maker, m)).rejects.toThrow(/not configured/);
    config['accounting.inventory_opening_correction_account_code'] = '4201'; // a revenue account: a correction must never go through P&L
    await expect(batches.submit(c0.batch.id, null, maker, m)).rejects.toThrow(/not equity/);
    config['accounting.inventory_opening_correction_account_code'] = sCfg;
    // refused shapes
    await expect(batches.createCorrectionBatch(moved, { cutOffDate: daysFrom(-1), reason: 'x', lines: [{ productId: ids.A.p4, deltaQuantity: 1, unitCostBase: '1.00' }] }, maker, m)).rejects.toThrow(/not a line of the original batch/);
    await expect(batches.createCorrectionBatch(moved, { cutOffDate: daysFrom(-1), reason: 'x', lines: [{ productId: ids.A.p3, deltaQuantity: 0 }] }, maker, m)).rejects.toThrow(/non-zero/);
    await expect(batches.createCorrectionBatch(moved, { cutOffDate: daysFrom(-1), reason: 'x', lines: [{ productId: ids.A.p3, deltaQuantity: 2 }] }, maker, m)).rejects.toThrow(/positive unit cost/);
    const over = await batches.createCorrectionBatch(moved, { cutOffDate: daysFrom(-1), reason: 'too much', lines: [{ productId: ids.A.p3, deltaQuantity: -20 }] }, maker, m);
    await expect(batches.submit(over.batch.id, null, maker, m)).rejects.toThrow(/fewer are on hand/);
    // +2 @ 3.00 (value 6.00): Dr 1120 / Cr 3110
    const up = await approveAndPostCorrection(c0.batch.id);
    expect(up.status).toBe('posted');
    expect(await posOf(ids.A.wh, ids.A.p3)).toEqual([10, '30.0000']);
    const [ue] = await eventsFor(c0.batch.id);
    expect([ue.glKind, ue.eventDate]).toEqual(['opening_correction', daysFrom(-1)]);
    expect(await lines(ue.journalEntryId!)).toEqual(['1120 D 6.00', '3110 C 6.00']);
    // -1 at the moving average (30.00 / 10 = 3.00): Dr 3110 / Cr 1120 3.00
    const c1 = await batches.createCorrectionBatch(moved, { cutOffDate: daysFrom(-1), reason: 'one unit too many', lines: [{ productId: ids.A.p3, deltaQuantity: -1 }] }, maker, m);
    expect((await approveAndPostCorrection(c1.batch.id)).status).toBe('posted');
    expect(await posOf(ids.A.wh, ids.A.p3)).toEqual([9, '27.0000']);
    const [de] = await eventsFor(c1.batch.id);
    expect(await lines(de.journalEntryId!)).toEqual(['1120 C 3.00', '3110 D 3.00']);
    // traceability and P&L: both corrections reference the original, the reason is recorded, and no profit-and-loss account carries a correction line
    expect((await m.query(`SELECT count(*)::int AS n FROM inventory_opening_batches WHERE "reversalOfBatchId" = $1 AND kind = 'correction' AND reason IS NOT NULL`, [moved]))[0].n).toBeGreaterThanOrEqual(2);
    expect((await m.query(`SELECT count(*)::int AS n FROM accounting_journal_lines jl JOIN accounting_journal_entries je ON je.id = jl."journalEntryId" JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE je.description LIKE 'Opening correction%' AND ga."accountType" IN ('revenue','expense')`))[0].n).toBe(0);
    expect(await stateOf(moved)).toBe('posted'); // the original opening is not rewritten
  });

  async function approveAndPostCorrection(batchId: string) {
    const m = await asManager();
    const v = await batches.submit(batchId, null, maker, m);
    await expect(approvals.decide(v.batch.approvalRequestId!, maker, 'approved', null, m)).rejects.toThrow(/segregation of duties/);
    await approvals.decide(v.batch.approvalRequestId!, approver1, 'approved', null, m);
    await approvals.decide(v.batch.approvalRequestId!, approver2, 'approved', null, m);
    return (await postAndDispatch(batchId)).rep;
  }

  it('9. The CUT-OVER FLAG: off = the legacy import and the `opening_balance` reason keep working; on = the legacy import is refused and the reason is reserved for batches', async () => {
    const m = await asManager();
    flagOn(false);
    const ok = await inventory.importOpeningStockRows([{ warehouseCode: 'WH-A', productSku: 'C4-P12', quantity: '1', unitCost: '1.00' }], maker, m);
    expect(ok.succeeded).toHaveLength(1);
    await inventory.recordManualReceipt(ids.A.wh, ids.A.p4, 1, '1.00', 'opening_balance', null, maker, m);
    flagOn(true);
    const s = await snapshot();
    await expect(inventory.importOpeningStockRows([{ warehouseCode: 'WH-A', productSku: 'C4-P13', quantity: '1', unitCost: '1.00' }], maker, m)).rejects.toThrow(/Opening Balance Batch/);
    await expect(inventory.recordManualReceipt(ids.A.wh, ids.A.p4, 1, '1.00', 'opening_balance', null, maker, m)).rejects.toThrow(/reserved for Opening Balance Batches/);
    expect(await snapshot()).toEqual(s);
    flagOn(false);
    await dispatch.dispatchAndReport(m, []);
  });

  it('10. ROW / EXCEL import into a DRAFT: valid rows form the draft, invalid rows are returned with row numbers and are not in it; no valid row = no batch; scope hides other warehouses', async () => {
    const m = await asManager();
    const before = await snapshot();
    const res = await batches.createDraftFromRows(
      [
        { warehouseCode: 'WH3-A', productSku: 'C4-P14', quantity: '5', unitCost: '2.00' },
        { warehouseCode: 'WH3-A', productSku: 'NOPE', quantity: '5', unitCost: '2.00' },
        { warehouseCode: 'WH3-A', productSku: 'C4-P15', quantity: '0', unitCost: '2.00' },
        { warehouseCode: 'WH3-A', productSku: 'C4-P15', quantity: '3', unitCost: '' },
        { warehouseCode: 'WH-A', productSku: 'C4-P15', quantity: '3', unitCost: '2.00' },
        { warehouseCode: 'WH3-A', productSku: 'C4-P14', quantity: '1', unitCost: '2.00' },
        { warehouseCode: 'WH3-A', productSku: 'C4-P15', quantity: '2', unitCost: '3.00' },
      ],
      { cutOffDate: D3 },
      maker,
      m,
    );
    expect(res.draft!.lines.map((l) => [l.quantity, l.unitCostBase]).sort()).toEqual([[2, '3.0000'], [5, '2.0000']].sort());
    expect(res.rejected.map((r) => r.row)).toEqual([3, 4, 5, 6, 7]);
    expect(res.rejected[0].errors[0]).toMatch(/SKU "NOPE" was not found/);
    expect(res.rejected[3].errors[0]).toMatch(/a batch is one warehouse/i);
    expect(res.rejected[4].errors[0]).toMatch(/appears twice/);
    expect(res.draft!.state).toBe('draft');
    const none = await batches.createDraftFromRows([{ warehouseCode: 'WH3-A', productSku: 'NOPE', quantity: '1', unitCost: '1.00' }], { cutOffDate: D3 }, maker, m);
    expect(none.draft).toBeNull();
    const hidden = await batches.createDraftFromRows([{ warehouseCode: 'WH3-A', productSku: 'C4-P14', quantity: '1', unitCost: '1.00' }], { cutOffDate: D3 }, maker, m, [ids.A.wh]);
    expect(hidden.draft).toBeNull();
    expect(hidden.rejected[0].errors[0]).toMatch(/Warehouse Code "WH3-A" was not found/);
    const after = await snapshot();
    expect(after.stock).toBe(before.stock);
    expect(after.journals).toBe(before.journals);
  });

  it('11. The HTTP controller: the maker cannot decide, the override needs its own permission, a post reports the GL truth; reads are scope-filtered', async () => {
    const dsA = await dsOf('A');
    let allowed = new Set<string>();
    const contexts = { forRequest: async () => ({ hasAtLeast: (node: string) => allowed.has(node) }) } as never;
    const scopes = { forRequest: async () => ({}), visibleWarehouseIds: async () => visible } as never;
    let visible: 'ALL' | string[] = 'ALL';
    const ctl = new OpeningBatchController(batches, scopes, contexts, approvals, {} as never, dispatch);
    const rq = (user: string) => ({ user: { id: user }, companyContext: { dataSource: dsA } }) as never;
    // override without the permission is refused before anything is created
    const s = await snapshot();
    await expect(ctl.create(rq(maker), { warehouseId: ids.A.wh3, cutOffDate: D3, lines: [{ productId: ids.A.p16, quantity: 1, unitCostBase: '1.00' }], allowExistingActivity: true, overrideReason: 'x' } as never)).rejects.toThrow();
    expect(await snapshot()).toEqual(s);
    allowed = new Set(['inventory.opening_batch.override']);
    const rows: Array<[string, number, string]> = [[ids.A.p16, 1, '1.00']];
    const created = (await ctl.create(rq(maker), { warehouseId: ids.A.wh3, cutOffDate: D3, lines: rows.map(([productId, quantity, unitCostBase]) => ({ productId, quantity, unitCostBase })), allowExistingActivity: true, overrideReason: 'documented exception' } as never)) as { batch: { id: string; allowExistingActivity: boolean } };
    expect(created.batch.allowExistingActivity).toBe(true);
    const sub = (await ctl.submit(rq(maker), created.batch.id, totalsOf(rows) as never)) as { batch: { approvalRequestId: string } };
    await expect(ctl.decide(rq(maker), created.batch.id, { decision: 'approved' } as never)).rejects.toThrow(/segregation of duties/);
    await ctl.decide(rq(approver1), created.batch.id, { decision: 'approved' } as never);
    await ctl.decide(rq(approver2), created.batch.id, { decision: 'approved' } as never);
    expect(sub.batch.approvalRequestId).toBeTruthy();
    const posted = (await ctl.post(rq(maker), created.batch.id)) as { posted: boolean; financialPosting: { status: string } };
    expect([posted.posted, posted.financialPosting.status]).toEqual([true, 'posted']);
    expect(((await ctl.post(rq(maker), created.batch.id)) as { posted: boolean }).posted).toBe(false); // idempotent at the API too
    visible = [ids.A.wh];
    expect((await ctl.list(rq(maker))).every((x: { batch: { warehouseId: string } }) => x.batch.warehouseId === ids.A.wh)).toBe(true);
    visible = 'ALL';
  });

  it('12. CONSISTENCY and COMPANY ISOLATION: valuation = GL at every checkpoint, every event POSTED, journals balanced, history consistent, Company B untouched, Platform DataSource not needed for it', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    expect([p.status, p.classification, p.driftBase]).toEqual(['matched', 'matched', '0.0000']);
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
    expect((await dsA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n).toBe(0);
    expect(await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`)).toEqual([]);
    expect(Number((await dsA.query(`SELECT coalesce(sum("onHandQuantity"),0)::text AS q FROM inventory_valuation_state`))[0].q)).toBe(Number((await dsA.query(`SELECT coalesce(sum(quantity),0)::text AS q FROM stock_movements`))[0].q));
    // the lines of every posted opening batch that is not reversed are active exactly once per pair
    expect(await dsA.query(`SELECT "warehouseId","productId",count(*)::int AS n FROM inventory_opening_batch_lines WHERE "isActive" GROUP BY 1,2 HAVING count(*) > 1`)).toEqual([]);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await recon.preview({}, dsA.manager);
      await batches.list(dsA.manager);
    });
    for (const t of ['stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'inventory_opening_batches', 'inventory_opening_batch_lines']) {
      expect({ t, n: await cnt('B', t) }).toEqual({ t, n: 0 });
    }
    expect(await batches.list(dsB.manager)).toEqual([]);
    expect(((await recon.preview({}, dsB.manager)) as Loose).classification).toBe('matched');
  });
});
