import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InventoryValuationController } from '../../inventory-valuation/interface/inventory-valuation.controller';
import type { AccessScopeService } from '../../../foundation/scope/access-scope.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { ProductsService } from '../../commerce/application/products.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../application/financial-events/inventory-costing-handler.service';
import { handleInventoryAdjustmentApproved } from '../application/financial-events/inventory-adjustment.handler';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { LedgerService } from '../application/ledger.service';
import { InventoryReconciliationService } from '../application/inventory-reconciliation.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { INVENTORY_ADJUSTMENT_APPROVED_EVENT } from '../../../foundation/module-registry/contracts/inventory-events.contract';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Inventory lifecycle, slice C1 (CTO decisions 2026-10-17) - real PostgreSQL, Company A with Company B as the untouched witness. The full pipeline is real
 * (Company outbox -> financial events -> journals -> ledger), valuation is the real moving-average engine, and the new READ models are exercised against data that
 * contains every category the reconciliation must explain: exact rounding, a REJECTED event, a pending outbox row, an F07 entry (GL only) and a deliberately
 * UNEXPLAINED valuation-only change.
 *
 * Proves: valuation as of a date (and its history consistency check); reconciliation v2 categories with exact amounts, the explained/unexplained identity, no
 * tolerance, a past-date reconciliation that compares then with then; PREVIEW persists nothing and RECONCILE writes only its own run row (+ audit); posting status
 * (pending / attention / current) and the per-reference financial status; additive GL line fields; the periodic Trial Balance (opening / period / closing, roll-up,
 * three balance tests) while the default Trial Balance payload keeps its exact shape; the overview cost KPI with the F6 visible-warehouse filter; no duplicate
 * journal on any retry or repeated read; Company B untouched and the Platform DataSource never requested.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>; // the preview result is an open record; the assertions read its fields by name

describe('Inventory lifecycle C1 - CONTROLLED scenario: known movements, hand-computed valuation and GL, reconciliation, isolation - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let valuation: InventoryValuationService;
  let ledger: LedgerService;
  let recon: InventoryReconciliationService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '3105' },
  };
  const ids: Record<Key, { wh1: string; wh2: string; p1: string; p2: string }> = { A: { wh1: '', wh2: '', p1: '', p2: '' }, B: { wh1: '', wh2: '', p1: '', p2: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'C1 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `c1-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['3105', 'Opening Balance Equity', 'equity', 'credit', null],
      ['4201', 'Inventory Adjustment Gain', 'revenue', 'credit', null],
      ['5201', 'Inventory Adjustment Loss', 'expense', 'debit', null],
      ['5101', 'Cost of Goods Sold', 'expense', 'debit', null],
      ['2115', 'GRNI', 'liability', 'credit', 'grni'],
    ] as Array<[string, string, string, string, string | null]>) {
      await ds.query(
        `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
        [randomUUID(), code, name, type, normal, fn],
      );
    }
    const fy = randomUUID();
    const fp = randomUUID();
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${Number(year) - 1}-01-01`, `${Number(year) + 1}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${Number(year) - 1}-01-01`, `${Number(year) + 1}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    ids[k].wh1 = (await inventory.createWarehouse(`WH1-${k}`, `Main ${k}`, null, null, null, 'main', ds.manager)).id;
    ids[k].wh2 = (await inventory.createWarehouse(`WH2-${k}`, `Second ${k}`, null, null, null, 'main', ds.manager)).id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c1_ctl', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    const registry = new FinancialEventHandlerRegistry();
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, registry, cfg);
    financialEvents.onModuleInit();
    new InventoryCostingHandlerService(registry, valuation).onModuleInit();
    registry.register(INVENTORY_ADJUSTMENT_APPROVED_EVENT, handleInventoryAdjustmentApproved);

    const policy = new InventoryPostingPolicyRegistry();
    policy.bind({
      assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }),
      listManualReceiptReasons: () => ['FOUND_STOCK'],
      assertSaleReturnPostable: async () => undefined,
      assertSupplierInvoicePostable: async () => undefined,
    });
    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policy);
    ledger = new LedgerService(h.controlPlane);
    recon = new InventoryReconciliationService(h.controlPlane, ledger, audit, valuation);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    ids.A.p1 = (await products.createProduct('C1-P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
    ids.A.p2 = (await products.createProduct('C1-P2', 'Product Two', '25.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('C1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  async function eventsOfKind(k: Key, glKind: string) {
    return (await dsOf(k)).query(
      `SELECT fe.id, fe.status, fe."rejectionReason", fe."journalEntryId" FROM accounting_financial_events fe WHERE fe."eventType" = 'inventory.movement.recorded' AND fe.payload->>'glKind' = $1 ORDER BY fe."receivedAt"`,
      [glKind],
    ) as Promise<Array<{ id: string; status: string; rejectionReason: string | null; journalEntryId: string | null }>>;
  }
  const invAccountId = async (k: Key) => (await (await dsOf(k)).query(`SELECT id FROM accounting_gl_accounts WHERE code = '1120'`))[0].id as string;
  const categoryOf = (analysis: { categories: Array<{ code: string; amountBase: string; count: number }> }, code: string) => analysis.categories.find((c) => c.code === code)!;
  // ===========================================================================================================================================================
  // CONTROLLED SCENARIO (CTO closure request 2026-10-18). Every expected value below is computed BY HAND from the movements, before the run; nothing is tuned
  // to the output and no tolerance is applied. Experimental data only, in disposable databases; no shared or demo data is touched.
  //
  //   S1  opening stock  WH1 / P1  10 @ 5.00                         valuation +50.0000        GL 1120 Dr 50.00 / 3105 Cr 50.00
  //   S2  opening stock  WH2 / P2   4 @ 2.50                         valuation +10.0000        GL 1120 Dr 10.00            -> A: valuation 60.0000 = GL 60.00
  //   S3  manual receipt WH1 / P1   5 @ 8.00 (FOUND_STOCK)           P1 15 u, value 90.0000 (avg 6.0000), GL +40.00
  //   S4  adjustment     WH1 / P1  -3 at the average (6.0000)        value -18.0000, GL Cr 1120 18.00 / Dr 5201 18.00   -> B: valuation 82.0000 = GL 82.00
  //   S5  manual receipt WH2 / P2   3 @ 3.00                         P2 7 u, value 19.0000 (avg 2.714285...), GL +9.00
  //   S6  adjustment     WH2 / P2  -2 at the average                 value -(2 x 19/7) = -5.4286 (4 dp), GL posts 5.43  -> C: valuation 85.5714 vs GL 85.57
  //                                                                  difference +0.0014 = exactly the rounding of ONE posting, explained, unexplained 0
  // ===========================================================================================================================================================
  const evidence: Array<{ step: string; what: string; expected: unknown; actual: unknown; pass: boolean }> = [];
  const check = (step: string, what: string, expected: unknown, actual: unknown) => {
    const pass = isDeepStrictEqual(expected, actual); // deep equality, key order irrelevant (same notion as the assertion below)
    evidence.push({ step, what, expected, actual, pass });
    expect({ step, what, actual }).toEqual({ step, what, actual: expected });
  };
  const glBalance = async (asOf?: string) => {
    const dsA = await dsOf('A');
    return (await ledger.getAccountLedger(await invAccountId('A'), asOf ? { to: asOf } : {}, dsA.manager)).closingBalanceBase;
  };

  afterAll(() => {
    // evidence file written next to the other closure evidence (cwd is the backend folder under the regression runner)
    const fs = require('fs') as typeof import('fs'); // eslint-disable-line @typescript-eslint/no-require-imports
    const dir = 'docs/decisions/evidence-2026-10-17-inventory-c1-closure';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/controlled-scenario-results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), allPass: evidence.every((e) => e.pass), checks: evidence }, null, 2));
  });

  it('A. S1 + S2 opening stock: valuation 60.0000 = GL 60.00, reconciliation MATCHED with zero drift', async () => {
    const dsA = await dsOf('A');
    await inventory.importOpeningStockRows(
      [
        { warehouseCode: 'WH1-A', productSku: 'C1-P1', quantity: '10', unitCost: '5.00' },
        { warehouseCode: 'WH2-A', productSku: 'C1-P2', quantity: '4', unitCost: '2.50' },
      ],
      actor,
      dsA.manager,
    );
    await flush('A');
    const val = await valuation.getValuedPositions(undefined, {}, dsA.manager);
    check('A', 'valued positions', [
      { warehouseId: ids.A.wh1, productId: ids.A.p1, quantity: 10, totalValueBase: '50.0000', averageCostBase: '5.0000' },
      { warehouseId: ids.A.wh2, productId: ids.A.p2, quantity: 4, totalValueBase: '10.0000', averageCostBase: '2.5000' },
    ].sort((a, b) => (a.warehouseId < b.warehouseId ? -1 : 1)), [...val].sort((a, b) => (a.warehouseId < b.warehouseId ? -1 : 1)));
    check('A', 'GL 1120 balance', '60.0000', await glBalance());
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    check('A', 'preview status / classification / drift', ['matched', 'matched', '0.0000'], [p.status, p.classification, p.driftBase]);
  });

  it('B. S3 + S4 receipt then adjustment: P1 = 12 units, value 72.0000; valuation 82.0000 = GL 82.00, MATCHED', async () => {
    const dsA = await dsOf('A');
    await inventory.recordManualReceipt(ids.A.wh1, ids.A.p1, 5, '8.00', 'FOUND_STOCK', null, actor, dsA.manager);
    await flush('A');
    const mid = await valuation.getValuedPositions(undefined, { productId: ids.A.p1 }, dsA.manager);
    check('B', 'P1 after receipt (avg of 50 + 40 over 15 units)', { quantity: 15, totalValueBase: '90.0000', averageCostBase: '6.0000' }, { quantity: mid[0].quantity, totalValueBase: mid[0].totalValueBase, averageCostBase: mid[0].averageCostBase });
    check('B', 'GL after receipt', '100.0000', await glBalance());
    await inventory.recordMovement(ids.A.wh1, ids.A.p1, -3, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
    await flush('A');
    const end = await valuation.getValuedPositions(undefined, { productId: ids.A.p1 }, dsA.manager);
    check('B', 'P1 after the -3 adjustment', { quantity: 12, totalValueBase: '72.0000', averageCostBase: '6.0000' }, { quantity: end[0].quantity, totalValueBase: end[0].totalValueBase, averageCostBase: end[0].averageCostBase });
    check('B', 'GL after adjustment (100 - 18)', '82.0000', await glBalance());
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    check('B', 'preview status / classification / drift / subledger / GL', ['matched', 'matched', '0.0000', '82.0000', '82.0000'], [p.status, p.classification, p.driftBase, p.subledgerTotalBase, p.glBalanceBase]);
  });

  it('C. S5 + S6 fractional average: difference +0.0014 is exactly one posting rounding, EXPLAINED, unexplained 0 (no tolerance involved)', async () => {
    const dsA = await dsOf('A');
    await inventory.recordManualReceipt(ids.A.wh2, ids.A.p2, 3, '3.00', 'FOUND_STOCK', null, actor, dsA.manager);
    await flush('A');
    await inventory.recordMovement(ids.A.wh2, ids.A.p2, -2, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
    await flush('A');
    const p2 = await valuation.getValuedPositions(undefined, { productId: ids.A.p2 }, dsA.manager);
    check('C', 'P2 valuation after the -2 issue (19.0000 - 5.4286)', { quantity: 5, totalValueBase: '13.5714' }, { quantity: p2[0].quantity, totalValueBase: p2[0].totalValueBase });
    check('C', 'GL (82 + 9 - 5.43)', '85.5700', await glBalance());
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    check('C', 'subledger / GL / difference (valuation minus GL)', ['85.5714', '85.5700', '0.0014'], [p.subledgerTotalBase, p.glBalanceBase, p.driftBase]);
    check('C', 'status stays drift_found (never hidden), classification explained', ['drift_found', 'explained'], [p.status, p.classification]);
    check('C', 'explained / unexplained', ['0.0014', '0.0000'], [p.explainedBase, p.unexplainedBase]);
    const rounding = categoryOf(p.analysis, 'rounding');
    check('C', 'rounding category amount and number of postings', ['0.0014', 1], [rounding.amountBase, rounding.count]);
    check('C', 'the other categories are empty', ['0.0000', '0.0000', '0.0000'], [categoryOf(p.analysis, 'unposted_value').amountBase, categoryOf(p.analysis, 'f07_without_valuation_effect').amountBase, categoryOf(p.analysis, 'manual_or_opening_journals').amountBase]);
    check('C', 'rounding attributed to the warehouse that issued', [{ warehouseId: ids.A.wh2, amountBase: '0.0014', postings: 1 }], p.analysis.roundingByWarehouse);
    // the recorded run carries the same facts
    const run = await recon.reconcile({}, actor, dsA.manager);
    check('C', 'recorded run: status / classification / basis / drift', ['drift_found', 'explained', 'current', '0.0014'], [run.status, run.classification, run.basis, run.driftBase]);
    await recon.closeRun(run.id, actor, dsA.manager);
  });

  it('D. valuation report: by warehouse and by item, totals, history consistency', async () => {
    const dsA = await dsOf('A');
    const positions = await valuation.getValuedPositions(undefined, {}, dsA.manager);
    const byWh = Object.fromEntries(positions.map((x) => [x.warehouseId === ids.A.wh1 ? 'WH1' : 'WH2', { quantity: x.quantity, value: x.totalValueBase }]));
    check('D', 'by warehouse', { WH1: { quantity: 12, value: '72.0000' }, WH2: { quantity: 5, value: '13.5714' } }, byWh);
    check('D', 'report total (quantity, value)', [17, '85.5714'], [positions.reduce((s, x) => s + x.quantity, 0), (await valuation.getValuedOnHandTotal(undefined, dsA.manager)).reduce((s, w) => s + Math.round(Number(w.totalValueBase) * 10000), 0) / 10000 + '']);
    check('D', 'history consistency (state equals the sum of the dated history)', [], await valuation.checkHistoryConsistency(dsA.manager));
  });

  it('D2. the HTTP controller of the valuation report on the same data: grouping, totals, filters, F6 warehouse scope', async () => {
    const dsA = await dsOf('A');
    let visible: 'ALL' | string[] = 'ALL';
    const scopes = { forRequest: async () => ({}), visibleWarehouseIds: async () => visible } as unknown as AccessScopeService;
    const controller = new InventoryValuationController(valuation, scopes);
    const req = { companyContext: { dataSource: dsA } } as never;
    const slim = (r: { rows: Array<{ warehouseId: string; productId: string | null; quantity: number; totalValueBase: string }>; totals: unknown }) => ({
      rows: r.rows.map((x) => [x.warehouseId === ids.A.wh1 ? 'WH1' : 'WH2', x.productId === null ? '-' : x.productId === ids.A.p1 ? 'P1' : 'P2', x.quantity, x.totalValueBase]).sort(),
      totals: r.totals,
    });
    check('D2', 'default (by item): rows and totals', { rows: [['WH1', 'P1', 12, '72.0000'], ['WH2', 'P2', 5, '13.5714']], totals: { quantity: 17, valueBase: '85.5714' } }, slim(await controller.report(req)));
    check('D2', 'groupBy=warehouse', { rows: [['WH1', '-', 12, '72.0000'], ['WH2', '-', 5, '13.5714']], totals: { quantity: 17, valueBase: '85.5714' } }, slim(await controller.report(req, undefined, undefined, undefined, 'warehouse')));
    check('D2', 'filter warehouse WH2', { rows: [['WH2', 'P2', 5, '13.5714']], totals: { quantity: 5, valueBase: '13.5714' } }, slim(await controller.report(req, ids.A.wh2)));
    check('D2', 'filter item P1', { rows: [['WH1', 'P1', 12, '72.0000']], totals: { quantity: 12, valueBase: '72.0000' } }, slim(await controller.report(req, undefined, ids.A.p1)));
    visible = [ids.A.wh1]; // F6: the caller sees WH1 only
    check('D2', 'F6 scope: only the visible warehouse is valued and totalled', { rows: [['WH1', 'P1', 12, '72.0000']], totals: { quantity: 12, valueBase: '72.0000' } }, slim(await controller.report(req)));
    await expect(controller.report(req, ids.A.wh2)).rejects.toBeInstanceOf(NotFoundException);
    check('D2', 'naming an invisible warehouse answers 404', 'NotFoundException', 'NotFoundException');
    visible = 'ALL';
    await expect(controller.report(req, undefined, undefined, '2026-13-xx')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.report(req, undefined, undefined, undefined, 'bogus')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.report(req, 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    check('D2', 'invalid asOf / groupBy / warehouseId answer 400', 'BadRequestException x3', 'BadRequestException x3');
    const asOfToday = await controller.report(req, undefined, undefined, today, 'warehouse');
    check('D2', 'asOf = today is the current basis', ['current', null], [asOfToday.basis, asOfToday.historyInconsistencies]);
  });

  it('E. valuation AS OF a past date compares then with then (fixture: S1 and S2 dated 10 days ago, valuation and journals alike)', async () => {
    const dsA = await dsOf('A');
    const opening = await eventsOfKind('A', 'opening_stock');
    const when = daysFrom(-10);
    await dsA.query(`UPDATE inventory_valuation_movements SET "businessDate" = $1::date WHERE "idempotencyKey" LIKE 'inventory-valuation:receipt:%' AND "valueDeltaBase" IN (50, 10)`, [when]);
    for (const e of opening) await dsA.query(`UPDATE accounting_journal_entries SET "businessDate" = $1::date WHERE id = $2`, [when, e.journalEntryId]);
    const asOf = daysFrom(-5);
    const positions = await valuation.getValuedPositions(asOf, {}, dsA.manager);
    check('E', `valued positions as of ${asOf}`, [{ quantity: 10, totalValueBase: '50.0000' }, { quantity: 4, totalValueBase: '10.0000' }].sort((a, b) => a.quantity - b.quantity), positions.map((x) => ({ quantity: x.quantity, totalValueBase: x.totalValueBase })).sort((a, b) => a.quantity - b.quantity));
    check('E', 'GL as of the same date', '60.0000', await glBalance(asOf));
    const p = (await recon.preview({ asOfDate: asOf }, dsA.manager)) as Loose;
    check('E', 'as-of preview basis / status / classification / drift', ['as_of', 'matched', 'matched', '0.0000'], [p.basis, p.status, p.classification, p.driftBase]);
    check('E', 'before anything existed', [], await valuation.getValuedPositions(daysFrom(-11), {}, dsA.manager));
  });

  it('F. NEGATIVE CONTROL (a fault injected on purpose into the isolated database): a valuation change with no event and no journal is NOT hidden', async () => {
    const dsA = await dsOf('A');
    await valuation.recordReceiptCost(ids.A.p1, ids.A.wh1, 1, '1.00', 'c1-closure:negative-control', dsA.manager); // valuation +1.0000, GL untouched
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    check('F', 'difference now', '1.0014', p.driftBase);
    check('F', 'explained (rounding only) / unexplained (the injected 1.0000)', ['0.0014', '1.0000'], [p.explainedBase, p.unexplainedBase]);
    check('F', 'classification', 'unexplained', p.classification);
  });

  it('G. isolation and integrity: Company B untouched, Platform DataSource never requested, no unbalanced journal, retries create no journal', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    const journals = await cnt('A', 'accounting_journal_entries');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await flush('A');
      await flush('A');
      await recon.preview({}, dsA.manager);
      await valuation.getValuedPositions(undefined, {}, dsA.manager);
    });
    check('G', 'journal count after repeated flushes and reads', journals, await cnt('A', 'accounting_journal_entries'));
    check('G', 'unbalanced journals', [], await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`));
    const bRows: Record<string, number> = {};
    for (const t of ['stock_movements', 'inventory_valuation_state', 'inventory_valuation_movements', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'accounting_inventory_reconciliation_runs']) bRows[t] = await cnt('B', t);
    check('G', 'Company B row counts (all zero)', { stock_movements: 0, inventory_valuation_state: 0, inventory_valuation_movements: 0, accounting_financial_events: 0, accounting_journal_entries: 0, event_outbox: 0, accounting_inventory_reconciliation_runs: 0 }, bRows);
    check('G', 'Company B reconciliation and valuation answers', ['matched', '0.0000', []], [((await recon.preview({}, dsB.manager)) as Loose).classification, ((await recon.preview({}, dsB.manager)) as Loose).driftBase, await valuation.getValuedPositions(undefined, {}, dsB.manager)]);
    check('G', 'Platform event_outbox rows', 0, Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n));
  });
});
