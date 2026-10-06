import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { ProductsService } from '../../commerce/application/products.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../application/financial-events/inventory-costing-handler.service';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * D3 (2026-10-04, CTO-approved inventory posting policy) — real-Postgres proof, Company A with Company B as the
 * untouched witness. Model A: ONE central Inventory control account (1120). The full GL pipeline is real (D10
 * Company outbox → Company manager → Company GL); valuation is the real moving-average engine; the ambient
 * (control-plane) connection has only `core` tables and an inert outbox.
 *
 * Proves: opening stock → GL (configured offset); adjustment ± → GL at the moving-average cost (configured gain/loss);
 * transfer A→B → NO GL and valuation carried (total unchanged); return-in → a financial event exists and is REJECTED
 * with the D4 reason (no invented account); every account fail-closed (unset config ⇒ REJECTED, valuation NOT mutated,
 * re-drivable); and the reconciliation  Σ inventory valuation = GL Inventory control account.
 */
describe('D3 — inventory movement posting (Model A) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';

  const config: Record<string, string> = {
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
  };
  const ids: Record<Key, { wh1: string; wh2: string; product: string }> = { A: { wh1: '', wh2: '', product: '' }, B: { wh1: '', wh2: '', product: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seedChartAndPeriod(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'D3 Operator',$2) ON CONFLICT DO NOTHING`, [actor, `d3-${k}@test.local`]);
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
    await ds.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await ds.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
    ids[k].wh1 = (await inventory.createWarehouse(`WH1-${k}`, `Main ${k}`, null, null, null, 'main', ds.manager)).id;
    ids[k].wh2 = (await inventory.createWarehouse(`WH2-${k}`, `Second ${k}`, null, null, null, 'main', ds.manager)).id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd3_inv_posting', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });

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

    const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    const registry = new FinancialEventHandlerRegistry();
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, registry, cfg);
    financialEvents.onModuleInit();
    new InventoryCostingHandlerService(registry, valuation).onModuleInit();

    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never);

    await seedChartAndPeriod('A');
    await seedChartAndPeriod('B');
    const dsA = await dsOf('A');
    ids.A.product = (await products.createProduct('P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D3 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);

  async function eventsOf(k: Key, glKind: string) {
    const ds = await dsOf(k);
    return ds.query(
      `SELECT fe.status, fe."rejectionReason", fe."journalEntryId", fe.id FROM "accounting_financial_events" fe
        WHERE fe."eventType" = 'inventory.movement.recorded' AND fe.payload->>'glKind' = $1 ORDER BY fe."receivedAt"`,
      [glKind],
    ) as Promise<Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null; id: string }>>;
  }
  async function lines(k: Key, journalEntryId: string): Promise<string[]> {
    const ds = await dsOf(k);
    const rows: Array<{ code: string; dr: string; cr: string }> = await ds.query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    );
    return rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  }
  async function valuationByWarehouse(k: Key): Promise<Record<string, { qty: number; value: number }>> {
    const ds = await dsOf(k);
    const rows: Array<{ warehouseId: string; q: string; v: string }> = await ds.query(`SELECT "warehouseId", "onHandQuantity"::text AS q, "totalValueBase"::text AS v FROM "inventory_valuation_state"`);
    return Object.fromEntries(rows.map((r) => [r.warehouseId, { qty: Number(r.q), value: Number(r.v) }]));
  }
  const totalValuation = async (k: Key) => Object.values(await valuationByWarehouse(k)).reduce((s, w) => s + w.value, 0);
  async function glInventoryBalance(k: Key): Promise<number> {
    const ds = await dsOf(k);
    const r = await ds.query(`SELECT coalesce(sum(jl."debitBase" - jl."creditBase"), 0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = '1120'`);
    return Number(r[0].b);
  }
  const journalCount = async (k: Key) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "accounting_journal_entries"`))[0].n);
  const stockOnHand = async (k: Key, warehouseId: string) => Number((await (await dsOf(k)).query(`SELECT coalesce(sum(quantity),0)::text AS q FROM "stock_movements" WHERE "warehouseId" = $1`, [warehouseId]))[0].q);

  it('1. OPENING STOCK → GL: Dr Inventory / Cr the CONFIGURED opening-balance account for qty × supplied cost; valuation bootstrapped', async () => {
    const dsA = await dsOf('A');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      const r = await inventory.importOpeningStockRows([{ warehouseCode: 'WH1-A', productSku: 'P1', quantity: '10', unitCost: '4.00' }], actor, dsA.manager);
      expect(r.rejected).toEqual([]);
      await flush('A');
    });
    const [e] = await eventsOf('A', 'opening_stock');
    expect(e.status).toBe('POSTED');
    expect(await lines('A', e.journalEntryId!)).toEqual(['1120 D 40.00', '3105 C 40.00']);
    expect((await valuationByWarehouse('A'))[ids.A.wh1]).toEqual({ qty: 10, value: 40 });
  });

  it('2. PURCHASE RECEIPT (GR) is NOT re-published by D3 — its own GRNI event posts it (Dr Inventory / Cr GRNI), valuation +60', async () => {
    const dsA = await dsOf('A');
    const grId = randomUUID();
    await inventory.recordMovement(ids.A.wh1, ids.A.product, 10, 'receipt', 'goods_receipt', grId, actor, dsA.manager, '6.00');
    await dsA.manager.transaction(async (m) => {
      await events.publish(m, 'procurement.goods_receipt.posted', {
        idempotencyKey: `d3:gr:${grId}`, businessDate: today, orgUnitId: null, currency: 'EGP', sourceEntityType: 'goods_receipt', sourceEntityId: grId, grNumber: 'GR-D3', totalValueBase: '60.00',
      });
    });
    await flush('A');
    const inventoryMovementEvents = await dsA.query(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE "eventType" = 'inventory.movement.recorded' AND payload->>'referenceType' = 'goods_receipt'`);
    expect(inventoryMovementEvents[0].n).toBe(0);
    expect((await valuationByWarehouse('A'))[ids.A.wh1]).toEqual({ qty: 20, value: 100 });
  });

  it('3. ADJUSTMENT INCREASE → GL at the warehouse moving-average cost: Dr Inventory / Cr configured Gain; valuation increased at that cost', async () => {
    const dsA = await dsOf('A');
    await inventory.recordMovement(ids.A.wh1, ids.A.product, 4, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
    await flush('A');
    const adj = await eventsOf('A', 'adjustment');
    expect(adj[0].status).toBe('POSTED');
    expect(await lines('A', adj[0].journalEntryId!)).toEqual(['1120 D 20.00', '4201 C 20.00']); // 4 × avg 5.00
    expect((await valuationByWarehouse('A'))[ids.A.wh1]).toEqual({ qty: 24, value: 120 });
  });

  it('4. ADJUSTMENT DECREASE → GL: Dr configured Loss / Cr Inventory at the consumed average cost; valuation decreased', async () => {
    const dsA = await dsOf('A');
    await inventory.recordMovement(ids.A.wh1, ids.A.product, -2, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
    await flush('A');
    const adj = await eventsOf('A', 'adjustment');
    expect(adj[1].status).toBe('POSTED');
    expect(await lines('A', adj[1].journalEntryId!)).toEqual(['1120 C 10.00', '5201 D 10.00']);
    expect((await valuationByWarehouse('A'))[ids.A.wh1]).toEqual({ qty: 22, value: 110 });
  });

  it('5. TRANSFER A→B → NO GL; valuation carried at the source average; TOTAL valuation unchanged', async () => {
    const dsA = await dsOf('A');
    const journalsBefore = await journalCount('A');
    const totalBefore = await totalValuation('A');
    const feBefore = Number((await dsA.query(`SELECT count(*) AS n FROM "accounting_financial_events"`))[0].n);

    await dsA.manager.transaction((m) => inventory.recordTransfer(ids.A.wh1, ids.A.wh2, ids.A.product, 6, 'warehouse_transaction', randomUUID(), actor, m));
    await flush('A');

    const val = await valuationByWarehouse('A');
    expect(val[ids.A.wh1]).toEqual({ qty: 16, value: 80 });
    expect(val[ids.A.wh2]).toEqual({ qty: 6, value: 30 });
    expect(await totalValuation('A')).toBeCloseTo(totalBefore, 4); // unchanged
    expect(await journalCount('A')).toBe(journalsBefore); // NO journal
    expect(Number((await dsA.query(`SELECT count(*) AS n FROM "accounting_financial_events"`))[0].n)).toBe(feBefore); // not even an event
    expect(await stockOnHand('A', ids.A.wh1)).toBe(16);
    expect(await stockOnHand('A', ids.A.wh2)).toBe(6);
  });

  it('6. RETURN-IN → a financial event EXISTS and is REJECTED with the explicit D4 reason (no invented account, no journal, valuation untouched)', async () => {
    const dsA = await dsOf('A');
    const before = await valuationByWarehouse('A');
    const journalsBefore = await journalCount('A');
    await inventory.recordMovement(ids.A.wh1, ids.A.product, 1, 'return_in', 'return', randomUUID(), actor, dsA.manager);
    await flush('A');
    const [e] = await eventsOf('A', 'return_in');
    expect(e.status).toBe('REJECTED');
    expect(e.rejectionReason).toMatch(/D4/);
    expect(e.journalEntryId).toBeNull();
    expect(await journalCount('A')).toBe(journalsBefore);
    expect(await valuationByWarehouse('A')).toEqual(before);
    expect(await stockOnHand('A', ids.A.wh1)).toBe(17); // the physical movement stands
  });

  it('7. RECONCILIATION: Σ inventory valuation = GL Inventory control account, and every journal balances', async () => {
    expect(await totalValuation('A')).toBeCloseTo(110, 4);
    expect(await glInventoryBalance('A')).toBeCloseTo(110, 4);
    expect(await totalValuation('A')).toBeCloseTo(await glInventoryBalance('A'), 4);
    const ds = await dsOf('A');
    const unbalanced = await ds.query(`SELECT je.id FROM "accounting_journal_entries" je JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`);
    expect(unbalanced).toEqual([]);
  });

  it('8. FAIL-CLOSED: unset adjustment-gain config ⇒ REJECTED with the config reason, NO fallback account, valuation NOT mutated; after configuring, redrive posts it and the reconciliation still holds', async () => {
    const dsA = await dsOf('A');
    const saved = config['accounting.inventory_adjustment_gain_account_code'];
    config['accounting.inventory_adjustment_gain_account_code'] = '';
    const valBefore = await valuationByWarehouse('A');
    const journalsBefore = await journalCount('A');

    await inventory.recordMovement(ids.A.wh1, ids.A.product, 2, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
    await flush('A');
    const adj = await eventsOf('A', 'adjustment');
    const rejected = adj.find((e) => e.status === 'REJECTED')!;
    expect(rejected.rejectionReason).toMatch(/accounting\.inventory_adjustment_gain_account_code/);
    expect(await journalCount('A')).toBe(journalsBefore);
    expect(await valuationByWarehouse('A')).toEqual(valBefore); // accounts are resolved BEFORE any valuation mutation

    config['accounting.inventory_adjustment_gain_account_code'] = saved;
    const redriven = await financialEvents.redrive(rejected.id, dsA.manager);
    expect(redriven.status).toBe('POSTED');
    expect(await totalValuation('A')).toBeCloseTo(await glInventoryBalance('A'), 4);
    expect(await totalValuation('A')).toBeCloseTo(120, 4); // 110 + 2 × 5.00
  });

  it('9. ISOLATION: Company B is untouched (no stock, valuation, events or journals) and the Platform/control-plane DB was never used', async () => {
    const dsB = await dsOf('B');
    for (const t of ['stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox']) {
      expect({ t, n: Number((await dsB.query(`SELECT count(*) AS n FROM "${t}"`))[0].n) }).toEqual({ t, n: 0 });
    }
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });
});
