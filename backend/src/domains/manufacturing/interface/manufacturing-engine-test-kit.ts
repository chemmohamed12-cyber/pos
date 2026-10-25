import { InventoryPostingPolicyService } from '../../accounting/application/inventory-posting-policy.service';
import { randomUUID } from 'crypto';
import { WorkOrderService } from '../application/work-order.service';
import { RoutingService } from '../application/routing.service';
import { ProcessDefinitionService } from '../application/process-definition.service';
import { ProcessExecutionService } from '../application/process-execution.service';
import { UnitConversionService } from '../application/unit-conversion.service';
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
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Shared real-PostgreSQL kit for the Manufacturing Engine specs (S4+ and the industrial cases): the full two-Company harness with the REAL cost engine, event pipeline,
 * journals and chart of accounts (1120 Inventory, 1150 WIP, 3105 opening equity, 5301 scrap loss), plus every engine service. Company A is the working Company,
 * Company B the untouched witness.
 */
export interface MfgKit {
  h: TwoCompanyHarness;
  actor: string;
  inventory: InventoryService;
  products: ProductsService;
  bom: BomService;
  events: EventBusService;
  wo: WorkOrderService;
  processes: ProcessDefinitionService;
  exec: ProcessExecutionService;
  units: UnitConversionService;
  warehouseId: string;
  mgr: () => Promise<import('typeorm').EntityManager>;
  q: <T = Record<string, string>>(sql: string, params?: unknown[]) => Promise<T[]>;
  flush: () => Promise<void>;
  glBalance: (code: string) => Promise<number>;
  onHand: (warehouseId: string, productId: string) => Promise<number>;
  product: (sku: string, name: string, unit?: string) => Promise<string>;
  stock: (rows: Array<{ productId: string; sku: string; quantity: number; unitCost: string }>) => Promise<void>;
  teardown: () => Promise<void>;
}

export async function setUpMfgKit(namePrefix: string): Promise<MfgKit> {
  const year = new Date().toISOString().slice(0, 4);
  const config: Record<string, unknown> = {
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.manufacturing_scrap_loss_account_code': '5301',
  };
  const h = await setUpTwoCompanyHarness({ namePrefix, extraCompanyTags: ['sales', 'inventory', 'logistics', 'finance', 'procurement', 'accounting', 'manufacturing'] });
  const actor = randomUUID();
  const inert = {} as never;
  const audit = new AuditService(h.controlPlane);
  const numbering = new NumberingService(h.controlPlane);
  const events = new EventBusService(inert, h.connections);
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
  const realPolicy = new InventoryPostingPolicyService(cfg, new InventoryPostingPolicyRegistry()); // D6: the real scrap / recovery pre-flight; the other gates stay stubs
  policy.bind({ assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }), listManualReceiptReasons: () => [], assertSaleReturnPostable: async () => undefined, assertSupplierInvoicePostable: async () => undefined, assertManufacturingScrapPostable: (kind, m) => realPolicy.assertManufacturingScrapPostable(kind, m) });
  const products = new ProductsService(h.controlPlane, audit, events);
  const inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policy);
  const bom = new BomService(h.controlPlane, audit, products);
  const processes = new ProcessDefinitionService(h.controlPlane, audit);
  const wo = new WorkOrderService(h.controlPlane, inventory, numbering, processEngine, audit, events, bom, valuation as never, new RoutingService(h.controlPlane, audit, products), processes, policy);
  const exec = new ProcessExecutionService(h.controlPlane, wo, processes, audit, valuation as never);

  const dsOf = (k: 'A' | 'B') => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);
  for (const k of ['A', 'B'] as const) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'MFG Operator',$2) ON CONFLICT DO NOTHING`, [actor, `mfg-${k}-${actor}@test.local`]);
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
    await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, ds.manager);
  }
  const dsA = await dsOf('A');
  const warehouseId = (await inventory.createWarehouse('WH-MFG', 'Main', null, null, null, 'main', dsA.manager)).id;
  const mgr = async () => (await dsOf('A')).manager;
  const q = async <T = Record<string, string>>(sql: string, params: unknown[] = []): Promise<T[]> => (await dsOf('A')).query(sql, params);
  return {
    h,
    actor,
    inventory,
    products,
    bom,
    events,
    wo,
    processes,
    exec,
    units: new UnitConversionService(),
    warehouseId,
    mgr,
    q,
    flush: async () => {
      await events.dispatchAfterCommit(await mgr());
    },
    glBalance: async (code: string) =>
      Number(
        (
          await q(
            `SELECT COALESCE(SUM(jl."debitBase" - jl."creditBase"),0)::numeric(20,4)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId" WHERE ga.code = $1 AND je."postedAt" IS NOT NULL`,
            [code],
          )
        )[0].b,
      ),
    onHand: async (wid: string, pid: string) => Number((await q(`SELECT COALESCE(SUM(quantity),0) AS n FROM "stock_movements" WHERE "warehouseId" = $1 AND "productId" = $2`, [wid, pid]))[0].n),
    product: async (sku: string, name: string, unit = 'pcs') => (await products.createProduct(sku, name, '1.00', actor, unit, await mgr())).id,
    stock: async (rows) => {
      await inventory.importOpeningStockRows(
        rows.map((r) => ({ warehouseCode: 'WH-MFG', productSku: r.sku, quantity: String(r.quantity), unitCost: r.unitCost })),
        actor,
        await mgr(),
      );
      await events.dispatchAfterCommit(await mgr());
    },
    teardown: async () => {
      await h.teardown().catch((e) => console.warn('MFG kit teardown warning: ' + (e instanceof Error ? e.message : String(e))));
    },
  };
}
