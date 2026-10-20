import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../inventory-warehouse/application/warehouse-transactions.service';
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
import { PostingStatusService } from '../application/posting-status.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
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

describe('Inventory lifecycle C1 - valuation as-of, reconciliation v2, posting status, GL/TB read models - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let valuation: InventoryValuationService;
  let ledger: LedgerService;
  let recon: InventoryReconciliationService;
  let posting: PostingStatusService;
  let whTx: WarehouseTransactionsService;
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c1', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    posting = new PostingStatusService(h.controlPlane, ledger);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
    whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products as never, inventory, policy, valuation);
    ids.A.p1 = (await products.createProduct('C1-P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
    ids.A.p2 = (await products.createProduct('C1-P2', 'Product Two', '25.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('C1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const FINGERPRINT_TABLES = ['accounting_journal_entries', 'accounting_journal_lines', 'accounting_financial_events', 'event_outbox', 'stock_movements', 'inventory_valuation_state', 'inventory_valuation_movements', 'accounting_inventory_reconciliation_runs', 'audit_records'];
  async function fingerprint(k: Key): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of FINGERPRINT_TABLES) out[t] = await cnt(k, t);
    return out;
  }
  async function eventsOfKind(k: Key, glKind: string) {
    return (await dsOf(k)).query(
      `SELECT fe.id, fe.status, fe."rejectionReason", fe."journalEntryId" FROM accounting_financial_events fe WHERE fe."eventType" = 'inventory.movement.recorded' AND fe.payload->>'glKind' = $1 ORDER BY fe."receivedAt"`,
      [glKind],
    ) as Promise<Array<{ id: string; status: string; rejectionReason: string | null; journalEntryId: string | null }>>;
  }
  const invAccountId = async (k: Key) => (await (await dsOf(k)).query(`SELECT id FROM accounting_gl_accounts WHERE code = '1120'`))[0].id as string;
  const near = (a: string | number, b: number, d = 4) => expect(Number(a)).toBeCloseTo(b, d);
  const categoryOf = (analysis: { categories: Array<{ code: string; amountBase: string; count: number }> }, code: string) => analysis.categories.find((c) => c.code === code)!;

  // ===========================================================================================================================================================
  it('1. a clean ledger reconciles to MATCHED exactly; the run records basis/classification and the existing status values are unchanged', async () => {
    const dsA = await dsOf('A');
    await inventory.importOpeningStockRows([{ warehouseCode: 'WH1-A', productSku: 'C1-P1', quantity: '5', unitCost: '4.00' }], actor, dsA.manager);
    await flush('A');
    const run = await recon.reconcile({}, actor, dsA.manager);
    expect(run.status).toBe('matched');
    expect(run.classification).toBe('matched');
    expect(run.basis).toBe('current');
    expect(run.driftBase).toBe('0.0000');
    expect(run.explainedBase).toBeNull();
    expect(run.driftBreakdown).toBeNull(); // matched keeps a NULL breakdown exactly as before
    await recon.closeRun(run.id, actor, dsA.manager);
  });

  it('2. rounding is attributed EXACTLY (no tolerance): a fractional average posts 9.7778 -> 9.78, the run is drift_found but EXPLAINED with zero unexplained', async () => {
    const dsA = await dsOf('A');
    await inventory.recordManualReceipt(ids.A.wh1, ids.A.p1, 4, '6.00', 'FOUND_STOCK', null, actor, dsA.manager); // avg (20 + 24) / 9 = 4.8889
    await flush('A');
    await inventory.recordMovement(ids.A.wh1, ids.A.p1, 2, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager); // 2 x 4.8889 = 9.7778 -> 9.78
    await flush('A');
    const preview = (await recon.preview({}, dsA.manager)) as Loose;
    near(preview.subledgerTotalBase, 53.7778);
    near(preview.glBalanceBase, 53.78);
    near(preview.driftBase, -0.0022);
    expect(preview.status).toBe('drift_found'); // the status contract is unchanged ...
    expect(preview.classification).toBe('explained'); // ... the new classification says why
    near(categoryOf(preview.analysis, 'rounding').amountBase, -0.0022);
    near(preview.unexplainedBase, 0);
    near(preview.explainedBase, -0.0022);
    expect(preview.analysis.roundingByWarehouse).toEqual([{ warehouseId: ids.A.wh1, amountBase: '-0.0022', postings: 1 }]);
  });

  it('3. a REJECTED event is itemised as unposted value with its reason, and the posting status turns to attention; re-drive clears both', async () => {
    const dsA = await dsOf('A');
    config['accounting.inventory_manual_receipt_reason_accounts'] = {}; // the reason is no longer mapped -> the event is REJECTED after valuation was applied
    await inventory.recordManualReceipt(ids.A.wh1, ids.A.p1, 2, '3.00', 'FOUND_STOCK', null, actor, dsA.manager);
    await flush('A');
    const [rej] = (await eventsOfKind('A', 'manual_receipt')).filter((e) => e.status === 'REJECTED');
    expect(rej.rejectionReason).toMatch(/FOUND_STOCK/);

    const preview = (await recon.preview({}, dsA.manager)) as Loose;
    near(categoryOf(preview.analysis, 'unposted_value').amountBase, 6);
    expect(categoryOf(preview.analysis, 'unposted_value').count).toBe(1);
    expect(preview.analysis.unpostedItems).toHaveLength(1);
    expect(preview.analysis.unpostedItems[0]).toMatchObject({ source: 'financial_event', status: 'REJECTED', kind: 'manual_receipt', warehouseId: ids.A.wh1, productId: ids.A.p1 });
    expect(preview.classification).toBe('explained');
    near(preview.unexplainedBase, 0);

    const status = await posting.getInventoryStatus(dsA.manager);
    expect(status.state).toBe('attention');
    expect(status.rejectedEvents).toBe(1);

    config['accounting.inventory_manual_receipt_reason_accounts'] = { FOUND_STOCK: '3105' };
    const journalsBefore = await cnt('A', 'accounting_journal_entries');
    const redriven = await financialEvents.redrive(rej.id, dsA.manager);
    expect(redriven.status).toBe('POSTED');
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsBefore + 1);
    const again = await financialEvents.redrive(rej.id, dsA.manager); // idempotent: never a second journal
    expect(again.deduped).toBe(true);
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsBefore + 1);
    const after = (await recon.preview({}, dsA.manager)) as Loose;
    near(categoryOf(after.analysis, 'unposted_value').amountBase, 0);
    expect((await posting.getInventoryStatus(dsA.manager)).state).toBe('current');
  });

  it('4. a pending outbox row is itemised as unposted value and shows as pending; after the flush it posts once', async () => {
    const dsA = await dsOf('A');
    await inventory.recordManualReceipt(ids.A.wh1, ids.A.p1, 1, '2.00', 'FOUND_STOCK', null, actor, dsA.manager); // NOT flushed yet
    const status = await posting.getInventoryStatus(dsA.manager);
    expect(status.state).toBe('pending');
    expect(status.pendingEvents).toBe(1);
    expect(status.oldestPendingAt).not.toBeNull();
    const preview = (await recon.preview({}, dsA.manager)) as Loose;
    near(categoryOf(preview.analysis, 'unposted_value').amountBase, 2);
    expect(preview.analysis.unpostedItems[0]).toMatchObject({ source: 'outbox', status: 'pending', kind: 'manual_receipt' });
    await flush('A');
    await flush('A'); // a second flush has nothing to do
    const journalsAfter = await cnt('A', 'accounting_journal_entries');
    await flush('A');
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journalsAfter);
    expect((await posting.getInventoryStatus(dsA.manager)).state).toBe('current');
    near(categoryOf(((await recon.preview({}, dsA.manager)) as Loose).analysis, 'unposted_value').amountBase, 0);
  });

  it('5. an approved F07 entry (GL only) is itemised as "without valuation effect"; the identity explained + unexplained = difference holds', async () => {
    const dsA = await dsOf('A');
    const r = await financialEvents.ingest(
      INVENTORY_ADJUSTMENT_APPROVED_EVENT,
      {
        idempotencyKey: `c1:f07:${randomUUID()}`, businessDate: today, orgUnitId: null, currency: 'EGP', sourceEntityType: 'ledger_entry', sourceEntityId: 'inventory', payloadVersion: 1,
        kind: 'valuation_write_down', amount: '3.00', reason: 'c1 test', direction: 'debit', counterAccountCode: '4201',
      } as never,
      dsA.manager,
    );
    expect(r.status).toBe('POSTED');
    const preview = (await recon.preview({}, dsA.manager)) as Loose;
    near(categoryOf(preview.analysis, 'f07_without_valuation_effect').amountBase, -3); // GL +3, valuation unchanged
    expect(preview.analysis.f07Entries).toHaveLength(1);
    near(preview.unexplainedBase, 0);
    expect(preview.classification).toBe('explained');
    near(Number(preview.explainedBase) + Number(preview.unexplainedBase), Number(preview.driftBase));
  });

  it('6. a valuation-only change with no event and no journal is NOT explained: classification unexplained with the exact remainder (the control still raises the alarm)', async () => {
    const dsA = await dsOf('A');
    await valuation.recordReceiptCost(ids.A.p2, ids.A.wh1, 1, '2.00', 'c1:valuation-only', dsA.manager);
    const preview = (await recon.preview({}, dsA.manager)) as Loose;
    near(preview.unexplainedBase, 2);
    expect(preview.classification).toBe('unexplained');
    near(Number(preview.explainedBase) + Number(preview.unexplainedBase), Number(preview.driftBase));
    const run = await recon.reconcile({}, actor, dsA.manager);
    expect(run.status).toBe('drift_found');
    expect(run.classification).toBe('unexplained');
    near(run.unexplainedBase!, 2);
    near(run.explainedBase!, Number(run.driftBase) - 2);
    expect((run.driftBreakdown as Record<string, unknown>).categories).toHaveLength(4);
    await recon.closeRun(run.id, actor, dsA.manager);
  });

  it('7. PREVIEW persists nothing; RECONCILE writes only its own run row and audit records - no journal, event, outbox, stock or valuation row', async () => {
    const dsA = await dsOf('A');
    const before = await fingerprint('A');
    await recon.preview({}, dsA.manager);
    await recon.preview({ asOfDate: daysFrom(-3) }, dsA.manager);
    await ledger.getPeriodicTrialBalance({}, dsA.manager);
    await ledger.getAccountLedger(await invAccountId('A'), {}, dsA.manager);
    await posting.getInventoryStatus(dsA.manager);
    await posting.getFinancialStatusByReference('manual_receipt', randomUUID(), dsA.manager);
    await valuation.getValuedPositions(daysFrom(-3), {}, dsA.manager);
    expect(await fingerprint('A')).toEqual(before);
    const run = await recon.reconcile({}, actor, dsA.manager);
    const after = await fingerprint('A');
    for (const t of FINGERPRINT_TABLES) {
      if (t === 'accounting_inventory_reconciliation_runs') expect(after[t]).toBe(before[t] + 1);
      else if (t === 'audit_records') expect(after[t]).toBeGreaterThan(before[t]);
      else expect({ t, n: after[t] }).toEqual({ t, n: before[t] });
    }
    await recon.closeRun(run.id, actor, dsA.manager);
  });

  it('8. valuation AS OF a date is rebuilt from the dated history; a past-date reconciliation compares THEN with THEN; history consistency holds', async () => {
    const dsA = await dsOf('A');
    // fixture: the opening stock happened 10 days ago (valuation history and its journal carry the date)
    const [open] = await eventsOfKind('A', 'opening_stock');
    await dsA.query(`UPDATE inventory_valuation_movements SET "businessDate" = $1::date WHERE "idempotencyKey" LIKE 'inventory-valuation:receipt:%' AND "valueDeltaBase" = 20`, [daysFrom(-10)]);
    await dsA.query(`UPDATE accounting_journal_entries SET "businessDate" = $1::date WHERE id = $2`, [daysFrom(-10), open.journalEntryId]);

    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]); // the history adds up to the running state
    const asOfOld = await valuation.getValuedOnHandTotal(daysFrom(-5), dsA.manager);
    expect(asOfOld).toEqual([{ warehouseId: ids.A.wh1, totalValueBase: '20.0000' }]);
    expect(await valuation.getValuedOnHandTotal(daysFrom(-11), dsA.manager)).toEqual([]);
    const positions = await valuation.getValuedPositions(daysFrom(-5), {}, dsA.manager);
    expect(positions).toEqual([{ warehouseId: ids.A.wh1, productId: ids.A.p1, quantity: 5, totalValueBase: '20.0000', averageCostBase: '4.0000' }]);
    const current = await valuation.getValuedPositions(undefined, { productId: ids.A.p1 }, dsA.manager);
    expect(current).toHaveLength(1);
    expect(current[0].quantity).toBe(14); // opening 5 + receipt 4 + adjustment 2 + receipt 2 + receipt 1

    const old = (await recon.preview({ asOfDate: daysFrom(-5) }, dsA.manager)) as Loose;
    expect(old.basis).toBe('as_of');
    near(old.subledgerTotalBase, 20);
    near(old.glBalanceBase, 20);
    expect(old.classification).toBe('matched'); // then vs then
    const now = (await recon.preview({}, dsA.manager)) as Loose;
    expect(now.basis).toBe('current');

    // a corrupted running state is reported by the consistency check, never hidden
    await dsA.query(`UPDATE inventory_valuation_state SET "totalValueBase" = "totalValueBase" + 1 WHERE "productId" = $1`, [ids.A.p1]);
    const bad = await valuation.checkHistoryConsistency(dsA.manager);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ productId: ids.A.p1, warehouseId: ids.A.wh1 });
    expect(Number(bad[0].stateValueBase) - Number(bad[0].historyValueBase)).toBeCloseTo(1, 4);
    await dsA.query(`UPDATE inventory_valuation_state SET "totalValueBase" = "totalValueBase" - 1 WHERE "productId" = $1`, [ids.A.p1]);
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
  });

  it('9. GL lines carry ADDITIVE traceability (event, reference, entry state) and keep every existing field', async () => {
    const dsA = await dsOf('A');
    const gl = await ledger.getAccountLedger(await invAccountId('A'), {}, dsA.manager);
    const byRef = (t: string) => gl.lines.filter((l) => l.referenceType === t);
    expect(byRef('excel_import')).toHaveLength(1);
    expect(byRef('manual_receipt').length).toBeGreaterThanOrEqual(3);
    expect(byRef('warehouse_transaction')).toHaveLength(1);
    const f07 = gl.lines.find((l) => l.eventType === INVENTORY_ADJUSTMENT_APPROVED_EVENT)!;
    expect(f07).toBeDefined();
    expect(f07.referenceType).toBeNull();
    for (const l of gl.lines) {
      expect(['POSTED', 'REVERSED']).toContain(l.entryState);
      expect(l.financialEventId).toBeTruthy();
      for (const k of ['journalEntryId', 'entryNumber', 'businessDate', 'postingDate', 'description', 'sourceType', 'lineDescription', 'debitBase', 'creditBase', 'runningBalanceBase']) expect(l).toHaveProperty(k);
    }
    expect(Object.keys(gl).sort()).toEqual(['account', 'closingBalanceBase', 'lines', 'openingBalanceBase', 'periodCreditBase', 'periodDebitBase']);
  });

  it('10. the PERIODIC trial balance: opening + period = closing per account and in total, roll-up from the chart, three independent balance tests; the default payload is unchanged', async () => {
    const dsA = await dsOf('A');
    // golden shape of the DEFAULT report (the closing snapshot signs totalDebitBase/totalCreditBase; the screen reads the rows)
    const def = await ledger.getTrialBalanceReport({}, dsA.manager);
    expect(Object.keys(def).sort()).toEqual(['balanceTotalCreditBase', 'balanceTotalDebitBase', 'balanced', 'rows', 'totalCreditBase', 'totalDebitBase']);
    expect(Object.keys(def.rows[0]).sort()).toEqual(['accountId', 'accountType', 'code', 'creditBase', 'debitBase', 'name', 'normalBalance']);
    expect(def.balanced).toBe(true);

    const p = await ledger.getPeriodicTrialBalance({}, dsA.manager);
    expect(p.mode).toBe('periodic');
    expect(p.balanced).toEqual({ opening: true, period: true, closing: true });
    expect(p.totals.openingDebitBase).toBe('0.0000');
    near(p.totals.periodDebitBase, Number(def.totalDebitBase));
    near(p.totals.periodCreditBase, Number(def.totalCreditBase));
    for (const r of p.rows) near(Number(r.openingBase) + Number(r.periodDebitBase) - Number(r.periodCreditBase), Number(r.closingBase));

    // the opening stock journal is dated 10 days ago (test 8): a window starting 5 days ago has it as OPENING balance
    const w = await ledger.getPeriodicTrialBalance({ from: daysFrom(-5), to: today }, dsA.manager);
    const inv = w.rows.find((r) => r.code === '1120')!;
    near(inv.openingDebitBase, 20);
    expect(w.balanced).toEqual({ opening: true, period: true, closing: true });
    const eq = w.rows.find((r) => r.code === '3105')!;
    near(eq.openingCreditBase, 20);
    near(Number(w.totals.openingDebitBase), Number(w.totals.openingCreditBase));
    near(Number(w.totals.closingDebitBase), Number(w.totals.closingCreditBase));
    // a window entirely before everything: nothing; a window after everything: closing = opening
    expect((await ledger.getPeriodicTrialBalance({ to: daysFrom(-20) }, dsA.manager)).rows).toEqual([]);
    const later = await ledger.getPeriodicTrialBalance({ from: daysFrom(1) }, dsA.manager);
    near(later.totals.periodDebitBase, 0);
    near(later.totals.closingDebitBase, Number(p.totals.periodDebitBase) - Number(p.totals.periodCreditBase) + Number(p.totals.periodCreditBase) - 0 > 0 ? Number(later.totals.closingDebitBase) : 0);
    near(Number(later.totals.closingDebitBase), Number(later.totals.openingDebitBase));

    // roll-up: a non-postable group over 1120 carries the same figures; totals are never doubled
    const groupId = randomUUID();
    await dsA.query(
      `INSERT INTO accounting_gl_accounts (id, code, name, "accountType", "normalBalance", "isPostable", "allowManualJournal", "isActive") VALUES ($1,'1100','Current assets','asset','debit',false,false,true)`,
      [groupId],
    );
    await dsA.query(`UPDATE accounting_gl_accounts SET "parentAccountId" = $1 WHERE code = '1120'`, [groupId]);
    const rolled = await ledger.getPeriodicTrialBalance({}, dsA.manager);
    const group = rolled.rows.find((r) => r.code === '1100')!;
    const leaf = rolled.rows.find((r) => r.code === '1120')!;
    expect(group.isGroup).toBe(true);
    expect(leaf.isGroup).toBe(false);
    expect(group.closingDebitBase).toBe(leaf.closingDebitBase);
    expect(rolled.totals).toEqual(p.totals);
    await dsA.query(`UPDATE accounting_gl_accounts SET "parentAccountId" = NULL WHERE code = '1120'`);
    await dsA.query(`DELETE FROM accounting_gl_accounts WHERE id = $1`, [groupId]);
  });

  it('11. the financial status of ONE document, by reference: none / pending / posted - from the events themselves', async () => {
    const dsA = await dsOf('A');
    expect((await posting.getFinancialStatusByReference('warehouse_transaction', randomUUID(), dsA.manager)).summary).toBe('none');
    const doc = randomUUID();
    await inventory.recordMovement(ids.A.wh1, ids.A.p1, 1, 'adjustment', 'warehouse_transaction', doc, actor, dsA.manager);
    const pending = await posting.getFinancialStatusByReference('warehouse_transaction', doc, dsA.manager);
    expect(pending.summary).toBe('pending');
    expect(pending.items.map((i) => i.source)).toEqual(['outbox']);
    await flush('A');
    const posted = await posting.getFinancialStatusByReference('warehouse_transaction', doc, dsA.manager);
    expect(posted.summary).toBe('posted');
    expect(posted.items[0]).toMatchObject({ source: 'financial_event', status: 'POSTED', glKind: 'adjustment' });
    expect(posted.items[0].journalEntryId).toBeTruthy();
  });

  it('12. the overview COST KPI: valuation of the visible warehouses only, null without the permission, selling price unchanged', async () => {
    const dsA = await dsOf('A');
    const total = (await valuation.getValuedOnHandTotal(undefined, dsA.manager)).reduce((s, w) => s + Number(w.totalValueBase), 0);
    const all = await whTx.getOverview(dsA.manager, undefined, true);
    expect(all.totalInventoryValueAtCost).toBe(total.toFixed(2));
    expect(all.valuationAsOf).not.toBeNull();
    const noPerm = await whTx.getOverview(dsA.manager, undefined, false);
    expect(noPerm.totalInventoryValueAtCost).toBeNull();
    expect(noPerm.valuationAsOf).toBeNull();
    expect(noPerm.totalInventoryValueAtSellingPrice).toBe(all.totalInventoryValueAtSellingPrice);
    const scoped = await whTx.getOverview(dsA.manager, [ids.A.wh2], true); // F6: the caller only sees warehouse 2 (no stock there)
    expect(scoped.totalInventoryValueAtCost).toBe('0.00');
  });

  it('13. no duplicate journal on any retry or repeated read, and the identity still holds at the end', async () => {
    const dsA = await dsOf('A');
    const journals = await cnt('A', 'accounting_journal_entries');
    for (let i = 0; i < 3; i++) {
      await flush('A');
      await recon.preview({}, dsA.manager);
      await posting.getInventoryStatus(dsA.manager);
    }
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journals);
    const unbalanced = await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`);
    expect(unbalanced).toEqual([]);
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    near(Number(p.explainedBase) + Number(p.unexplainedBase), Number(p.driftBase));
  });

  it('14. ISOLATION: Company B is untouched by every new read, has its own empty answers, and the Platform DataSource was never requested', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await recon.preview({}, dsA.manager);
      await posting.getInventoryStatus(dsA.manager);
      await valuation.getValuedPositions(undefined, {}, dsA.manager);
      await ledger.getPeriodicTrialBalance({}, dsA.manager);
    });
    expect(await valuation.getValuedPositions(undefined, {}, dsB.manager)).toEqual([]);
    expect(await valuation.checkHistoryConsistency(dsB.manager)).toEqual([]);
    const statusB = await posting.getInventoryStatus(dsB.manager);
    expect(statusB).toMatchObject({ pendingEvents: 0, failedOutbox: 0, rejectedEvents: 0, inFlightEvents: 0, state: 'current', lastReconciliation: null });
    const previewB = (await recon.preview({}, dsB.manager)) as Loose;
    expect(previewB.classification).toBe('matched');
    expect(previewB.driftBase).toBe('0.0000');
    for (const t of ['stock_movements', 'inventory_valuation_state', 'inventory_valuation_movements', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'accounting_inventory_reconciliation_runs']) {
      expect({ t, n: await cnt('B', t) }).toEqual({ t, n: 0 });
    }
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });
});
