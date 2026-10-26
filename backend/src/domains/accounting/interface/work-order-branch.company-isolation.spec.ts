import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { GLAccountService } from '../application/gl-account.service';
import { CurrencyService } from '../application/currency.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { WorkOrderService } from '../../manufacturing/application/work-order.service';
import { RoutingService } from '../../manufacturing/application/routing.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { BomService } from '../../commerce/application/bom.service';
import { ProductsService } from '../../commerce/application/products.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { createAmbientDataSource } from '../../../foundation/testing/ambient-test-datasource';
import { IFRS_SME_TEMPLATE } from '../domain/account-templates/ifrs-sme.template';

/**
 * Org engine WP-C (decision D-C option A) — real PostgreSQL. A work order belongs to the branch of its PRODUCTION warehouse (stamped at creation, never rewritten); its WIP
 * warehouse carries the same branch; material issue / return / finished-goods postings carry it on their journal lines; a work order on an unassigned warehouse stays company-level
 * (NULL, no default branch); totals and the Dr/Cr shape are unchanged. Inter-branch settlement of components drawn from another branch's warehouse is NOT part of this rule (open decision).
 */
describe('WP-C — manufacturing orders attributed to the production warehouse branch — real-Postgres', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let workOrders: WorkOrderService;
  let events: EventBusService;
  let inventory: InventoryService;
  let glAccounts: GLAccountService;
  const actor = randomUUID();
  const year = new Date().toISOString().slice(0, 4);
  const ids = { root: randomUUID(), x: randomUUID(), y: randomUUID(), whX: randomUUID(), whN: randomUUID(), finished: randomUUID(), component: randomUUID() };
  const ds = () => h.connections.getDataSource(h.companyAId);

  async function drainOutbox() {
    const m = (await ds()).manager;
    for (let i = 0; i < 20; i++) {
      const r = await events.dispatchAfterCommit(m);
      if (r.dispatched + r.failed === 0) return;
    }
    throw new Error('outbox did not drain');
  }
  async function eventLines(workOrderId: string, kind: string, requestId: string) {
    const d = await ds();
    const ev = await d.query(`SELECT id, status, "journalEntryId", "orgUnitId" FROM accounting_financial_events WHERE "idempotencyKey" = $1`, [`manufacturing:work_order:${workOrderId}:${kind}:${requestId}`]);
    expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe('POSTED');
    // the entry carries the unit (a line without its own inherits it - the same COALESCE the organizational report uses)
    const entry = (await d.query(`SELECT "orgUnitId" FROM accounting_journal_entries WHERE id = $1`, [ev[0].journalEntryId]))[0];
    expect(entry.orgUnitId).toBe(ev[0].orgUnitId);
    const lines = await d.query(
      `SELECT a."code", COALESCE(jl."orgUnitId", je."orgUnitId") AS unit, jl."debitBase"::text AS debit, jl."creditBase"::text AS credit FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" JOIN accounting_journal_entries je ON je.id = jl."journalEntryId" WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
      [ev[0].journalEntryId],
    );
    return { event: ev[0], lines };
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wpc_wo_branch', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'manufacturing'] });
    ambient = await createAmbientDataSource(h);
    const inert = {} as never;
    const audit = new AuditService(h.controlPlane);
    const numbering = new NumberingService(h.controlPlane);
    events = new EventBusService(inert, h.connections);
    const processEngine = new ProcessEngineService(h.controlPlane);
    const config = { get: () => undefined } as unknown as ConfigurationEngineService;
    const limits = new LimitService(ambient, { sync: async () => undefined } as never, audit);
    const currencies = new CurrencyService(h.controlPlane, audit);
    glAccounts = new GLAccountService(h.controlPlane, audit, events, limits, inert, currencies);
    const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
    const dimensions = new FinancialDimensionService(h.controlPlane, audit);
    const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
    new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();
    const products = new ProductsService(inert, audit, inert);
    const bom = new BomService(inert, audit, products);
    const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined);
    workOrders = new WorkOrderService(inert, inventory, numbering, processEngine, audit, events, bom, valuation as never, new RoutingService(inert, audit, products));

    const d = await ds();
    const m = d.manager;
    await d.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'WPC Planner','wpc@test.local')`, [actor]);
    const fy = randomUUID();
    const fp = randomUUID();
    await d.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await d.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await d.query(`INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`, [randomUUID(), fy, randomUUID(), fp]);
    await new NumberingService(ambient).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, m);
    expect((await glAccounts.importTemplate('ifrs-sme', false, actor, m)).created).toBe(IFRS_SME_TEMPLATE.accounts.length);
    await drainOutbox();
    await d.query(`INSERT INTO org_units (id,type,name) VALUES ($1,'company','Root')`, [ids.root]);
    await d.query(`INSERT INTO org_units (id,type,name,"parentId") VALUES ($1,'branch','X',$3),($2,'branch','Y',$3)`, [ids.x, ids.y, ids.root]);
    await d.query(`INSERT INTO "warehouses" ("id","code","name","status","kind","orgUnitId") VALUES ($1,'WH-X','X production','active','main',$2),($3,'WH-N','Unassigned production','active','main',NULL)`, [ids.whX, ids.x, ids.whN]);
    await d.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,'WPC-FIN','Finished','50.00','active'),($2,'WPC-COMP','Component','5.00','active')`, [ids.finished, ids.component]);
    await bom.defineBom(ids.finished, [{ componentProductId: ids.component, quantityPerUnit: 2 }], actor, m);
    for (const wh of [ids.whX, ids.whN]) {
      await inventory.recordMovement(wh, ids.component, 100, 'receipt', 'seed', 'seed', actor, m);
      await valuation.recordReceiptCost(ids.component, wh, 100, '5.0000', `wpc-seed-${wh}`, m);
    }
  });
  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown().catch(() => undefined);
  });

  it('a work order on a branch warehouse is stamped with that branch; its WIP warehouse carries it; issue, return and finished-goods entries carry it (entry unit, inherited by every line); amounts and Dr/Cr shape unchanged', async () => {
    const d = await ds();
    const m = d.manager;
    const wo = await workOrders.createWorkOrder(ids.finished, 5, ids.whX, actor, m);
    expect(wo.branchOrgUnitId).toBe(ids.x);
    await workOrders.release(wo.id, actor, m);
    const row = (await d.query(`SELECT "wipWarehouseId" FROM work_orders WHERE id = $1`, [wo.id]))[0];
    expect((await d.query(`SELECT "orgUnitId", kind FROM warehouses WHERE id = $1`, [row.wipWarehouseId]))[0]).toEqual({ orgUnitId: ids.x, kind: 'operational' });

    await workOrders.materialIssue(wo.id, ids.component, 4, actor, 'issue-1', m);
    const issue = await eventLines(wo.id, 'material_issue', 'issue-1');
    expect(issue.lines.map((l: { code: string; unit: string | null; debit: string; credit: string }) => [l.code, l.unit, Number(l.debit), Number(l.credit)])).toEqual([['1150', ids.x, 20, 0], ['1120', ids.x, 0, 20]]);
    await workOrders.materialReturn(wo.id, ids.component, 1, actor, 'return-1', m);
    const ret = await eventLines(wo.id, 'material_return', 'return-1');
    expect(ret.lines.map((l: { code: string; unit: string | null; debit: string; credit: string }) => [l.code, l.unit, Number(l.debit), Number(l.credit)])).toEqual([['1120', ids.x, 5, 0], ['1150', ids.x, 0, 5]]);
    await workOrders.finishedGoodsOutput(wo.id, 1, actor, 'output-1', m);
    const out = await eventLines(wo.id, 'fg_output', 'output-1');
    expect(out.lines.every((l: { unit: string | null }) => l.unit === ids.x)).toBe(true);
    expect(out.lines.map((l: { code: string }) => l.code)).toEqual(['1120', '1150']);
    expect(Number(out.lines[0].debit)).toBe(Number(out.lines[1].credit)); // balanced
  });

  it('a work order on an UNASSIGNED warehouse stays company-level: NULL stamp, NULL line units, same posting shape (no default branch is invented)', async () => {
    const d = await ds();
    const m = d.manager;
    const wo = await workOrders.createWorkOrder(ids.finished, 2, ids.whN, actor, m);
    expect(wo.branchOrgUnitId).toBeNull();
    await workOrders.release(wo.id, actor, m);
    await workOrders.materialIssue(wo.id, ids.component, 2, actor, 'issue-n', m);
    const issue = await eventLines(wo.id, 'material_issue', 'issue-n');
    expect(issue.lines.map((l: { code: string; unit: string | null }) => [l.code, l.unit])).toEqual([['1150', null], ['1120', null]]);
    const wip = (await d.query(`SELECT w."orgUnitId" FROM work_orders o JOIN warehouses w ON w.id = o."wipWarehouseId" WHERE o.id = $1`, [wo.id]))[0];
    expect(wip.orgUnitId).toBeNull();
  });

  it('the stamp is never rewritten: moving the warehouse to another branch later does not change an existing work order; a NEW one follows the new branch', async () => {
    const d = await ds();
    const m = d.manager;
    const before = await workOrders.createWorkOrder(ids.finished, 1, ids.whX, actor, m);
    await d.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.y, ids.whX]);
    expect((await d.query(`SELECT "branchOrgUnitId" FROM work_orders WHERE id = $1`, [before.id]))[0].branchOrgUnitId).toBe(ids.x);
    const after = await workOrders.createWorkOrder(ids.finished, 1, ids.whX, actor, m);
    expect(after.branchOrgUnitId).toBe(ids.y);
    await d.query(`UPDATE warehouses SET "orgUnitId" = $1 WHERE id = $2`, [ids.x, ids.whX]);
  });

  it('Company B is untouched', async () => {
    const dsB = await h.connections.getDataSource(h.companyBId);
    expect(Number((await dsB.query(`SELECT count(*)::int AS n FROM work_orders`))[0].n)).toBe(0);
  });
});
