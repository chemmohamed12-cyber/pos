import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
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
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * D3 closure (2026-10-06, CTO directive "D3 → H3") — ONE clean-run lifecycle on a fresh Company A (Company B = untouched
 * witness), real PostgreSQL, the real GL pipeline, real moving-average valuation. It re-proves NOTHING new about the
 * policy (each movement type already has its own spec); it adds the single missing statement of the closure invariant:
 * after a complete, correctly-configured lifecycle through EVERY movement type —
 *   Opening Stock · Manual Receipt · Adjustment ± · Transfer · Dispatch
 * — (a) stock ledger == valuation quantity per warehouse, 0 negative on-hand; (b) Σ valuation == GL 1120; (c) Σ Dr == Σ Cr
 * on every journal; (d) ZERO financial events are REJECTED/IGNORED (every event POSTED); (e) Transfer produced no event and
 * no journal; (f) Company B and the Platform DB are untouched. Then Return-In and the fail-closed case are added and the
 * ONLY non-POSTED events left are the two EXPLAINED ones (return_in → D4 reason; missing config → named config key,
 * zero valuation mutation, re-drivable to POSTED).
 */
describe('D3 closure — clean-run lifecycle invariant (Model A, 1120) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { DONATION: '3105' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
  };
  const ids: Record<Key, { wh1: string; wh2: string; product: string }> = { A: { wh1: '', wh2: '', product: '' }, B: { wh1: '', wh2: '', product: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'D3 Closure Operator',$2) ON CONFLICT DO NOTHING`, [actor, `d3c-${k}@test.local`]);
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'd3_closure', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });

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
    const handlerRegistry = new FinancialEventHandlerRegistry();
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, handlerRegistry, cfg);
    financialEvents.onModuleInit();
    new InventoryCostingHandlerService(handlerRegistry, valuation).onModuleInit();

    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();

    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policyRegistry);

    await seedCompany('A');
    await seedCompany('B');
    const dsA = await dsOf('A');
    ids.A.product = (await products.createProduct('P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D3 closure teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const q = async (k: Key, sql: string, params: unknown[] = []) => (await dsOf(k)).query(sql, params);

  async function valuationByWarehouse(k: Key): Promise<Record<string, { qty: number; value: number }>> {
    const rows: Array<{ warehouseId: string; q: string; v: string }> = await q(k, `SELECT "warehouseId", "onHandQuantity"::text AS q, "totalValueBase"::text AS v FROM "inventory_valuation_state"`);
    return Object.fromEntries(rows.map((r) => [r.warehouseId, { qty: Number(r.q), value: Number(r.v) }]));
  }
  const totalValuation = async (k: Key) => Object.values(await valuationByWarehouse(k)).reduce((s, w) => s + w.value, 0);
  const glInventoryBalance = async (k: Key) =>
    Number((await q(k, `SELECT coalesce(sum(jl."debitBase" - jl."creditBase"), 0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = '1120'`))[0].b);
  const stockOnHand = async (k: Key, wh: string) => Number((await q(k, `SELECT coalesce(sum(quantity),0)::text AS q FROM "stock_movements" WHERE "warehouseId" = $1`, [wh]))[0].q);
  const count = async (k: Key, table: string) => Number((await q(k, `SELECT count(*) AS n FROM "${table}"`))[0].n);
  const nonPosted = async (k: Key) =>
    (await q(k, `SELECT fe.status, fe."rejectionReason", fe.payload->>'glKind' AS "glKind", fe.id FROM "accounting_financial_events" fe WHERE fe.status IN ('REJECTED','IGNORED') ORDER BY fe."receivedAt"`)) as Array<{
      status: string;
      rejectionReason: string | null;
      glKind: string | null;
      id: string;
    }>;

  /** `unvaluedUnits` = units that entered the stock ledger through a raw `return_in` (stock-only by D3; valuation + GL belong to D4's return-completion path) — explicitly accounted for, never silently tolerated. */
  async function expectClosureInvariants(k: Key, unvaluedUnits: Record<string, number> = {}) {
    const val = await valuationByWarehouse(k);
    // (a) stock ledger == valuation quantity (+ the explicitly-listed unvalued return_in units) per warehouse, and nowhere negative on-hand
    for (const wh of [ids[k].wh1, ids[k].wh2]) expect({ wh, qty: await stockOnHand(k, wh) }).toEqual({ wh, qty: (val[wh]?.qty ?? 0) + (unvaluedUnits[wh] ?? 0) });
    expect(await q(k, `SELECT "warehouseId","productId",sum(quantity) AS q FROM "stock_movements" GROUP BY 1,2 HAVING sum(quantity) < 0`)).toEqual([]);
    // (b) Σ valuation == GL 1120
    expect(await totalValuation(k)).toBeCloseTo(await glInventoryBalance(k), 4);
    // (c) every journal balances
    expect(await q(k, `SELECT je.id FROM "accounting_journal_entries" je JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`)).toEqual([]);
    expect(Number((await q(k, `SELECT coalesce(sum("debitBase") - sum("creditBase"),0)::text AS d FROM "accounting_journal_lines"`))[0].d)).toBeCloseTo(0, 4);
  }

  it('CLEAN RUN — Opening → Manual Receipt → Adjustment ± → Transfer → Dispatch: invariants hold and NO event is REJECTED/IGNORED', async () => {
    const dsA = await dsOf('A');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      // Opening Stock 10 @ 4.00 = 40
      expect((await inventory.importOpeningStockRows([{ warehouseCode: 'WH1-A', productSku: 'P1', quantity: '10', unitCost: '4.00' }], actor, dsA.manager)).rejected).toEqual([]);
      await flush('A');
      // Manual Receipt 10 @ 6.00 = 60 (controlled reason → configured offset); average becomes 5.00
      await inventory.recordManualReceipt(ids.A.wh1, ids.A.product, 10, '6.00', 'DONATION', null, actor, dsA.manager);
      await flush('A');
      // Adjustment +4 (Dr 1120 / Cr gain, at 5.00 = 20) and -2 (Dr loss / Cr 1120 = 10)
      await inventory.recordMovement(ids.A.wh1, ids.A.product, 4, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
      await flush('A');
      await inventory.recordMovement(ids.A.wh1, ids.A.product, -2, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
      await flush('A');
      expect(await totalValuation('A')).toBeCloseTo(110, 4);

      // Transfer 6 WH1 → WH2: NO event, NO journal, total valuation unchanged
      const journalsBefore = await count('A', 'accounting_journal_entries');
      const eventsBefore = await count('A', 'accounting_financial_events');
      await dsA.manager.transaction((m) => inventory.recordTransfer(ids.A.wh1, ids.A.wh2, ids.A.product, 6, 'warehouse_transaction', randomUUID(), actor, m));
      await flush('A');
      expect(await count('A', 'accounting_journal_entries')).toBe(journalsBefore);
      expect(await count('A', 'accounting_financial_events')).toBe(eventsBefore);
      expect(await totalValuation('A')).toBeCloseTo(110, 4);

      // Dispatch 3 from WH1 (existing behaviour: Dr COGS / Cr 1120 at the moving average 5.00 = 15)
      await inventory.recordMovement(ids.A.wh1, ids.A.product, -3, 'dispatch', 'sales_order', randomUUID(), actor, dsA.manager);
      await flush('A');
    });

    const val = await valuationByWarehouse('A');
    expect(val[ids.A.wh1]).toEqual({ qty: 13, value: 65 });
    expect(val[ids.A.wh2]).toEqual({ qty: 6, value: 30 });
    expect(await glInventoryBalance('A')).toBeCloseTo(95, 4); // 40 + 60 + 20 − 10 − 15
    await expectClosureInvariants('A');
    // (d) ZERO unexplained REJECTED/IGNORED — in a correctly-configured clean run there are none at all
    expect(await nonPosted('A')).toEqual([]);
    const posted = await q('A', `SELECT payload->>'glKind' AS k, count(*)::int AS n FROM "accounting_financial_events" WHERE "eventType" = 'inventory.movement.recorded' AND status = 'POSTED' GROUP BY 1 ORDER BY 1`);
    expect(posted).toEqual([
      { k: 'adjustment', n: 2 },
      { k: 'dispatch', n: 1 },
      { k: 'manual_receipt', n: 1 },
      { k: 'opening_stock', n: 1 },
    ]);
  });

  it('RETURN-IN produces a financial event (never stock-only); FAIL-CLOSED on missing config leaves valuation untouched; the ONLY non-POSTED events are these two explained ones, and re-drive restores the invariant', async () => {
    const dsA = await dsOf('A');
    const before = await valuationByWarehouse('A');
    await inventory.recordMovement(ids.A.wh1, ids.A.product, 1, 'return_in', 'return', randomUUID(), actor, dsA.manager);
    await flush('A');
    const saved = config['accounting.inventory_adjustment_gain_account_code'];
    config['accounting.inventory_adjustment_gain_account_code'] = '';
    await inventory.recordMovement(ids.A.wh1, ids.A.product, 2, 'adjustment', 'warehouse_transaction', randomUUID(), actor, dsA.manager);
    await flush('A');

    const open = await nonPosted('A');
    expect(open.map((e) => e.glKind).sort()).toEqual(['adjustment', 'return_in']); // exactly the two explained events
    expect(open.find((e) => e.glKind === 'return_in')!.rejectionReason).toMatch(/D4/);
    const failClosed = open.find((e) => e.glKind === 'adjustment')!;
    expect(failClosed.rejectionReason).toMatch(/accounting\.inventory_adjustment_gain_account_code/);
    expect(await valuationByWarehouse('A')).toEqual(before); // no "stock succeeded / GL missing" partial state: valuation not mutated by either
    expect(await glInventoryBalance('A')).toBeCloseTo(95, 4);

    config['accounting.inventory_adjustment_gain_account_code'] = saved;
    expect((await financialEvents.redrive(failClosed.id, dsA.manager)).status).toBe('POSTED');
    expect((await nonPosted('A')).map((e) => e.glKind)).toEqual(['return_in']); // only the D4-owned return_in remains
    expect(await totalValuation('A')).toBeCloseTo(await glInventoryBalance('A'), 4);
    // the one raw return_in unit is the ONLY stock-vs-valuation difference (documented D3 limit → D4); money invariants hold exactly
    await expectClosureInvariants('A', { [ids.A.wh1]: 1 });
  });

  it('ISOLATION: Company B and the Platform DB are untouched by the whole lifecycle', async () => {
    for (const t of ['stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox']) {
      expect({ t, n: await count('B', t) }).toEqual({ t, n: 0 });
    }
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });
});
