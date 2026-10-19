import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../inventory-warehouse/application/warehouse-transactions.service';
import { InventoryPostingDispatchService } from '../../inventory-warehouse/application/inventory-posting-dispatch.service';
import { WarehouseTransactionsController } from '../../inventory-warehouse/interface/warehouse-transactions.controller';
import { InventoryController } from '../../inventory-warehouse/interface/inventory.controller';
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
import { PostingStatusService } from '../application/posting-status.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { Role } from '../../../foundation/authorization/role.entity';
import { UserRole } from '../../../foundation/authorization/user-role.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { InventoryPostingPolicyRegistry } from '../../../foundation/inventory-posting-policy/inventory-posting-policy.registry';
import { setUpTwoCompanyHarness, TwoCompanyHarness, assertDataSourceNeverRequestedFor } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * ADR-INV-04 (CTO authorisation 2026-10-19) - real PostgreSQL, Company A with Company B as the untouched witness.
 *  - the approved reason catalog and the reason / reference matrix are enforced at the SERVICE boundary BEFORE any write (number, document, line, process instance, audit, outbox);
 *  - modes: off (no check) / warn (allowed + audited) / enforce (refused);
 *  - G-ISS-1: an issue with a reason still posts Dr COGS / Cr Inventory - the reason changes no accounting;
 *  - the direct POST /inventory/movements receipt path respects inventory.receipt_approval_required (on = refused with zero writes, off = existing behaviour).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe('ADR-INV-04 - movement reason catalog, reference validation matrix, direct receipt endpoint vs approval policy - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let whTx: WarehouseTransactionsService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let valuation: InventoryValuationService;
  let ledger: LedgerService;
  let dispatch: InventoryPostingDispatchService;
  let controller: WarehouseTransactionsController;
  let invController: InventoryController;
  const actor = randomUUID();
  const worker = randomUUID(); // creates documents
  const supervisor = randomUUID(); // approves / posts
  const nobody = randomUUID(); // holds no role
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '4201', DONATION: '3105' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
    'inventory.document_sod_enforced': 'off',
    'inventory.receipt_approval_required': 'off',
    'inventory.reference_enforcement': 'enforce',
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
    for (const [uid, label, withRole] of [[worker, 'worker', true], [supervisor, 'supervisor', true], [nobody, 'nobody', false]] as Array<[string, string, boolean]>) {
      await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, `C3 ${label}`, `c3-${label}-${k}@test.local`]);
      if (withRole) await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), uid, role[0].id]);
    }
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
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_rev', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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

    // accounting binds ITS policy (reason map, fiscal gate, financial status) into the foundation holder, exactly as AccountingModule does at init.
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry, fiscalPeriods, postingStatus).onModuleInit();

    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policyRegistry, cfg);
    const dsA0 = await dsOf('A');
    const authorization = new AuthorizationService(dsA0.getRepository(Role), dsA0.getRepository(UserRole));
    whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry, valuation as never, cfg);
    dispatch = new InventoryPostingDispatchService(events, policyRegistry);
    controller = new WarehouseTransactionsController(whTx, {} as never, {} as never, dispatch);
    invController = new InventoryController(inventory, {} as never, products as never, {} as never, dispatch);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    ids.A.p = (await products.createProduct('R-P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
    ids.A.p2 = (await products.createProduct('R-P2', 'Product Two', '10.00', actor, null, dsA.manager)).id;
    ids.A.p3 = (await products.createProduct('R-P3', 'Product Three', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('C2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const snapshot = async () => ({
    stock: await cnt('A', 'stock_movements'),
    valuationRows: await cnt('A', 'inventory_valuation_movements'),
    valuationState: (await (await dsOf('A')).query(`SELECT "onHandQuantity"::text AS q, "totalValueBase"::text AS v FROM inventory_valuation_state ORDER BY "warehouseId"`)) as unknown[],
    outbox: await cnt('A', 'event_outbox'),
    events: await cnt('A', 'accounting_financial_events'),
    journals: await cnt('A', 'accounting_journal_entries'),
  });
  const lines = async (journalEntryId: string): Promise<string[]> =>
    ((await (await dsOf('A')).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    )) as Array<{ code: string; dr: string; cr: string }>).map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  const stateOf = async (id: string) => (await (await dsOf('A')).query(`SELECT "currentState" AS s FROM process_instances WHERE "definitionKey" = 'warehouse_transaction' AND "entityId" = $1`, [id]))[0].s as string;
  const stock = async (w: string, p: string) => Number((await (await dsOf('A')).query(`SELECT coalesce(sum(quantity),0)::int AS q FROM stock_movements WHERE "warehouseId" = $1 AND "productId" = $2`, [w, p]))[0].q);
  const asManager = async () => (await dsOf('A')).manager;
  const eventsOf = async (docId: string) =>
    (await (await dsOf('A')).query(`SELECT status, "journalEntryId", payload->>'glKind' AS "glKind" FROM accounting_financial_events WHERE payload->>'referenceId' = $1 ORDER BY "receivedAt"`, [docId])) as Array<{ status: string; journalEntryId: string | null; glKind: string }>;

  async function call(action: string, id: string, as: string = supervisor): Promise<Loose> {
    const dsA = await dsOf('A');
    return (await controller.transition({ user: { id: as }, companyContext: { dataSource: dsA } } as never, id, { action } as never)) as Loose;
  }
  /** create + post a document through the real workflow; returns its id */
  async function countDoc(w: string, p: string, physical: number): Promise<string> {
    const m = await asManager();
    const d = await whTx.startCount(w, [p], worker, m);
    const ls = await whTx.getLines(d.id, m);
    await whTx.recordCountResults(d.id, [{ lineId: ls[0].id, physicalQuantity: physical }], m);
    await call('submit', d.id, worker);
    expect((await call('approve', d.id, supervisor)).state).toBe('posted');
    await dispatch.dispatchAndReport(m, [{ referenceType: '*', referenceId: d.id }]);
    return d.id;
  }

  const P1 = () => ids.A.p;
  const NOTE = 'written justification of at least twenty characters';
  const mk = async (type: 'receipt' | 'issue' | 'adjustment', over: { reason?: string | null; note?: string | null; refType?: string | null; refId?: string | null; qty?: number } = {}) => {
    const m = await asManager();
    return whTx.createTransaction(
      type, ids.A.wh, null,
      [{ productId: P1(), quantity: over.qty ?? (type === 'adjustment' ? 1 : 2), unitCostBase: type === 'receipt' ? '4.00' : undefined } as never],
      null, null, 'note' in over ? over.note! : NOTE, worker, undefined, m,
      'reason' in over ? over.reason : undefined, over.refType ?? null, over.refId ?? null,
    );
  };
  const writes = async () => ({
    ...(await snapshot()),
    docs: await cnt('A', 'warehouse_transactions'),
    lines: await cnt('A', 'warehouse_transaction_lines'),
    process: await cnt('A', 'process_instances'),
    audit: await cnt('A', 'audit_records'),
    numbering: (await (await dsOf('A')).query(`SELECT count(*)::text AS n, coalesce(sum("lastNumber"),0)::text AS s FROM numbering_sequences`))[0] as unknown,
  });
  async function refused(fn: () => Promise<unknown>, re: RegExp) {
    const before = await writes();
    await expect(fn()).rejects.toThrow(re);
    expect(await writes()).toEqual(before);
  }
  const auditCount = async (action: string) => Number((await (await dsOf('A')).query(`SELECT count(*) AS n FROM audit_records WHERE action = $1`, [action]))[0].n);

  it('1. enforce: a valid receipt (catalog reason + written note) is accepted, stores its reason and posts', async () => {
    const d = await mk('receipt', { reason: 'FOUND_STOCK' });
    expect(d.reasonCode).toBe('FOUND_STOCK');
    expect((await call('submit', d.id, worker)).state).toBe('posted');
    await dispatch.dispatchAndReport(await asManager(), [{ referenceType: '*', referenceId: d.id }]);
    expect(await stock(ids.A.wh, P1())).toBe(2);
  });

  it('2. enforce: ISSUE with a reason posts Dr COGS / Cr Inventory exactly as before (G-ISS-1: no accounting change) and stores the reason', async () => {
    const d = await mk('issue', { reason: 'internal_consumption', qty: 1 });
    expect(d.reasonCode).toBe('internal_consumption');
    await call('submit', d.id, worker);
    expect((await call('approve', d.id, supervisor)).state).toBe('posted');
    await dispatch.dispatchAndReport(await asManager(), [{ referenceType: '*', referenceId: d.id }]);
    const [e] = await eventsOf(d.id);
    expect(e.status).toBe('POSTED');
    expect(await lines(e.journalEntryId!)).toEqual(['1120 C 4.00', '5101 D 4.00']);
  });

  it('3. enforce: refusals leave ZERO writes (no number, document, line, process instance, audit, outbox, stock, journal)', async () => {
    const cases: Array<[() => Promise<unknown>, RegExp]> = [
      [() => mk('issue', { reason: null }), /reason code is required/i],
      [() => mk('issue', { reason: 'because' }), /not in the approved catalog/i],
      [() => mk('issue', { reason: 'donation' }), /not valid for a issue/i],
      [() => mk('issue', { reason: 'sale' }), /reserved/i],
      [() => mk('receipt', { reason: 'opening_balance' }), /reserved/i],
      [() => mk('issue', { reason: 'sample', note: 'short' }), /written note/i],
      [() => mk('adjustment', { reason: 'count_variance' }), /stock count document/i],
      [() => mk('adjustment', { reason: 'count_variance', refType: 'warehouse_transaction', refId: randomUUID() }), /not found/i],
      [() => mk('adjustment', { reason: 'damage', refType: 'users', refId: randomUUID() }), /not accepted/i],
      [() => mk('adjustment', { reason: 'damage', refType: 'warehouse_transaction', refId: 'x; DROP TABLE users' }), /valid id/i],
      [() => mk('adjustment', { reason: 'damage', refType: 'warehouse_transaction' }), /both its type and its id/i],
      [() => mk('receipt', { reason: 'donation', refType: 'purchase_order', refId: randomUUID() }), /Goods Receipt/i],
    ];
    for (const [fn, re] of cases) await refused(fn, re);
  });

  it('4. count_variance adjustment needs a POSTED count document of THIS Company: a draft count and a Company-B id are refused', async () => {
    const m = await asManager();
    const draft = await whTx.startCount(ids.A.wh, [P1()], worker, m);
    await refused(() => mk('adjustment', { reason: 'count_variance', refType: 'warehouse_transaction', refId: draft.id }), /not posted/i);
    const posted = await countDoc(ids.A.wh, P1(), 1);
    const ok = await mk('adjustment', { reason: 'count_variance', refType: 'warehouse_transaction', refId: posted, note: null });
    expect([ok.referenceType, ok.referenceId]).toEqual(['warehouse_transaction', posted]);
    // a document id that exists only in Company B must not be found through Company A's connection
    const dsB = await dsOf('B');
    const idB = randomUUID();
    const [whB] = await dsB.query(`SELECT id FROM warehouses LIMIT 1`);
    await dsB.query(`INSERT INTO "warehouse_transactions" ("id","transactionNumber","type","warehouseId","movementDate","createdByUserId") VALUES ($1,'B-CNT','count',$2,now(),$3)`, [idB, whB.id, worker]);
    await refused(() => mk('adjustment', { reason: 'count_variance', refType: 'warehouse_transaction', refId: idB }), /not found/i);
  });

  it('5. warn: allowed and audited; off: allowed and not audited', async () => {
    config['inventory.reference_enforcement'] = 'warn';
    const before = await auditCount('warehouse_transaction.reference_warning');
    const d = await mk('issue', { reason: null, qty: 1 });
    expect(d.reasonCode).toBeNull();
    expect(await auditCount('warehouse_transaction.reference_warning')).toBe(before + 1);
    config['inventory.reference_enforcement'] = 'off';
    await mk('issue', { reason: null, qty: 1 });
    expect(await auditCount('warehouse_transaction.reference_warning')).toBe(before + 1);
    config['inventory.reference_enforcement'] = 'enforce';
  });

  it('6. enforce at submit: a document created without a valid reason cannot be submitted - refused with no state change', async () => {
    config['inventory.reference_enforcement'] = 'off';
    const legacy = await mk('issue', { reason: null, qty: 1 });
    config['inventory.reference_enforcement'] = 'enforce';
    const before = await writes();
    await expect(call('submit', legacy.id, worker)).rejects.toThrow(/reason code is required/i);
    expect(await writes()).toEqual(before);
    expect(await stateOf(legacy.id)).toBe('draft');
  });

  it('7. DIRECT POST /inventory/movements vs inventory.receipt_approval_required: on = refused with zero writes; off = existing behaviour', async () => {
    const req = async () => ({ user: { id: worker }, companyContext: { dataSource: await dsOf('A') } }) as never;
    const body = { warehouseId: ids.A.wh, productId: P1(), movementType: 'receipt', quantity: 3, unitCostBase: '2.00', reasonCode: 'FOUND_STOCK' } as never;
    config['inventory.receipt_approval_required'] = 'on';
    const before = await writes();
    await expect(invController.recordMovement(await req(), body)).rejects.toThrow(/requires approval/i);
    expect(await writes()).toEqual(before);
    config['inventory.receipt_approval_required'] = 'off';
    const res = (await invController.recordMovement(await req(), body)) as Loose;
    expect(res.id).toBeTruthy();
    expect(await writes()).not.toEqual(before);
  });

  it('8. isolation: Company B stays untouched by every Company A operation', async () => {
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      await mk('issue', { reason: 'scrap_waste', qty: 1 });
    });
    expect(await cnt('B', 'stock_movements')).toBe(0);
    expect(await cnt('B', 'accounting_journal_entries')).toBe(0);
  });
});
