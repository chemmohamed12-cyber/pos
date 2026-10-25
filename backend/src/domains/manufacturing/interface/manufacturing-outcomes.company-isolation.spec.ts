import { randomUUID } from 'crypto';
import { WorkOrderService } from '../application/work-order.service';
import { RoutingService } from '../application/routing.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { ProductsService } from '../../commerce/application/products.service';
import { BomService } from '../../commerce/application/bom.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../accounting/application/journal-entry.service';
import { FinancialEventService } from '../../accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../accounting/application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../../accounting/application/financial-events/inventory-costing-handler.service';
import { GLAccountService } from '../../accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../accounting/application/fiscal-period.service';
import { CurrencyService } from '../../accounting/application/currency.service';
import { FinancialDimensionService } from '../../accounting/application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyService } from '../../accounting/application/inventory-posting-policy.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Manufacturing Engine S1 (decisions D-ME-1 / D-ME-4) — real PostgreSQL, the REAL cost engine, event pipeline and journals; Company B is the untouched witness.
 * Proves scrap as its own result (components consumed at the pooled cost, no stock created, Dr Scrap loss / Cr WIP), idempotent retries, recovery capped by the scrap,
 * tracked outcomes that must be resolved before closing, the plan arithmetic (produced + scrapped), a fail-closed event while the loss account is not configured,
 * and that WIP, the GL and the stock all reconcile to zero at the end — with no duplicated movement or journal.
 */
describe('Manufacturing Engine S1 — outcomes (scrap, recovery, tracked) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let events: EventBusService;
  let wo: WorkOrderService;
  let bom: BomService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  type Key = 'A' | 'B';
  const config: Record<string, unknown> = {
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.manufacturing_scrap_loss_account_code': '5301',
  };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  const ctx = { wh: '', fin: '', c1: '', c2: '' };

  async function seed(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'MFG Operator',$2) ON CONFLICT DO NOTHING`, [actor, `mfg-${k}@test.local`]);
    for (const [code, name, type, normal, fn] of [
      ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
      ['1150', 'Work in Process', 'asset', 'debit', 'wip'],
      ['3105', 'Opening Balance Equity', 'equity', 'credit', null],
      ['5301', 'Manufacturing Scrap Loss', 'expense', 'debit', null],
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
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'mfg_s1', extraCompanyTags: ['sales', 'inventory', 'logistics', 'finance', 'procurement', 'accounting', 'manufacturing'] });
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
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, registry, cfg).onModuleInit();
    new InventoryCostingHandlerService(registry, valuation).onModuleInit();
    const policy = new InventoryPostingPolicyRegistry();
    // D6: the REAL accounting pre-flight for scrap / recovery (reads the same mutable `config` as the event handler), the other gates stay stubs
    const realPolicy = new InventoryPostingPolicyService(cfg, new InventoryPostingPolicyRegistry());
    policy.bind({ assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }), listManualReceiptReasons: () => [], assertSaleReturnPostable: async () => undefined, assertSupplierInvoicePostable: async () => undefined, assertManufacturingScrapPostable: (kind, m) => realPolicy.assertManufacturingScrapPostable(kind, m) });
    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policy);
    bom = new BomService(h.controlPlane, audit, products);
    wo = new WorkOrderService(h.controlPlane, inventory, numbering, processEngine, audit, events, bom, valuation as never, new RoutingService(h.controlPlane, audit, products), undefined, policy);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    ctx.wh = (await inventory.createWarehouse('WH-MFG', 'Main', null, null, null, 'main', dsA.manager)).id;
    ctx.fin = (await products.createProduct('S1-FIN', 'Finished', '100.00', actor, null, dsA.manager)).id;
    ctx.c1 = (await products.createProduct('S1-C1', 'Component 1', '5.00', actor, null, dsA.manager)).id;
    ctx.c2 = (await products.createProduct('S1-C2', 'Component 2', '10.00', actor, null, dsA.manager)).id;
    await bom.defineBom(ctx.fin, [{ componentProductId: ctx.c1, quantityPerUnit: 2 }, { componentProductId: ctx.c2, quantityPerUnit: 1 }], actor, dsA.manager);
    await inventory.importOpeningStockRows(
      [
        { warehouseCode: 'WH-MFG', productSku: 'S1-C1', quantity: '300', unitCost: '5.00' },
        { warehouseCode: 'WH-MFG', productSku: 'S1-C2', quantity: '300', unitCost: '10.00' },
      ],
      actor,
      dsA.manager,
    );
    await events.dispatchAfterCommit(dsA.manager);
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('MFG S1 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const qa = async <T = Record<string, string>>(sql: string, params: unknown[] = []): Promise<T[]> => (await dsOf('A')).query(sql, params);
  const flush = async () => events.dispatchAfterCommit((await dsOf('A')).manager);
  const glBalance = async (code: string) =>
    Number(
      (
        await qa(
          `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,4)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" WHERE ga.code = $1 AND je."postedAt" IS NOT NULL`,
          [code],
        )
      )[0].b,
    );
  const onHand = async (warehouseId: string, productId: string) => Number((await qa(`SELECT COALESCE(SUM(quantity),0) AS n FROM "stock_movements" WHERE "warehouseId" = $1 AND "productId" = $2`, [warehouseId, productId]))[0].n);
  const mgr = async () => (await dsOf('A')).manager;
  const newOrder = async (plan: number) => {
    const m = await mgr();
    const order = await wo.createWorkOrder(ctx.fin, plan, ctx.wh, actor, m);
    const released = await wo.release(order.id, actor, m);
    await wo.materialIssue(order.id, ctx.c1, 2 * plan, actor, `issue-c1-${order.id}`, m);
    await wo.materialIssue(order.id, ctx.c2, plan, actor, `issue-c2-${order.id}`, m);
    await flush();
    return { id: order.id, wip: released.wipWarehouseId! };
  };

  let o: { id: string; wip: string };
  let scrapId = '';

  it('S1-1 issue all components for a 10-unit plan: WIP carries 200.00 (20 C1 @5 + 10 C2 @10) and the GL agrees', async () => {
    o = await newOrder(10);
    expect(await wo.computeWipValue(o.id, await mgr())).toBeCloseTo(200, 4);
    expect(await glBalance('1150')).toBeCloseTo(200, 4);
  });

  it('S1-2 a good output of 4 takes 4/10 of the pooled value (80.00) to finished stock; remaining WIP is 120.00', async () => {
    await wo.finishedGoodsOutput(o.id, 4, actor, 'out-1', await mgr());
    await flush();
    expect(await wo.computeWipValue(o.id, await mgr())).toBeCloseTo(120, 4);
    expect(await onHand(ctx.wh, ctx.fin)).toBe(4);
    expect(await glBalance('1150')).toBeCloseTo(120, 4);
  });

  it('S1-3 scrapping 2 units consumes their components at the SAME pooled cost, creates no stock, and posts Dr Scrap loss / Cr WIP of 40.00', async () => {
    const before = { fin: await onHand(ctx.wh, ctx.fin), finMovements: Number((await qa(`SELECT count(*) AS n FROM "stock_movements" WHERE "productId" = $1`, [ctx.fin]))[0].n) };
    const r = await wo.recordScrap(o.id, 2, 'drop test failure', actor, 'scrap-1', await mgr());
    await flush();
    scrapId = r.id;
    expect(r.outcomeClass).toBe('scrap');
    expect(Number(r.valueBase)).toBeCloseTo(40, 4); // (120 / 6 remaining) * 2
    const order = await wo.getWorkOrderOrThrow(o.id, await mgr());
    expect(order.quantityScrapped).toBe(2);
    expect(order.quantityProduced).toBe(4);
    expect(await onHand(ctx.wh, ctx.fin)).toBe(before.fin); // no finished stock created
    expect(Number((await qa(`SELECT count(*) AS n FROM "stock_movements" WHERE "productId" = $1`, [ctx.fin]))[0].n)).toBe(before.finMovements);
    expect(await onHand(o.wip, ctx.c1)).toBe(20 - 8 - 4); // issued 20 → 8 consumed by the good 4, 4 by the scrap 2
    expect(await onHand(o.wip, ctx.c2)).toBe(10 - 4 - 2);
    expect(await wo.computeWipValue(o.id, await mgr())).toBeCloseTo(80, 4);
    expect(await glBalance('5301')).toBeCloseTo(40, 4);
    expect(await glBalance('1150')).toBeCloseTo(80, 4);
  });

  it('S1-4 a retried scrap (same requestId) returns the same result and creates no second movement, event or journal', async () => {
    const counts = async () => ({
      movements: Number((await qa(`SELECT count(*) AS n FROM "stock_movements" WHERE "movementType" = 'work_order_scrap'`))[0].n),
      events: Number((await qa(`SELECT count(*) AS n FROM "accounting_financial_events" WHERE "eventType" = 'manufacturing.work_order.scrap_recognized'`))[0].n),
      results: Number((await qa(`SELECT count(*) AS n FROM "work_order_results" WHERE "outcomeClass" = 'scrap'`))[0].n),
    });
    const before = await counts();
    const again = await wo.recordScrap(o.id, 2, 'drop test failure', actor, 'scrap-1', await mgr());
    await flush();
    expect(again.id).toBe(scrapId);
    expect(await counts()).toEqual(before);
    expect(await glBalance('5301')).toBeCloseTo(40, 4);
  });

  it('S1-5 recovery returns material to stock at a declared value, capped cumulatively by what the scrap wrote off (Dr Inventory / Cr Scrap loss)', async () => {
    const stockBefore = await onHand(ctx.wh, ctx.c1);
    await wo.recordRecovery(o.id, ctx.c1, 1, '8.00', scrapId, actor, 'rec-1', await mgr());
    await flush();
    expect(await onHand(ctx.wh, ctx.c1)).toBe(stockBefore + 1);
    expect(await glBalance('5301')).toBeCloseTo(32, 4);
    await expect(wo.recordRecovery(o.id, ctx.c2, 1, '33.00', scrapId, actor, 'rec-2', await mgr())).rejects.toThrow(/exceed what the scrap wrote off/);
    await wo.recordRecovery(o.id, ctx.c2, 2, '32.00', scrapId, actor, 'rec-3', await mgr());
    await flush();
    expect(await glBalance('5301')).toBeCloseTo(0, 4); // fully recovered: the loss is fully offset
    await expect(wo.recordRecovery(o.id, ctx.c2, 1, '0.01', scrapId, actor, 'rec-4', await mgr())).rejects.toThrow(/exceed/);
    await expect(wo.recordRecovery(o.id, ctx.c2, 1, '1.00', randomUUID(), actor, 'rec-5', await mgr())).rejects.toThrow(/Scrap result/);
  });

  it('S1-6 plan arithmetic and guards: produced + scrapped can never exceed the plan', async () => {
    await expect(wo.finishedGoodsOutput(o.id, 5, actor, 'out-over', await mgr())).rejects.toThrow(/remaining/);
    await expect(wo.recordScrap(o.id, 5, 'too many', actor, 'scrap-over', await mgr())).rejects.toThrow(/remaining/);
    await expect(wo.recordScrap(o.id, 1, 'x', actor, 'scrap-noreason', await mgr())).rejects.toThrow(/reason/i);
  });

  it('S1-7 tracked outcomes (held / rework / rejected) carry no stock or value but must be resolved before the order closes', async () => {
    const m = await mgr();
    const held = await wo.recordTrackedOutcome(o.id, 'held', 1, 'awaiting inspection', actor, 'trk-1', m);
    const dupe = await wo.recordTrackedOutcome(o.id, 'held', 1, 'awaiting inspection', actor, 'trk-1', m);
    expect(dupe.id).toBe(held.id);
    expect(Number(held.valueBase)).toBe(0);
    await expect(wo.recordTrackedOutcome(o.id, 'rework', 9, 'too many', actor, 'trk-2', m)).rejects.toThrow(/exceed/);
    await wo.finishedGoodsOutput(o.id, 4, actor, 'out-2', m); // the remaining 4 take the whole remaining WIP
    await flush();
    expect(await wo.computeWipValue(o.id, m)).toBeCloseTo(0, 4);
    await expect(wo.complete(o.id, actor, m)).rejects.toThrow(/still tracked/);
    await wo.resolveTrackedOutcome(o.id, held.id, 'good', actor, m);
    await expect(wo.resolveTrackedOutcome(o.id, held.id, 'good', actor, m)).rejects.toThrow(/already resolved/);
    await wo.complete(o.id, actor, m);
    expect(await wo.getWorkOrderState(o.id, m)).toBe('completed');
  });

  it('S1-8 the closed order reconciles: WIP value 0, WIP GL 0, produced 8 + scrapped 2 = plan 10, all events POSTED, every journal balanced, no duplicate result', async () => {
    const m = await mgr();
    const order = await wo.getWorkOrderOrThrow(o.id, m);
    expect([order.quantityProduced, order.quantityScrapped, order.quantityPlanned]).toEqual([8, 2, 10]);
    expect(await wo.computeWipValue(o.id, m)).toBeCloseTo(0, 4);
    expect(await glBalance('1150')).toBeCloseTo(0, 4);
    expect(await onHand(o.wip, ctx.c1)).toBe(0);
    expect(await onHand(o.wip, ctx.c2)).toBe(0);
    // 8 finished units carry the whole 160.00 (the 40.00 of scrap was fully recovered back to stock), valued 20/unit
    expect(await onHand(ctx.wh, ctx.fin)).toBe(8);
    const bad = await qa(`SELECT count(*)::int AS n FROM "accounting_financial_events" WHERE "status" <> 'POSTED'`);
    expect((bad[0] as unknown as { n: number }).n).toBe(0);
    const unbalanced = await qa(`SELECT count(*)::int AS n FROM "accounting_journal_entries" WHERE "postedAt" IS NOT NULL AND "totalDebitBase" <> "totalCreditBase"`);
    expect((unbalanced[0] as unknown as { n: number }).n).toBe(0);
    const dupes = await qa(`SELECT count(*)::int AS n FROM (SELECT "workOrderId","outcomeClass","requestId" FROM "work_order_results" GROUP BY 1,2,3 HAVING count(*) > 1) d`);
    expect((dupes[0] as unknown as { n: number }).n).toBe(0);
    // value conservation: issued 200 = finished 160 (8 units) + scrap 40, and the 40 of scrap was fully recovered into inventory (Dr Inventory 40)
    expect(await glBalance('5301')).toBeCloseTo(0, 4);
  });

  it('S1-9 (D6) while the scrap-loss account is NOT configured scrap is REFUSED BEFORE anything is written: no result, no stock/WIP movement, no event, plan untouched - and it works once configured', async () => {
    const saved = config['accounting.manufacturing_scrap_loss_account_code'];
    delete config['accounting.manufacturing_scrap_loss_account_code'];
    const o2 = await newOrder(4);
    const count = async (sql: string, p: unknown[] = []) => Number((await qa<{ n: string }>(sql, p))[0].n);
    const before = {
      results: await count(`SELECT count(*) AS n FROM "work_order_results" WHERE "workOrderId" = $1`, [o2.id]),
      moves: await count(`SELECT count(*) AS n FROM "stock_movements"`),
      events: await count(`SELECT count(*) AS n FROM "accounting_financial_events"`),
    };
    await expect(wo.recordScrap(o2.id, 1, 'config test', actor, 'scrap-cfg', await mgr())).rejects.toThrow(/scrap-loss account is not configured.*nothing was recorded/);
    expect(await count(`SELECT count(*) AS n FROM "work_order_results" WHERE "workOrderId" = $1`, [o2.id])).toBe(before.results);
    expect(await count(`SELECT count(*) AS n FROM "stock_movements"`)).toBe(before.moves);
    expect(await count(`SELECT count(*) AS n FROM "accounting_financial_events"`)).toBe(before.events);
    expect((await wo.getWorkOrderOrThrow(o2.id, await mgr())).quantityScrapped).toBe(0);
    // an account that is not an expense account is refused with its own reason
    config['accounting.manufacturing_scrap_loss_account_code'] = '1120';
    await expect(wo.recordScrap(o2.id, 1, 'config test', actor, 'scrap-cfg', await mgr())).rejects.toThrow(/control account|not an expense/);
    config['accounting.manufacturing_scrap_loss_account_code'] = saved;
    const r = await wo.recordScrap(o2.id, 1, 'config test', actor, 'scrap-cfg', await mgr()); // same requestId: the refused attempts left nothing behind
    await flush();
    expect(r.outcomeClass).toBe('scrap');
    const ev = await qa<{ status: string }>(`SELECT status FROM "accounting_financial_events" WHERE "idempotencyKey" = $1`, [`manufacturing:work_order:${o2.id}:scrap:scrap-cfg`]);
    expect(ev.map((e) => e.status)).toEqual(['POSTED']);
  });

  it('S1-10 Company B (the witness) was never touched', async () => {
    const dsB = await dsOf('B');
    for (const t of ['work_orders', 'work_order_results', 'stock_movements', 'accounting_financial_events', 'accounting_journal_entries']) {
      expect(Number((await dsB.query(`SELECT count(*) AS n FROM "${t}"`))[0].n)).toBe(0);
    }
  });
});
