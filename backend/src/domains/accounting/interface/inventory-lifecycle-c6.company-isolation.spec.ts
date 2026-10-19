import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../inventory-warehouse/application/warehouse-transactions.service';
import { InventoryAdjustmentService } from '../application/inventory-adjustment.service';
import { InventoryPostingDispatchService } from '../../inventory-warehouse/application/inventory-posting-dispatch.service';
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
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
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

describe('Inventory lifecycle C6 - F07 / D3 coexistence: value-only adjustments move the valuation atomically, quantity changes stay with D3 documents, physical_count_variance retirement - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let adjustments: InventoryAdjustmentService;
  let whTx: WarehouseTransactionsService;
  let approvals: ApprovalEngineService;
  let ambient: DataSource;
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
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '4201', opening_balance: '3105' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
    'accounting.inventory_f07_updates_valuation': false,
    'accounting.inventory_physical_count_variance': 'allowed',
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c6', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    const dsAuth = await dsOf('A');
    whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, new AuthorizationService(dsAuth.getRepository(Role), dsAuth.getRepository(UserRole)), audit, products, inventory, policyRegistry, valuation as never, cfg);
    adjustments = new InventoryAdjustmentService(ambient, approvals, financialEvents, handlerRegistry, events, audit, valuation as never, cfg);
    await adjustments.onModuleInit();

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    for (let i = 1; i <= 16; i++) ids.A[`p${i}`] = (await products.createProduct(`C4-P${i}`, `Product ${i}`, '10.00', actor, null, dsA.manager)).id;
    // every user of the test Company carries the admin role; the four opening-batch nodes are granted to it so the live permission check of FA-01 can resolve them
    const role = (await dsA.query(`SELECT id FROM roles WHERE key = 'admin'`))[0];
    for (const node of ['accounting.inventory.adjust', 'accounting.inventory.approve', 'inventory.warehouse_tx.submit', 'inventory.warehouse_tx.approve', 'inventory.warehouse_tx.post']) {
      await dsA.query(`INSERT INTO role_permissions ("roleId","nodeKey","access") VALUES ($1,$2,'editable') ON CONFLICT DO NOTHING`, [role.id, node]);
    }
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch((e) => console.warn('C4 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
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
  const pos = async (wh: string, p: string) => {
    const r = (await valuation.getValuedPositions(undefined, { warehouseIds: [wh], productId: p }, (await dsOf('A')).manager))[0];
    return r ? [r.quantity, r.totalValueBase, r.averageCostBase] : [0, '0.0000', null];
  };
  const asManager = async () => (await dsOf('A')).manager;
  const f07Events = async () =>
    (await (await dsOf('A')).query(
      `SELECT fe.id, fe.status, fe."rejectionReason", fe."journalEntryId", fe."idempotencyKey", fe.payload->>'valuationEffect' AS ve, fe.payload->>'kind' AS kind, fe."transactionCurrencyCode" AS cur
         FROM accounting_financial_events fe WHERE fe."eventType" = 'accounting.inventory.adjustment.approved' ORDER BY fe."receivedAt"`,
    )) as Array<{ id: string; status: string; rejectionReason: string | null; journalEntryId: string | null; idempotencyKey: string; ve: string | null; kind: string; cur: string }>;
  const revalRows = async () => (await (await dsOf('A')).query(`SELECT "valueDeltaBase"::text AS v, "quantityAfterValueBase"::text AS after, "averageCostAfterBase"::text AS avg, "businessDate"::text AS d FROM inventory_valuation_movements WHERE kind = 'revaluation' ORDER BY "createdAt", id`)) as Array<{ v: string; after: string; avg: string; d: string }>;
  const D3 = daysFrom(-3);
  let wh = '';
  let p1 = '';
  const flagUpdates = (on: boolean) => {
    config['accounting.inventory_f07_updates_valuation'] = on;
  };

  /** submit a F07 value adjustment, two distinct approvers decide, the approval posts it (events dispatched with the Company manager) */
  async function f07(kind: 'valuation_write_down' | 'physical_count_variance', amount: string, over: Partial<{ productId: string | null; warehouseId: string | null; direction: 'debit' | 'credit'; businessDate: string }> = {}) {
    const m = await asManager();
    const sub = await adjustments.submitAdjustment({ kind, amount, reason: 'c6 test', counterAccountCode: '5201', productId: 'productId' in over ? over.productId : p1, warehouseId: 'warehouseId' in over ? over.warehouseId : wh, direction: over.direction, businessDate: over.businessDate }, maker, m);
    await adjustments.decide(sub.approvalRequestId, approver1, 'approved', undefined, m);
    await adjustments.decide(sub.approvalRequestId, approver2, 'approved', undefined, m);
    return sub.approvalRequestId;
  }

  // ==========================================================================================================================================================
  // C6 (ADR-INV-05). Hand-computed chain on one position (WH / P1). GL = 1120, valuation = moving-average state; "drift" = valuation minus GL.
  //  S0  manual receipt 10 @ 5.00                         valuation 10 u / 50.0000, GL 50.00
  //  S1  F07 write-down 4.00, flag OFF (legacy, GL only)   valuation 50.0000, GL 46.00 -> drift +4.00 = the legacy F07 category (explained)
  //  S2  F07 write-down 6.00, flag ON                      valuation 44.0000 (avg 4.4000), GL 40.00 -> drift STILL +4.00 (the new entry moves both sides)
  //  S3  F07 write-up   2.00, flag ON                      valuation 46.0000 (avg 4.6000), GL 42.00
  //  S4  F07 write-down 1.00 while the period is CLOSED     rolled back whole; after reopening + re-drive: valuation 45.0000 (avg 4.5000), GL 41.00
  //  S5  D3 adjustment document -2 units at the average    -9.0000 -> 8 u / 36.0000 (avg 4.5000), GL 32.00  (quantity-only)
  //  S6  F07 write-down 3.00, flag ON on the same pair      8 u / 33.0000 (avg 4.1250), GL 29.00             (combined: quantity by D3, value by F07)
  // ==========================================================================================================================================================
  it('0. SETUP: 10 units received at 5.00 -> valuation 50.0000 = GL 50.00', async () => {
    const m = await asManager();
    wh = ids.A.wh;
    p1 = ids.A.p1;
    await inventory.recordManualReceipt(wh, p1, 10, '5.00', 'FOUND_STOCK', null, maker, m);
    await dispatch.dispatchAndReport(m, []);
    expect(await pos(wh, p1)).toEqual([10, '50.0000', '5.0000']);
    expect(await glInventory()).toBe('50.0000');
  });

  it('1. flag OFF = the pre-C6 behaviour: an approved write-down posts to the GL only; reconciliation itemises it as "F07 without valuation effect" (explained, unexplained 0)', async () => {
    const m = await asManager();
    flagUpdates(false);
    await f07('valuation_write_down', '4.00');
    const [e] = await f07Events();
    expect([e.status, e.ve]).toEqual(['POSTED', 'false']);
    expect(await lines(e.journalEntryId!)).toEqual(['1120 C 4.00', '5201 D 4.00']);
    expect(await pos(wh, p1)).toEqual([10, '50.0000', '5.0000']); // valuation untouched
    expect(await glInventory()).toBe('46.0000');
    expect(await revalRows()).toEqual([]);
    const p = (await recon.preview({}, m)) as Loose;
    expect([p.status, p.classification, p.driftBase, p.unexplainedBase]).toEqual(['drift_found', 'explained', '4.0000', '0.0000']);
    expect(p.analysis.categories.find((c: Loose) => c.code === 'f07_without_valuation_effect')).toMatchObject({ amountBase: '4.0000', count: 1 });
  });

  it('2. flag ON: a write-down moves the valuation AND the ledger in ONE posting - valuation 44.0000 / GL 40.00, the legacy difference stays exactly 4.00, the new entry is NOT counted as "without valuation effect"', async () => {
    const m = await asManager();
    flagUpdates(true);
    await f07('valuation_write_down', '6.00', { businessDate: D3 });
    const evs = await f07Events();
    const e = evs[1];
    expect([e.status, e.ve, e.cur]).toEqual(['POSTED', 'true', evs[0].cur]); // same currency as the legacy entry: the Company base, nothing hard-coded
    expect(await lines(e.journalEntryId!)).toEqual(['1120 C 6.00', '5201 D 6.00']);
    expect(await pos(wh, p1)).toEqual([10, '44.0000', '4.4000']);
    expect(await glInventory()).toBe('40.0000');
    expect(await revalRows()).toEqual([{ v: '-6.0000', after: '44.0000', avg: '4.4000', d: D3 }]); // append-only history row, dated by the business date
    const p = (await recon.preview({}, m)) as Loose;
    expect([p.status, p.classification, p.driftBase, p.unexplainedBase]).toEqual(['drift_found', 'explained', '4.0000', '0.0000']);
    expect(p.analysis.categories.find((c: Loose) => c.code === 'f07_without_valuation_effect')).toMatchObject({ amountBase: '4.0000', count: 1 });
    expect(p.analysis.f07Entries).toHaveLength(1); // only the legacy entry is listed
    expect(await valuation.checkHistoryConsistency(m)).toEqual([]);
    // as-of: before the business date the position is untouched, from it the revaluation is in
    expect((await valuation.getValuedPositions(daysFrom(-4), { warehouseIds: [wh] }, m)).map((x) => x.totalValueBase)).toEqual([]); // the receipt itself is dated today
  });

  it('3. a write-up is allowed; submissions that cannot be priced are refused BEFORE any FA-01 request (no product/warehouse, no stock, a write-down above the value)', async () => {
    const m = await asManager();
    const requests = async () => Number((await m.query(`SELECT count(*) AS n FROM approval_requests WHERE "requestTypeCode" LIKE 'accounting.inventory.%'`))[0].n);
    const r0 = await requests();
    await expect(adjustments.submitAdjustment({ kind: 'valuation_write_down', amount: '1.00', reason: 'x', counterAccountCode: '5201' }, maker, m)).rejects.toThrow(/must name its product and warehouse/);
    await expect(adjustments.submitAdjustment({ kind: 'valuation_write_down', amount: '1.00', reason: 'x', counterAccountCode: '5201', productId: ids.A.p2, warehouseId: wh }, maker, m)).rejects.toThrow(/no valued stock/);
    await expect(adjustments.submitAdjustment({ kind: 'valuation_write_down', amount: '45.00', reason: 'x', counterAccountCode: '5201', productId: p1, warehouseId: wh }, maker, m)).rejects.toThrow(/exceeds the current value 44\.0000/);
    expect(await requests()).toBe(r0);
    await f07('valuation_write_down', '2.00', { direction: 'debit' });
    expect(await pos(wh, p1)).toEqual([10, '46.0000', '4.6000']);
    expect(await glInventory()).toBe('42.0000');
    // a position whose quantity went back to zero cannot be revalued
    await inventory.recordManualReceipt(wh, ids.A.p3, 1, '1.00', 'FOUND_STOCK', null, maker, m);
    await dispatch.dispatchAndReport(m, []);
    await inventory.recordMovement(wh, ids.A.p3, -1, 'dispatch', 'sales_order', randomUUID(), maker, m);
    await dispatch.dispatchAndReport(m, []);
    await expect(adjustments.submitAdjustment({ kind: 'valuation_write_down', amount: '0.50', reason: 'x', counterAccountCode: '5201', productId: ids.A.p3, warehouseId: wh }, maker, m)).rejects.toThrow(/no valued stock/);
    // both approvers are required: one decision does not post
    const sub = await adjustments.submitAdjustment({ kind: 'valuation_write_down', amount: '0.10', reason: 'two approvers', counterAccountCode: '5201', productId: p1, warehouseId: wh }, maker, m);
    await adjustments.decide(sub.approvalRequestId, approver1, 'approved', undefined, m);
    expect((await f07Events()).length).toBe(3); // legacy + S2 + S3 only
    await adjustments.decide(sub.approvalRequestId, approver2, 'rejected', undefined, m);
    expect((await f07Events()).length).toBe(3);
    expect(await pos(wh, p1)).toEqual([10, '46.0000', '4.6000']);
  });

  it('4. ATOMIC and fail-closed: a closed period rolls the revaluation back with the refused posting (event REJECTED, valuation and GL unchanged); after reopening, the re-drive posts it exactly once; re-drives and replays add nothing', async () => {
    const m = await asManager();
    const before = await snapshot();
    await setPeriod(periodIds.open, 'closed');
    await f07('valuation_write_down', '1.00');
    const rejected = (await f07Events()).filter((e) => e.status === 'REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].rejectionReason).toMatch(/not open|period/i);
    expect(await pos(wh, p1)).toEqual([10, '46.0000', '4.6000']); // the revaluation made inside the handler was rolled back
    expect(await glInventory()).toBe('42.0000');
    expect((await revalRows()).length).toBe(2); // S2 and S3 only
    expect((await snapshot()).journals).toBe(before.journals);
    await setPeriod(periodIds.open, 'open');
    expect((await financialEvents.redrive(rejected[0].id, m)).status).toBe('POSTED');
    expect(await pos(wh, p1)).toEqual([10, '45.0000', '4.5000']);
    expect(await glInventory()).toBe('41.0000');
    expect((await financialEvents.redrive(rejected[0].id, m)).deduped).toBe(true); // a duplicate re-drive is a no-op
    const journals = (await snapshot()).journals;
    // replaying the revaluation itself with the same key never applies it twice
    const replay = await valuation.applyRevaluation!(p1, wh, '-1.0000', rejected[0].idempotencyKey, m);
    expect(replay).toEqual({ valueBase: '-1.0000' });
    expect(await pos(wh, p1)).toEqual([10, '45.0000', '4.5000']);
    expect((await snapshot()).journals).toBe(journals);
    expect(await valuation.checkHistoryConsistency(m)).toEqual([]);
    // engine-level fail-closed answers (no mutation)
    expect(await valuation.applyRevaluation!(p1, wh, '-99.0000', 'c6:below-zero', m)).toEqual({ rejected: 'value_below_zero' });
    expect(await valuation.applyRevaluation!(randomUUID(), wh, '-1.0000', 'c6:no-state', m)).toEqual({ rejected: 'no_valuation_source' });
    expect(await pos(wh, p1)).toEqual([10, '45.0000', '4.5000']);
  });

  it('5. QUANTITY-only change goes through a D3 document (stock + valuation + ledger together); COMBINED with a value-only F07 write-down on the same position the books stay equal and the legacy difference stays 4.00', async () => {
    const m = await asManager();
    // a physical COUNT: the system says 10, the shelf holds 8 -> a variance of -2 units (the D3 count document computes it; nobody types an amount)
    const doc = await whTx.startCount(wh, [p1], maker, m);
    const countLines = await whTx.getLines(doc.id, m);
    await whTx.recordCountResults(doc.id, [{ lineId: countLines[0].id, physicalQuantity: 8 }], m);
    await whTx.transition(doc.id, 'submit', maker, m);
    expect((await whTx.transition(doc.id, 'approve', approver1, m))).toBe('posted');
    await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: doc.id }]);
    expect(await pos(wh, p1)).toEqual([8, '36.0000', '4.5000']); // -2 at the average 4.5000 = -9.0000
    expect(await glInventory()).toBe('32.0000');
    let p = (await recon.preview({}, m)) as Loose;
    expect([p.status, p.classification, p.driftBase]).toEqual(['drift_found', 'explained', '4.0000']);
    // value-only on the same position afterwards
    await f07('valuation_write_down', '3.00');
    expect(await pos(wh, p1)).toEqual([8, '33.0000', '4.1250']);
    expect(await glInventory()).toBe('29.0000');
    p = (await recon.preview({}, m)) as Loose;
    expect([p.status, p.classification, p.driftBase, p.unexplainedBase]).toEqual(['drift_found', 'explained', '4.0000', '0.0000']);
    expect(await valuation.checkHistoryConsistency(m)).toEqual([]);
  });

  it('6. RETIREMENT of the free-typed physical_count_variance (flag): allowed = today, warn = accepted + audited, refused = 409 pointing to the documents with nothing created; history is untouched', async () => {
    const m = await asManager();
    const requests = async () => Number((await m.query(`SELECT count(*) AS n FROM approval_requests WHERE "requestTypeCode" = 'accounting.inventory.physical_count_variance'`))[0].n);
    const legacyBefore = (await f07Events())[0];
    const audits = async () => Number((await m.query(`SELECT count(*) AS n FROM audit_records WHERE action = 'accounting.inventory.physical_count_variance_deprecated_submission'`))[0].n);
    config['accounting.inventory_physical_count_variance'] = 'allowed';
    const r0 = await requests();
    await adjustments.submitAdjustment({ kind: 'physical_count_variance', amount: '1.00', reason: 'legacy', counterAccountCode: '5201' }, maker, m);
    expect([await requests(), await audits()]).toEqual([r0 + 1, 0]);
    config['accounting.inventory_physical_count_variance'] = 'warn';
    await adjustments.submitAdjustment({ kind: 'physical_count_variance', amount: '1.00', reason: 'warned', counterAccountCode: '5201' }, maker, m);
    expect([await requests(), await audits()]).toEqual([r0 + 2, 1]);
    config['accounting.inventory_physical_count_variance'] = 'refused';
    await expect(adjustments.submitAdjustment({ kind: 'physical_count_variance', amount: '1.00', reason: 'refused', counterAccountCode: '5201' }, maker, m)).rejects.toThrow(/stock count \/ adjustment document/);
    expect([await requests(), await audits()]).toEqual([r0 + 2, 1]); // nothing created, nothing audited by the refusal
    // the value-only kind is NOT affected by the retirement
    await f07('valuation_write_down', '0.50');
    expect(await pos(wh, p1)).toEqual([8, '32.5000', '4.0625']);
    config['accounting.inventory_physical_count_variance'] = 'allowed';
    // history preserved: the legacy event is byte-for-byte what it was
    const legacyAfter = (await f07Events())[0];
    expect(legacyAfter).toEqual(legacyBefore);
    expect(await lines(legacyAfter.journalEntryId!)).toEqual(['1120 C 4.00', '5201 D 4.00']);
  });

  it('7. CONSISTENCY and COMPANY ISOLATION: every F07 event POSTED or the one deliberate rejection re-driven, journals balanced, history consistent, difference = the legacy 4.00 only; Company B untouched', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    expect((await dsA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n).toBe(0);
    expect(await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`)).toEqual([]);
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    expect([p.driftBase, p.unexplainedBase, p.classification]).toEqual(['4.0000', '0.0000', 'explained']);
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await recon.preview({}, dsA.manager);
    });
    for (const t of ['stock_movements', 'inventory_valuation_state', 'inventory_valuation_movements', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'approval_requests']) {
      expect({ t, n: await cnt('B', t) }).toEqual({ t, n: 0 });
    }
    expect(((await recon.preview({}, dsB.manager)) as Loose).classification).toBe('matched');
  });
});
