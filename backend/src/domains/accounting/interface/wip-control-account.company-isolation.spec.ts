import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IFRS_SME_TEMPLATE } from '../domain/account-templates/ifrs-sme.template';
import { GLAccountService } from '../application/gl-account.service';
import { CurrencyService } from '../application/currency.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { WipReconciliationService } from '../application/wip-reconciliation.service';
import { LedgerService } from '../application/ledger.service';
import { WorkOrderService } from '../../manufacturing/application/work-order.service';
import { RoutingService } from '../../manufacturing/application/routing.service';
import { ManufacturingWipLedgerService } from '../../manufacturing/application/manufacturing-wip-ledger.service';
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

/**
 * ACCOUNTING GAP — WIP CONTROL ACCOUNT (Manufacturing handoff H2, 2026-10-06; D10 CLOSED, ADR-075).
 *
 * The `ifrs-sme` starter chart used to ship no active postable account with `controlFunction = 'wip'`, so a Company
 * that imported it got every Manufacturing Financial Event REJECTED ("no active postable account has controlFunction
 * "wip" — assign one first"). The template now carries `1150 Work in Process` (asset, debit-normal, control `wip`).
 *
 * This spec proves it end to end on REAL Postgres (two disposable Company databases), with NO hand-seeded WIP account:
 *   A — a fresh Company imports the template through `GLAccountService.importTemplate`, runs a real Work Order
 *       (release → material issue → material return → finished-goods output) and every Financial Event POSTS the
 *       exact ADR-061 §13 entry (Dr WIP / Cr Inventory · Dr Inventory / Cr WIP · Dr Inventory / Cr WIP); the GL `wip`
 *       balance equals the Manufacturing WIP subledger (`WipReconciliationService` → matched).
 *   B — a Company whose chart pre-dates the fix (template imported WITHOUT 1150) still gets the clear REJECTED reason,
 *       nothing is posted, and the documented recovery (create/assign a `wip` account, re-drive the event) posts it.
 * Manufacturing code, the Event Engine and the posting gate are untouched; the account is chart data only.
 */
describe('WIP control account in the ifrs-sme template (H2) — static template contract', () => {
  const wip = IFRS_SME_TEMPLATE.accounts.filter((a) => a.controlFunction === 'wip');

  it('carries exactly one wip control account: 1150, asset, postable, under the Current Assets header, never contra', () => {
    expect(wip).toHaveLength(1);
    expect(wip[0]).toMatchObject({ code: '1150', accountType: 'asset', parentCode: '11', controlFunction: 'wip' });
    expect(wip[0].isPostable ?? true).toBe(true);
    expect(wip[0].isContra ?? false).toBe(false);
  });

  it('is ordered parents-before-children, has no duplicate code, and 1150 does not collide with another account', () => {
    const codes = IFRS_SME_TEMPLATE.accounts.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const seen = new Set<string>();
    for (const a of IFRS_SME_TEMPLATE.accounts) {
      if (a.parentCode) expect(seen.has(a.parentCode)).toBe(true);
      seen.add(a.code);
    }
  });
});

describe('WIP control account (H2) — real-Postgres, template import → Work Order GL posting', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let ambient: DataSource;
  let glAccounts: GLAccountService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let workOrders: WorkOrderService;
  let bom: BomService;
  let inventory: InventoryService;
  let valuation: InventoryValuationService;
  let wipReconciliation: WipReconciliationService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);

  type Key = 'A' | 'B';
  const seeded: Record<Key, { warehouseId: string; finishedId: string; componentId: string; workOrderId: string }> = {
    A: { warehouseId: '', finishedId: '', componentId: '', workOrderId: '' },
    B: { warehouseId: '', finishedId: '', componentId: '', workOrderId: '' },
  };
  const ds = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seedCompany(k: Key) {
    const d = await ds(k);
    const m = d.manager;
    await d.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'WIP Planner',$2) ON CONFLICT DO NOTHING`, [actor, `wip-${k}@test.local`]);

    // fiscal calendar + the process instances a user-created year/period would have, JE numbering
    const fy = randomUUID();
    const fp = randomUUID();
    await d.query(`INSERT INTO "accounting_fiscal_years" ("id","code","startDate","endDate") VALUES ($1,'FY',$2,$3)`, [fy, `${year}-01-01`, `${year}-12-31`]);
    await d.query(`INSERT INTO "accounting_fiscal_periods" ("id","fiscalYearId","code","startDate","endDate") VALUES ($1,$2,'P',$3,$4)`, [fp, fy, `${year}-01-01`, `${year}-12-31`]);
    await d.query(
      `INSERT INTO "process_instances" ("id","definitionKey","entityType","entityId","currentState") VALUES ($1,'accounting_fiscal_year','FiscalYear',$2,'active'), ($3,'accounting_fiscal_period','FiscalPeriod',$4,'open')`,
      [randomUUID(), fy, randomUUID(), fp],
    );
    await new NumberingService(ambient).registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, m);

    // Manufacturing master data: warehouse, finished product, component (2 per unit), valued stock 100 @ 5.00
    const warehouseId = randomUUID();
    const finishedId = randomUUID();
    const componentId = randomUUID();
    await d.query(`INSERT INTO "warehouses" ("id","code","name","status","kind") VALUES ($1,$2,$3,'active','main')`, [warehouseId, `WH-${k}`, `${k} Warehouse`]);
    await d.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'50.00','active')`, [finishedId, `FIN-${k}`, `${k} Finished`]);
    await d.query(`INSERT INTO "products" ("id","sku","name","unitPrice","status") VALUES ($1,$2,$3,'5.00','active')`, [componentId, `COMP-${k}`, `${k} Component`]);
    await bom.defineBom(finishedId, [{ componentProductId: componentId, quantityPerUnit: 2 }], actor, m);
    await inventory.recordMovement(warehouseId, componentId, 100, 'receipt', 'seed', 'seed', actor, m);
    await valuation.recordReceiptCost(componentId, warehouseId, 100, '5.0000', `wip-spec-seed-${k}`, m);
    seeded[k] = { warehouseId, finishedId, componentId, workOrderId: '' };
  }

  /**
   * `importTemplate` publishes one `accounting.gl_account.created` outbox row per account and does not flush them;
   * `dispatchAfterCommit` claims at most 50 rows, oldest first. Drain that backlog the way the per-Company scheduler
   * would, so the Work Order event that follows is dispatched in-request instead of waiting behind it.
   */
  async function drainOutbox(k: Key) {
    const m = (await ds(k)).manager;
    for (let i = 0; i < 20; i++) {
      const r = await events.dispatchAfterCommit(m);
      if (r.dispatched + r.failed === 0) return;
    }
    throw new Error('outbox did not drain');
  }

  async function startWorkOrder(k: Key) {
    const m = (await ds(k)).manager;
    const wo = await workOrders.createWorkOrder(seeded[k].finishedId, 5, seeded[k].warehouseId, actor, m); // 5 planned → 10 components required
    await workOrders.release(wo.id, actor, m);
    seeded[k].workOrderId = wo.id;
  }

  async function eventFor(k: Key, kind: 'material_issue' | 'material_return' | 'fg_output', requestId: string) {
    const rows: Array<{ id: string; eventType: string; status: string; rejectionReason: string | null; journalEntryId: string | null; totalValueBase: string }> = await (await ds(k)).query(
      `SELECT id, "eventType", status, "rejectionReason", "journalEntryId", payload->>'totalValueBase' AS "totalValueBase"
       FROM accounting_financial_events WHERE "idempotencyKey" = $1`,
      [`manufacturing:work_order:${seeded[k].workOrderId}:${kind}:${requestId}`],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function journalLines(k: Key, journalEntryId: string) {
    const rows: Array<{ code: string; controlFunction: string | null; debit: string; credit: string }> = await (await ds(k)).query(
      `SELECT a."code", a."controlFunction", jl."debitBase"::text AS debit, jl."creditBase"::text AS credit
       FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId"
       WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
      [journalEntryId],
    );
    return rows;
  }

  /** Closing balance through the same ledger read the reconciliation uses (POSTED entries only). */
  async function glBalance(k: Key, code: string): Promise<number> {
    const m = (await ds(k)).manager;
    const account = await glAccounts.getAccountByCode(code, m);
    return Number((await new LedgerService(h.controlPlane).getAccountLedger(account.id, {}, m)).closingBalanceBase);
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'wip_ctl_account', extraCompanyTags: ['sales', 'inventory', 'finance', 'accounting', 'manufacturing'] });
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
    financialEvents = new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config);
    financialEvents.onModuleInit();

    const products = new ProductsService(inert, audit, inert);
    bom = new BomService(inert, audit, products);
    valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
    inventory = new InventoryService(h.controlPlane, audit, inert, inert, numbering, inert, undefined); // seed movements only: no inventory GL event
    workOrders = new WorkOrderService(inert, inventory, numbering, processEngine, audit, events, bom, valuation as never, new RoutingService(inert, audit, products));
    wipReconciliation = new WipReconciliationService(h.controlPlane, new LedgerService(h.controlPlane), audit, new ManufacturingWipLedgerService(h.controlPlane, valuation as never));

    await seedCompany('A');
    await seedCompany('B');
  });

  afterAll(async () => {
    if (ambient?.isInitialized) await ambient.destroy();
    await h.teardown();
  });

  it('A — a fresh Company imports the ifrs-sme template: ONE active postable wip control account (1150) appears, shaped like every other control account', async () => {
    const mA = (await ds('A')).manager;
    expect(await glAccounts.listAccounts({}, mA)).toEqual([]); // genuinely fresh
    const result = await glAccounts.importTemplate('ifrs-sme', false, actor, mA);
    expect(result.created).toBe(IFRS_SME_TEMPLATE.accounts.length);
    await drainOutbox('A');

    const wip = (await glAccounts.listAccounts({}, mA)).filter((a) => a.controlFunction === 'wip');
    expect(wip).toHaveLength(1);
    expect(wip[0]).toMatchObject({
      code: '1150',
      accountType: 'asset',
      normalBalance: 'debit',
      isPostable: true,
      isActive: true,
      isContra: false,
      allowManualJournal: false, // a control account takes no manual journals (ADR-034 D4)
      currencyMode: 'functional_only',
    });
    const parent = await glAccounts.getAccount(wip[0].parentAccountId!, mA);
    expect(parent.code).toBe('11'); // Current Assets
    // the Inventory control account the same handlers need is there too — both legs resolvable from the template alone
    expect((await glAccounts.listAccounts({}, mA)).filter((a) => a.controlFunction === 'inventory').map((a) => a.code)).toEqual(['1120']);
  });

  it('A — Work Order: material issue → return → finished-goods output all POST the exact ADR-061 §13 entry with the template-only chart (no hand-seeded WIP account)', async () => {
    const mA = (await ds('A')).manager;
    await startWorkOrder('A');

    // 1. material issue: 4 × 5.00 = 20.00 — Dr WIP / Cr Inventory
    await workOrders.materialIssue(seeded.A.workOrderId, seeded.A.componentId, 4, actor, 'a-issue-1', mA);
    const issue = await eventFor('A', 'material_issue', 'a-issue-1');
    expect(issue).toMatchObject({ eventType: 'manufacturing.work_order.material_issued', status: 'POSTED', rejectionReason: null });
    expect(Number(issue.totalValueBase)).toBe(20);
    expect(await journalLines('A', issue.journalEntryId!)).toEqual([
      { code: '1150', controlFunction: 'wip', debit: '20.0000', credit: '0.0000' },
      { code: '1120', controlFunction: 'inventory', debit: '0.0000', credit: '20.0000' },
    ]);

    // 2. material return: 1 × 5.00 — exact reversal leg, Dr Inventory / Cr WIP
    await workOrders.materialReturn(seeded.A.workOrderId, seeded.A.componentId, 1, actor, 'a-return-1', mA);
    const ret = await eventFor('A', 'material_return', 'a-return-1');
    expect(ret).toMatchObject({ eventType: 'manufacturing.work_order.material_returned', status: 'POSTED' });
    expect(Number(ret.totalValueBase)).toBe(5);
    expect(await journalLines('A', ret.journalEntryId!)).toEqual([
      { code: '1120', controlFunction: 'inventory', debit: '5.0000', credit: '0.0000' },
      { code: '1150', controlFunction: 'wip', debit: '0.0000', credit: '5.0000' },
    ]);

    // 3. finished-goods output: 1 unit at the Work-Order-pooled cost — Dr Inventory / Cr WIP
    await workOrders.finishedGoodsOutput(seeded.A.workOrderId, 1, actor, 'a-output-1', mA);
    const out = await eventFor('A', 'fg_output', 'a-output-1');
    expect(out).toMatchObject({ eventType: 'manufacturing.work_order.finished_goods_received', status: 'POSTED' });
    const outValue = Number(out.totalValueBase);
    expect(outValue).toBeGreaterThan(0);
    const outLines = await journalLines('A', out.journalEntryId!);
    expect(outLines.map((l) => [l.code, l.controlFunction, Number(l.debit), Number(l.credit)])).toEqual([
      ['1120', 'inventory', outValue, 0],
      ['1150', 'wip', 0, outValue],
    ]);

    // every entry balanced; no P&L account touched anywhere (only the two control accounts appear in the whole journal)
    const entries: Array<{ d: string; c: string }> = await (await ds('A')).query(
      `SELECT SUM(jl."debitBase")::text AS d, SUM(jl."creditBase")::text AS c FROM accounting_journal_lines jl GROUP BY jl."journalEntryId"`,
    );
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(Number(e.d)).toBe(Number(e.c));
    const touched: Array<{ code: string }> = await (await ds('A')).query(
      `SELECT DISTINCT a."code" FROM accounting_journal_lines jl JOIN accounting_gl_accounts a ON a.id = jl."accountId" ORDER BY a."code"`,
    );
    expect(touched.map((t) => t.code)).toEqual(['1120', '1150']);

    // net WIP in the GL = issued − returned − output
    expect(await glBalance('A', '1150')).toBeCloseTo(20 - 5 - outValue, 4);
  });

  it('A — the GL wip control account equals the Manufacturing WIP subledger (WIP reconciliation → matched, drift 0.0000)', async () => {
    const mA = (await ds('A')).manager;
    const run = await wipReconciliation.reconcile({}, actor, mA);
    expect(run.status).toBe('matched');
    expect(Number(run.driftBase)).toBe(0);
    expect(Number(run.glBalanceBase)).toBeGreaterThan(0);
    expect(run.subledgerTotalBase).toBe(run.glBalanceBase);
  });

  it('B — a chart that PRE-DATES the fix (template imported without 1150) still fails closed with the explicit reason: REJECTED, nothing posted', async () => {
    const dB = await ds('B');
    const mB = dB.manager;
    await glAccounts.importTemplate('ifrs-sme', false, actor, mB);
    await dB.query(`DELETE FROM accounting_gl_accounts WHERE code = '1150'`); // emulate a Company provisioned before this change
    await drainOutbox('B');
    expect((await glAccounts.listAccounts({}, mB)).filter((a) => a.controlFunction === 'wip')).toEqual([]);

    await startWorkOrder('B');
    await workOrders.materialIssue(seeded.B.workOrderId, seeded.B.componentId, 4, actor, 'b-issue-1', mB);

    const issue = await eventFor('B', 'material_issue', 'b-issue-1');
    expect(issue.status).toBe('REJECTED');
    expect(issue.journalEntryId).toBeNull();
    expect(issue.rejectionReason).toMatch(/no active postable account has controlFunction "wip" — assign one first/);
    expect(await dB.query(`SELECT 1 FROM accounting_journal_entries`)).toEqual([]);
  });

  it('B — documented recovery: create a wip control account in that chart, re-drive the REJECTED event → POSTED Dr WIP / Cr Inventory', async () => {
    const mB = (await ds('B')).manager;
    const header = await glAccounts.getAccountByCode('11', mB);
    const created = await glAccounts.createAccount(
      { code: '1150', name: 'Work in Process', accountType: 'asset', parentAccountId: header.id, controlFunction: 'wip' },
      actor,
      mB,
    );
    expect(created.controlFunction).toBe('wip');

    const rejected = await eventFor('B', 'material_issue', 'b-issue-1');
    const redriven = await financialEvents.redrive(rejected.id, mB);
    expect(redriven.status).toBe('POSTED');
    expect(await journalLines('B', redriven.journalEntryId!)).toEqual([
      { code: '1150', controlFunction: 'wip', debit: '20.0000', credit: '0.0000' },
      { code: '1120', controlFunction: 'inventory', debit: '0.0000', credit: '20.0000' },
    ]);
  });

  it('Isolation — each Company owns its own wip account; A\'s postings never appear in B and vice-versa', async () => {
    const mA = (await ds('A')).manager;
    const mB = (await ds('B')).manager;
    const a = await glAccounts.getAccountByCode('1150', mA);
    const b = await glAccounts.getAccountByCode('1150', mB);
    expect(a.id).not.toBe(b.id);
    expect(await glBalance('B', '1150')).toBe(20);
    expect(await glBalance('A', '1150')).not.toBe(20);
  });
});
