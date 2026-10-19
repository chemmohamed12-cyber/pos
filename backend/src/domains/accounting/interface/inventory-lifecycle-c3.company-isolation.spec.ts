import { randomUUID } from 'crypto';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { WarehouseTransactionsService } from '../../inventory-warehouse/application/warehouse-transactions.service';
import { InventoryPostingDispatchService } from '../../inventory-warehouse/application/inventory-posting-dispatch.service';
import { WarehouseTransactionsController } from '../../inventory-warehouse/interface/warehouse-transactions.controller';
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
import { InventoryReconciliationService } from '../application/inventory-reconciliation.service';
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
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';

/**
 * Inventory lifecycle, slice C2 (CTO authorisation 2026-10-18) - real PostgreSQL, Company A with Company B as the untouched witness.
 *  (A) IN-REQUEST POSTING DISPATCH: a document / movement request dispatches its financial events itself after its transaction commits, and REPORTS the truth
 *      about the GL side (`financialPosting`): never "posted" while an event is pending or rejected, never a hidden failure, safe under retry and overlap.
 *  (B) EXPLICIT BUSINESS DATE: the document's own date reaches the movement event, the valuation history row, the journal; validated before any write
 *      (calendar date, not in the future, open fiscal period); never replaced by the processing date.
 * The pipeline is the real one (service -> outbox -> event bus -> financial event -> costing handler -> journal -> ledger) with the REAL posting policy and
 * fiscal gate bound; the controller is called directly (guards are covered elsewhere). Every expected value is computed by hand. No tolerance anywhere.
 *
 * Fiscal calendar of the test Company (relative to today): one fiscal year [today-60 .. today+300]; period P1 [today-60 .. today-20] CLOSED; period P2
 * [today-19 .. today+300] OPEN. A date at today-30 is in the closed period; today-70 has no fiscal year at all.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe('Inventory lifecycle C3 - receipt approval and segregation of duties at the service/API boundary - real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let whTx: WarehouseTransactionsService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  let valuation: InventoryValuationService;
  let ledger: LedgerService;
  let recon: InventoryReconciliationService;
  let dispatch: InventoryPostingDispatchService;
  let controller: WarehouseTransactionsController;
  const actor = randomUUID();
  const worker = randomUUID(); // creates documents
  const supervisor = randomUUID(); // approves / posts
  const nobody = randomUUID(); // holds no role
  const daysFrom = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const at = (d: number) => new Date(`${daysFrom(d)}T12:00:00Z`);
  type Key = 'A' | 'B';

  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': { FOUND_STOCK: '4201' },
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
    'inventory.document_sod_enforced': 'off',
    'inventory.receipt_approval_required': 'off',
  };
  const ids: Record<Key, { wh: string; wh2: string; p: string }> = { A: { wh: '', wh2: '', p: '' }, B: { wh: '', wh2: '', p: '' } };
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
    h = await setUpTwoCompanyHarness({ namePrefix: 'inv_c3', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });
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
    recon = new InventoryReconciliationService(h.controlPlane, ledger, audit, valuation);

    // accounting binds ITS policy (reason map, fiscal gate, financial status) into the foundation holder, exactly as AccountingModule does at init.
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry, fiscalPeriods, postingStatus).onModuleInit();

    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policyRegistry);
    const dsA0 = await dsOf('A');
    const authorization = new AuthorizationService(dsA0.getRepository(Role), dsA0.getRepository(UserRole));
    whTx = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry, valuation as never, cfg);
    dispatch = new InventoryPostingDispatchService(events, policyRegistry);
    controller = new WarehouseTransactionsController(whTx, {} as never, {} as never, dispatch);

    await seed('A');
    await seed('B');
    const dsA = await dsOf('A');
    ids.A.p = (await products.createProduct('C2-P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('C2 teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const cnt = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);
  const eventsFor = async (docId: string) =>
    (await (await dsOf('A')).query(
      `SELECT fe.status, fe."rejectionReason", fe."journalEntryId", fe.id, fe.payload->>'businessDate' AS "eventDate", fe.payload->>'glKind' AS "glKind"
         FROM accounting_financial_events fe WHERE fe.payload->>'referenceId' = $1 ORDER BY fe."receivedAt"`,
      [docId],
    )) as Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null; id: string; eventDate: string; glKind: string }>;
  const journalDate = async (journalEntryId: string) => (await (await dsOf('A')).query(`SELECT "businessDate"::text AS d FROM accounting_journal_entries WHERE id = $1`, [journalEntryId]))[0].d as string;
  const glInventory = async (asOf?: string) => (await ledger.getAccountLedger((await (await dsOf('A')).query(`SELECT id FROM accounting_gl_accounts WHERE code = '1120'`))[0].id, asOf ? { to: asOf } : {}, (await dsOf('A')).manager)).closingBalanceBase;
  const snapshot = async () => ({
    stock: await cnt('A', 'stock_movements'),
    valuationRows: await cnt('A', 'inventory_valuation_movements'),
    valuationState: (await (await dsOf('A')).query(`SELECT "onHandQuantity"::text AS q, "totalValueBase"::text AS v FROM inventory_valuation_state ORDER BY "warehouseId"`)) as unknown[],
    outbox: await cnt('A', 'event_outbox'),
    events: await cnt('A', 'accounting_financial_events'),
    journals: await cnt('A', 'accounting_journal_entries'),
  });
  const setPeriod = async (periodId: string, state: 'open' | 'closed') =>
    (await dsOf('A')).query(`UPDATE process_instances SET "currentState" = $2 WHERE "entityId" = $1 AND "definitionKey" = 'accounting_fiscal_period'`, [periodId, state]);
  const flags = (sod: 'off' | 'warn' | 'on', approval: 'off' | 'on') => {
    config['inventory.document_sod_enforced'] = sod;
    config['inventory.receipt_approval_required'] = approval;
  };
  const docRow = async (id: string) => (await (await dsOf('A')).query(`SELECT "createdByUserId" AS c, "approvedByUserId" AS a, "postedByUserId" AS p FROM warehouse_transactions WHERE id = $1`, [id]))[0] as { c: string; a: string | null; p: string | null };
  const stateOf = async (id: string) => (await (await dsOf('A')).query(`SELECT "currentState" AS s FROM process_instances WHERE "definitionKey" = 'warehouse_transaction' AND "entityId" = $1`, [id]))[0].s as string;
  const lines = async (journalEntryId: string): Promise<string[]> =>
    ((await (await dsOf('A')).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM accounting_journal_lines jl JOIN accounting_gl_accounts ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    )) as Array<{ code: string; dr: string; cr: string }>).map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  const sodAudit = async (docId: string) => (await (await dsOf('A')).query(`SELECT "actorUserId" AS a, after FROM audit_records WHERE action = 'warehouse_transaction.sod_violation' AND "resourceId" = $1`, [docId])) as Array<{ a: string; after: Loose }>;

  async function call(action: string, id: string, as: string = supervisor): Promise<Loose> {
    const dsA = await dsOf('A');
    return (await controller.transition({ user: { id: as }, companyContext: { dataSource: dsA } } as never, id, { action } as never)) as Loose;
  }
  async function newDoc(type: 'receipt' | 'issue' | 'transfer' | 'adjustment', over: { qty?: number; cost?: string; date?: Date; by?: string } = {}) {
    const dsA = await dsOf('A');
    return whTx.createTransaction(
      type,
      ids.A.wh,
      type === 'transfer' ? ids.A.wh2 : null,
      [{ productId: ids.A.p, quantity: over.qty ?? 4, unitCostBase: type === 'receipt' ? (over.cost ?? '5.00') : undefined }],
      null,
      'c3 test',
      null,
      over.by ?? worker,
      over.date,
      dsA.manager,
      type === 'receipt' ? 'FOUND_STOCK' : null,
    );
  }

  // ==========================================================================================================================================================
  // C3 (ADR-INV-03). Users: `worker` creates documents, `supervisor` approves, `nobody` holds no role at all. Expected values by hand:
  //   receipt 4 @ 5.00 -> valuation +20.0000, GL Dr 1120 20.00 / Cr 4201 20.00; issue 1 at the average 5.0000 -> valuation -5.0000, GL Dr 5101 5.00 / Cr 1120 5.00.
  // ==========================================================================================================================================================
  it('1. flags OFF = the pre-C3 behaviour, untouched: a receipt auto-posts on submit and a creator approving their own issue is allowed with no audit', async () => {
    flags('off', 'off');
    const r = await newDoc('receipt', { qty: 4, cost: '5.00' });
    const res = await call('submit', r.id, worker);
    expect(res.state).toBe('posted');
    expect(res.financialPosting.status).toBe('posted');
    const [e] = await eventsFor(r.id);
    expect(await lines(e.journalEntryId!)).toEqual(['1120 D 20.00', '4201 C 20.00']);
    // own issue: submit, then the creator approves it themselves (allowed while off)
    const i = await newDoc('issue', { qty: 1 });
    await call('submit', i.id, worker);
    expect((await call('approve', i.id, worker)).state).toBe('posted');
    expect(await sodAudit(i.id)).toEqual([]);
  });

  it('2. receipt APPROVAL ON: submit leaves the document submitted with NOTHING written; nobody-without-a-role and the creator are refused; a different supervisor posts it exactly once', async () => {
    flags('on', 'on');
    const dsA = await dsOf('A');
    const r = await newDoc('receipt', { qty: 4, cost: '5.00' });
    const before = await snapshot();
    const submitted = await call('submit', r.id, worker);
    expect(submitted.state).toBe('submitted');
    expect(submitted.financialPosting.status).toBe('none');
    expect(await snapshot()).toEqual(before); // no stock, valuation, outbox, event or journal yet
    // unauthorised user (no role): 403, no mutation
    await expect(call('approve', r.id, nobody)).rejects.toThrow(/Role required/);
    expect(await snapshot()).toEqual(before);
    expect(await stateOf(r.id)).toBe('submitted');
    // the creator cannot approve (or post) their own receipt: 403 Separation of duties, no mutation, state unchanged
    await expect(call('approve', r.id, worker)).rejects.toThrow(/Separation of duties/);
    await expect(call('post', r.id, worker)).rejects.toThrow(/Separation of duties/);
    expect(await snapshot()).toEqual(before);
    expect(await stateOf(r.id)).toBe('submitted');
    // another authorised user approves: posted once, Dr Inventory / Cr reason account, approver recorded
    const res = await call('approve', r.id, supervisor);
    expect(res.state).toBe('posted');
    expect(res.financialPosting).toMatchObject({ status: 'posted' });
    const [e] = await eventsFor(r.id);
    expect(e.status).toBe('POSTED');
    expect(await lines(e.journalEntryId!)).toEqual(['1120 D 20.00', '4201 C 20.00']);
    expect(await docRow(r.id)).toEqual({ c: worker, a: supervisor, p: supervisor });
    expect((await valuation.getValuedPositions(undefined, {}, dsA.manager)).map((p) => [p.quantity, p.totalValueBase])).toEqual([[7, '35.0000']]); // test 1: +4 (20.00) -1 (5.00 issue) = 3 u / 15.00; this receipt +4 (20.00) = 7 u / 35.00
    expect(await glInventory()).toBe('35.0000'); // 20 (t1) + 20 (t2) - 5 (the issue of t1)
  });

  it('3. DUPLICATE and PARALLEL requests: a repeated approval changes nothing, a repeated post is a no-op, two simultaneous approvals post exactly one document effect', async () => {
    flags('on', 'on');
    const r = await newDoc('receipt', { qty: 2, cost: '5.00' });
    await call('submit', r.id, worker);
    const journals0 = await cnt('A', 'accounting_journal_entries');
    const stock0 = await cnt('A', 'stock_movements');
    const settled = await Promise.allSettled([call('approve', r.id, supervisor), call('approve', r.id, supervisor)]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
    expect(await cnt('A', 'stock_movements')).toBe(stock0 + 1);
    expect(await cnt('A', 'accounting_journal_entries')).toBe(journals0 + 1);
    const snap = await snapshot();
    await expect(call('approve', r.id, supervisor)).rejects.toThrow(/not valid from state "posted"/);
    expect((await call('post', r.id, supervisor)).state).toBe('posted'); // idempotent no-op
    expect(await snapshot()).toEqual(snap);
    expect(await eventsFor(r.id)).toHaveLength(1);
  });

  it('4. WARN mode: the creator approving their own document is ALLOWED and audited (once, with the attempted action); the document posts once', async () => {
    flags('warn', 'on');
    const r = await newDoc('receipt', { qty: 1, cost: '5.00' });
    await call('submit', r.id, worker);
    const res = await call('approve', r.id, worker);
    expect(res.state).toBe('posted');
    expect(res.financialPosting.status).toBe('posted');
    const audit = await sodAudit(r.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].a).toBe(worker);
    expect(audit[0].after).toMatchObject({ mode: 'warn', attemptedAction: 'approve', type: 'receipt' });
    expect(await eventsFor(r.id)).toHaveLength(1);
  });

  it('5. SoD ON for every document with a financial effect (issue, adjustment) but NOT for a transfer (no financial effect, Model A)', async () => {
    flags('on', 'off');
    const dsA = await dsOf('A');
    const issue = await newDoc('issue', { qty: 1 });
    await call('submit', issue.id, worker);
    const before = await snapshot();
    await expect(call('approve', issue.id, worker)).rejects.toThrow(/Separation of duties/);
    expect(await snapshot()).toEqual(before);
    expect((await call('approve', issue.id, supervisor)).state).toBe('posted');
    const adj = await newDoc('adjustment', { qty: 1 });
    await call('submit', adj.id, worker);
    await expect(call('approve', adj.id, worker)).rejects.toThrow(/Separation of duties/);
    expect((await call('approve', adj.id, supervisor)).state).toBe('posted');
    // a transfer has no financial effect: the creator may approve it
    const tr = await newDoc('transfer', { qty: 1 });
    await call('submit', tr.id, worker);
    expect((await call('approve', tr.id, worker)).state).toBe('posted');
    // NOTE (finding, not tested here): document REVERSAL cannot be exercised - it fails at insert (`movementDate` NOT NULL, never set by reverseTransaction, a
    // baseline defect), and once that is fixed an issue reversal would consume valuation a second time while the GL restores inventory (valuation/GL drift of
    // twice the cost). Both are reported as decisions needed; the SoD exemption for reversal documents is therefore only a code-level rule (NOT TESTED end to end).
    expect(await dsA.query(`SELECT count(*)::int AS n FROM warehouse_transactions WHERE "reversalOfTransactionId" IS NOT NULL`)).toEqual([{ n: 0 }]);
  });

  it('6. FAILED POSTING after approval is recoverable and still segregated: a closed period refuses the post with the document left approved and nothing written; the creator still cannot post it; the supervisor posts it once after the period reopens', async () => {
    flags('on', 'on');
    const r = await newDoc('receipt', { qty: 3, cost: '5.00', date: at(-30) }); // today-30 lies in the CLOSED period
    await call('submit', r.id, worker);
    const before = await snapshot();
    await expect(call('approve', r.id, supervisor)).rejects.toThrow(/not open/);
    expect(await snapshot()).toEqual(before);
    expect(await stateOf(r.id)).toBe('approved'); // the approval stands; the post is retried
    await expect(call('post', r.id, worker)).rejects.toThrow(/Separation of duties/);
    await setPeriod(periodIds.closed, 'open');
    const res = await call('post', r.id, supervisor);
    expect(res.state).toBe('posted');
    expect(res.financialPosting.status).toBe('posted');
    const evs = await eventsFor(r.id);
    expect(evs).toHaveLength(1);
    expect(await journalDate(evs[0].journalEntryId!)).toBe(daysFrom(-30));
    await setPeriod(periodIds.closed, 'closed');
  });

  it('7. CONSISTENCY and COMPANY ISOLATION: valuation = GL = matched after every path above; every posted document has exactly one POSTED event; Company B untouched', async () => {
    const dsA = await dsOf('A');
    const dsB = await dsOf('B');
    const p = (await recon.preview({}, dsA.manager)) as Loose;
    expect([p.status, p.classification, p.driftBase]).toEqual(['matched', 'matched', '0.0000']);
    expect(await valuation.checkHistoryConsistency(dsA.manager)).toEqual([]);
    expect((await dsA.query(`SELECT count(*)::int AS n FROM accounting_financial_events WHERE status <> 'POSTED'`))[0].n).toBe(0);
    expect(await dsA.query(`SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`)).toEqual([]);
    for (const t of ['stock_movements', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox', 'warehouse_transactions']) {
      expect({ t, n: await cnt('B', t) }).toEqual({ t, n: 0 });
    }
    expect(((await recon.preview({}, dsB.manager)) as Loose).classification).toBe('matched');
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
    expect((await dsB.query(`SELECT count(*)::int AS n FROM audit_records WHERE action = 'warehouse_transaction.sod_violation'`))[0].n).toBe(0);
  });
});
