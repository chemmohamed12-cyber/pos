import { randomUUID } from 'crypto';
import { BizEnv, setUpBiz } from './biz-support';
import { InventoryService } from '../../domains/inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../domains/inventory-warehouse/application/warehouse-transactions.service';
import { ProductsService } from '../../domains/commerce/application/products.service';
import { InventoryValuationService } from '../../domains/inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../domains/inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../../domains/accounting/application/journal-entry.service';
import { FinancialEventService } from '../../domains/accounting/application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../../domains/accounting/application/financial-events/handler-registry';
import { InventoryCostingHandlerService } from '../../domains/accounting/application/financial-events/inventory-costing-handler.service';
import { GLAccountService } from '../../domains/accounting/application/gl-account.service';
import { FiscalPeriodService } from '../../domains/accounting/application/fiscal-period.service';
import { CurrencyService } from '../../domains/accounting/application/currency.service';
import { FinancialDimensionService } from '../../domains/accounting/application/financial-dimension.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { EventBusService } from '../events/event-bus.service';
import { ProcessEngineService } from '../process-engine/process-engine.service';
import { ConfigurationEngineService } from '../configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../inventory-posting-policy/inventory-posting-policy.registry';
import { Role } from '../authorization/role.entity';
import { UserRole } from '../authorization/user-role.entity';

/**
 * Inventory + GL wiring for the business-test program: REAL event bus, REAL financial-event engine, REAL moving-average valuation and the
 * REAL inventory costing handler (the same graph as the D3 inventory-posting spec), on the biz disposable databases. Test infrastructure only.
 */
export interface InvGlEnv extends BizEnv {
  warehouseId: string;
  events: EventBusService;
  financialEvents: FinancialEventService;
  products: ProductsService;
  /** the live accounting configuration the engine reads — tests may delete a key to provoke a REJECTED event, then restore it */
  cfg: Record<string, string>;
  productId: string;
  sku: string;
  flush(): Promise<void>;
}

export async function setUpInventoryGl(testId: string, prefix: string, openingQty = 5, unitCost = '4.00'): Promise<InvGlEnv> {
  const base = await setUpBiz(testId, prefix);
  const { h, dsA, actor } = base;
  const inert = {} as never;
  const audit = new AuditService(h.controlPlane);
  const numbering = new NumberingService(h.controlPlane);
  const events = new EventBusService(inert, h.connections);
  const processEngine = new ProcessEngineService(h.controlPlane);
  const cfg: Record<string, string> = {
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
  };
  const config = { get: (key: string) => cfg[key] } as unknown as ConfigurationEngineService;
  const currencies = new CurrencyService(h.controlPlane, audit);
  const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
  const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
  const dimensions = new FinancialDimensionService(h.controlPlane, audit);
  const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
  const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
  const registry = new FinancialEventHandlerRegistry();
  const financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, registry, config);
  financialEvents.onModuleInit();
  new InventoryCostingHandlerService(registry, valuation).onModuleInit();

  const year = new Date().toISOString().slice(0, 4);
  for (const [code, name, type, normal, fn] of [
    ['1120', 'Inventory', 'asset', 'debit', 'inventory'], ['3105', 'Opening Balance Equity', 'equity', 'credit', null], ['4201', 'Inventory Adjustment Gain', 'revenue', 'credit', null],
    ['5201', 'Inventory Adjustment Loss', 'expense', 'debit', null], ['5101', 'Cost of Goods Sold', 'expense', 'debit', null], ['2115', 'GRNI', 'liability', 'credit', 'grni'],
  ] as Array<[string, string, string, string, string | null]>) {
    await dsA.query(
      `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction") VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
      [randomUUID(), code, name, type, normal, fn],
    );
  }
  const fy = randomUUID();
  const fp = randomUUID();
  await dsA.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
  await dsA.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
  await dsA.query(
    `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
    [randomUUID(), fy, randomUUID(), fp],
  );
  await new NumberingService(h.controlPlane).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, dsA.manager);

  const products = new ProductsService(h.controlPlane, audit, events);
  const inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never);
  const policyRegistry = new InventoryPostingPolicyRegistry();
  policyRegistry.bind({
    assertManualReceiptReason: async () => ({ glAccountCode: 'stub' }),
    listManualReceiptReasons: () => ['FOUND_STOCK'],
    assertSaleReturnPostable: async () => undefined,
    assertSupplierInvoicePostable: async () => undefined,
  });
  const authorization = new AuthorizationService(dsA.getRepository(Role), dsA.getRepository(UserRole));
  const whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry);

  const sku = `${testId}-P1`.replace(/[^A-Za-z0-9-]/g, '');
  const productId = (await products.createProduct(sku, `${sku} Product`, '10.00', actor, null, dsA.manager)).id;
  const imported = await inventory.importOpeningStockRows([{ warehouseCode: 'WH-A1', productSku: sku, quantity: String(openingQty), unitCost }], actor, dsA.manager);
  if (imported.rejected.length) throw new Error(`opening stock rejected: ${JSON.stringify(imported.rejected)}`);

  const env = Object.assign(base, { inventory, whTx, processEngine, audit, events, financialEvents, products, cfg, productId, sku, flush: async () => events.dispatchAfterCommit(dsA.manager) }) as unknown as InvGlEnv;
  await env.flush();
  return env;
}

/** events of a glKind for the company, oldest first */
export async function eventsOfKind(env: InvGlEnv, glKind: string): Promise<Array<{ id: string; status: string; rejectionReason: string | null; journalEntryId: string | null }>> {
  return env.dsA.query(
    `SELECT fe.id, fe.status, fe."rejectionReason", fe."journalEntryId" FROM accounting_financial_events fe WHERE fe."eventType" = 'inventory.movement.recorded' AND fe.payload->>'glKind' = $1 ORDER BY fe."receivedAt", fe.id`,
    [glKind],
  );
}

export async function journalLines(env: InvGlEnv, journalEntryId: string): Promise<string[]> {
  const rows: Array<{ code: string; dr: string; cr: string }> = await env.dsA.query(
    `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
    [journalEntryId],
  );
  return rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
}

export async function valuationOf(env: InvGlEnv): Promise<{ qty: number; value: number }> {
  const r = (await env.dsA.query(`SELECT coalesce(sum("onHandQuantity"),0)::text AS q, coalesce(sum("totalValueBase"),0)::text AS v FROM inventory_valuation_state`))[0];
  return { qty: Number(r.q), value: Number(r.v) };
}

export const journalCount = async (env: InvGlEnv) => Number((await env.dsA.query('SELECT count(*) AS n FROM accounting_journal_entries'))[0].n);
