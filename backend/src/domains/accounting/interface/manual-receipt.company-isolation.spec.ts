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
import { InventoryPostingPolicyService } from '../application/inventory-posting-policy.service';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
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
 * D3-B (2026-10-04, CTO-approved Manual Receipt policy) — real-Postgres proof, Company A with Company B as the
 * untouched witness. A manual receipt needs an explicit unit cost and a controlled reason code whose configured
 * offset GL account is a valid chart account; accounting value = quantity × unit cost; everything is validated BEFORE
 * any mutation; no fallback account / cost. Posting: Dr Inventory (1120) / Cr the reason-configured account.
 */
describe('D3-B — manual receipt policy (explicit cost + controlled reason → configured offset) — real-Postgres, A/B', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  let inventory: InventoryService;
  let warehouseTxns: WarehouseTransactionsService;
  let events: EventBusService;
  let financialEvents: FinancialEventService;
  const actor = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  type Key = 'A' | 'B';

  // reasonCode → GL account. FOUND_STOCK/DONATION are valid; GHOST is not in the chart; CTRL is a control account.
  const reasonMap: Record<string, string> = { FOUND_STOCK: '4201', DONATION: '3105', GHOST: '9999', CTRL: '1120' };
  const config: Record<string, unknown> = {
    'accounting.inventory_manual_receipt_reason_accounts': reasonMap,
    'accounting.inventory_opening_balance_account_code': '3105',
    'accounting.inventory_adjustment_gain_account_code': '4201',
    'accounting.inventory_adjustment_loss_account_code': '5201',
    'accounting.inventory_cogs_account_code': '5101',
  };
  const ids: Record<Key, { wh: string; product: string }> = { A: { wh: '', product: '' }, B: { wh: '', product: '' } };
  const dsOf = (k: Key) => h.connections.getDataSource(k === 'A' ? h.companyAId : h.companyBId);

  async function seedCompany(k: Key) {
    const ds = await dsOf(k);
    await ds.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'D3B Operator',$2) ON CONFLICT DO NOTHING`, [actor, `d3b-${k}@test.local`]);
    await ds.query(`INSERT INTO "roles" ("id","key") VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [randomUUID()]);
    const role: Array<{ id: string }> = await ds.query(`SELECT id FROM "roles" WHERE "key" = 'admin'`);
    await ds.query(`INSERT INTO "user_roles" ("id","userId","roleId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [randomUUID(), actor, role[0].id]);
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
    ids[k].wh = (await inventory.createWarehouse(`WH-${k}`, `Main ${k}`, null, null, null, 'main', ds.manager)).id;
  }

  beforeAll(async () => {
    h = await setUpTwoCompanyHarness({ namePrefix: 'd3b_manual_receipt', extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'] });

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

    // accounting binds ITS policy into the foundation holder, exactly as AccountingModule does at init.
    const policyRegistry = new InventoryPostingPolicyRegistry();
    new InventoryPostingPolicyService(cfg, policyRegistry).onModuleInit();

    const products = new ProductsService(h.controlPlane, audit, events);
    inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never, policyRegistry);
    const dsA0 = await dsOf('A');
    const authorization = new AuthorizationService(dsA0.getRepository(Role), dsA0.getRepository(UserRole));
    warehouseTxns = new WarehouseTransactionsService(h.controlPlane, numbering, processEngine, authorization, audit, products, inventory, policyRegistry);

    await seedCompany('A');
    await seedCompany('B');
    const dsA = await dsOf('A');
    ids.A.product = (await products.createProduct('P1', 'Product One', '10.00', actor, null, dsA.manager)).id;
  });

  afterAll(async () => {
    await h.teardown().catch((e) => console.warn('D3-B teardown warning: ' + (e instanceof Error ? e.message : String(e))));
  });

  // ---- helpers ----
  const flush = async (k: Key) => events.dispatchAfterCommit((await dsOf(k)).manager);
  const count = async (k: Key, table: string) => Number((await (await dsOf(k)).query(`SELECT count(*) AS n FROM "${table}"`))[0].n);

  /** Everything a rejected manual receipt must leave untouched. */
  async function snapshot(k: Key) {
    return {
      stock: await count(k, 'stock_movements'),
      docs: await count(k, 'warehouse_transactions'),
      docLines: await count(k, 'warehouse_transaction_lines'),
      valuation: (await (await dsOf(k)).query(`SELECT "warehouseId","onHandQuantity"::text AS q,"totalValueBase"::text AS v FROM "inventory_valuation_state" ORDER BY 1`)) as unknown[],
      outbox: await count(k, 'event_outbox'),
      journals: await count(k, 'accounting_journal_entries'),
    };
  }
  async function expectNoMutation(k: Key, fn: () => Promise<unknown>, messageRe: RegExp) {
    const before = await snapshot(k);
    await expect(fn()).rejects.toThrow(messageRe);
    expect(await snapshot(k)).toEqual(before);
  }
  async function manualReceiptEvents(k: Key) {
    return (await (await dsOf(k)).query(
      `SELECT fe.status, fe."rejectionReason", fe."journalEntryId", fe.id FROM "accounting_financial_events" fe
        WHERE fe."eventType" = 'inventory.movement.recorded' AND fe.payload->>'glKind' = 'manual_receipt' ORDER BY fe."receivedAt"`,
    )) as Array<{ status: string; rejectionReason: string | null; journalEntryId: string | null; id: string }>;
  }
  async function lines(k: Key, journalEntryId: string): Promise<string[]> {
    const rows: Array<{ code: string; dr: string; cr: string }> = await (await dsOf(k)).query(
      `SELECT ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE jl."journalEntryId" = $1 ORDER BY ga.code`,
      [journalEntryId],
    );
    return rows.map((r) => (Number(r.dr) > 0 ? `${r.code} D ${Number(r.dr).toFixed(2)}` : `${r.code} C ${Number(r.cr).toFixed(2)}`));
  }
  const totalValuation = async (k: Key) =>
    Number((await (await dsOf(k)).query(`SELECT coalesce(sum("totalValueBase"),0)::text AS v FROM "inventory_valuation_state"`))[0].v);
  const glInventoryBalance = async (k: Key) =>
    Number(
      (await (await dsOf(k)).query(
        `SELECT coalesce(sum(jl."debitBase" - jl."creditBase"), 0)::text AS b FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" WHERE ga.code = '1120'`,
      ))[0].b,
    );

  const receipt = async (k: Key, over: { cost?: string | null; reason?: string | null; qty?: number } = {}) => {
    const ds = await dsOf(k);
    return warehouseTxns.createTransaction(
      'receipt',
      ids[k].wh,
      null,
      [{ productId: ids[k].product, quantity: over.qty ?? 10, unitCostBase: 'cost' in over ? over.cost : '3.50' }],
      null,
      'free-text note, never drives accounting',
      null,
      actor,
      undefined,
      ds.manager,
      'reason' in over ? over.reason : 'FOUND_STOCK',
    );
  };

  it('1. VALID cost + VALID reason → posted: stock +10, valuation 10 @ 3.50, GL Dr 1120 35.00 / Cr the reason-configured account (4201)', async () => {
    const dsA = await dsOf('A');
    await assertDataSourceNeverRequestedFor(h.connections, h.companyBId, async () => {
      const txn = await receipt('A');
      expect(txn.reasonCode).toBe('FOUND_STOCK');
      const lns = await warehouseTxns.getLines(txn.id, dsA.manager);
      expect(Number(lns[0].unitCostBase)).toBe(3.5);
      expect(await warehouseTxns.transition(txn.id, 'submit', actor, dsA.manager)).toBe('posted');
      await flush('A');
    });
    const [e] = await manualReceiptEvents('A');
    expect(e.status).toBe('POSTED');
    expect(await lines('A', e.journalEntryId!)).toEqual(['1120 D 35.00', '4201 C 35.00']);
    const st = await dsA.query(`SELECT "onHandQuantity"::text AS q, "totalValueBase"::text AS v FROM "inventory_valuation_state" WHERE "warehouseId" = $1`, [ids.A.wh]);
    expect({ q: Number(st[0].q), v: Number(st[0].v) }).toEqual({ q: 10, v: 35 });
  });

  it('1b. a DIFFERENT valid reason selects ITS OWN offset account (DONATION → 3105) — no shared/generic account; the movement endpoint path behaves the same', async () => {
    const dsA = await dsOf('A');
    await inventory.recordManualReceipt(ids.A.wh, ids.A.product, 4, '2.50', 'DONATION', null, actor, dsA.manager);
    await flush('A');
    const evs = await manualReceiptEvents('A');
    expect(evs).toHaveLength(2);
    expect(evs[1].status).toBe('POSTED');
    expect(await lines('A', evs[1].journalEntryId!)).toEqual(['1120 D 10.00', '3105 C 10.00']);
  });

  it('2. MISSING / non-positive cost → rejected BEFORE mutation (no stock, document, valuation, outbox or journal change) — both entry paths', async () => {
    for (const cost of [null, '', '0', '-1', 'abc']) {
      await expectNoMutation('A', () => receipt('A', { cost }), /unit cost/i);
    }
    const dsA = await dsOf('A');
    for (const cost of [null, undefined, '', '0', '-2']) {
      await expectNoMutation('A', () => inventory.recordManualReceipt(ids.A.wh, ids.A.product, 5, cost as never, 'FOUND_STOCK', null, actor, dsA.manager), /unit cost/i);
    }
  });

  it('3. MISSING reason code → rejected BEFORE mutation — both entry paths (free-text `reason` alone is not accepted)', async () => {
    for (const reason of [null, '', '   ']) {
      await expectNoMutation('A', () => receipt('A', { reason }), /reason code/i);
    }
    const dsA = await dsOf('A');
    await expectNoMutation('A', () => inventory.recordManualReceipt(ids.A.wh, ids.A.product, 5, '3.00', undefined, null, actor, dsA.manager), /reason code/i);
  });

  it('4. reason WITHOUT a configured GL account → rejected BEFORE mutation, no fallback account is ever used', async () => {
    await expectNoMutation('A', () => receipt('A', { reason: 'UNMAPPED_REASON' }), /no configured offset GL account/i);
    const dsA = await dsOf('A');
    await expectNoMutation('A', () => inventory.recordManualReceipt(ids.A.wh, ids.A.product, 5, '3.00', 'MADE_UP', null, actor, dsA.manager), /no configured offset GL account/i);
  });

  it('5. WRONG GL mapping → rejected BEFORE mutation: account not in the chart (GHOST→9999) and a control account (CTRL→1120)', async () => {
    await expectNoMutation('A', () => receipt('A', { reason: 'GHOST' }), /does not exist in the chart/i);
    await expectNoMutation('A', () => receipt('A', { reason: 'CTRL' }), /control account/i);
    const dsA = await dsOf('A');
    await expectNoMutation('A', () => inventory.recordManualReceipt(ids.A.wh, ids.A.product, 5, '3.00', 'GHOST', null, actor, dsA.manager), /does not exist in the chart/i);
  });

  it('5b. config changes AFTER the draft was created → the post re-validates inside its transaction: rejected, document NOT posted, NOTHING mutated', async () => {
    const dsA = await dsOf('A');
    const txn = await receipt('A', { reason: 'DONATION', cost: '1.00', qty: 3 });
    const saved = reasonMap.DONATION;
    delete reasonMap.DONATION;
    try {
      await expectNoMutation('A', () => warehouseTxns.transition(txn.id, 'submit', actor, dsA.manager), /no configured offset GL account/i);
      // `submit` is its own committed step (pre-existing flow); the failed POST rolled back whole, so the document is NOT posted
      // and stays recallable — never "posted" with no movement.
      expect((await warehouseTxns.getTransaction(txn.id, dsA.manager)).state).toBe('submitted');
    } finally {
      reasonMap.DONATION = saved;
    }
  });

  it('5c. EVENT-TIME fail-closed: mapping removed between movement and GL event → REJECTED (reason + config key named), no journal, no fallback; restored → redrive POSTS', async () => {
    const dsA = await dsOf('A');
    const journalsBefore = await count('A', 'accounting_journal_entries');
    await inventory.recordManualReceipt(ids.A.wh, ids.A.product, 2, '5.00', 'FOUND_STOCK', null, actor, dsA.manager);
    const saved = reasonMap.FOUND_STOCK;
    delete reasonMap.FOUND_STOCK;
    await flush('A');
    const rejected = (await manualReceiptEvents('A')).find((e) => e.status === 'REJECTED')!;
    expect(rejected.rejectionReason).toMatch(/FOUND_STOCK/);
    expect(rejected.rejectionReason).toMatch(/accounting\.inventory_manual_receipt_reason_accounts/);
    expect(await count('A', 'accounting_journal_entries')).toBe(journalsBefore);

    reasonMap.FOUND_STOCK = saved;
    expect((await financialEvents.redrive(rejected.id, dsA.manager)).status).toBe('POSTED');
  });

  it('5d. a posted cost-bearing manual receipt is NOT reversible as a document (rejected before mutation) — Adjustment decrease is the approved route', async () => {
    const dsA = await dsOf('A');
    const [posted] = (await warehouseTxns.listTransactions({}, dsA.manager)).filter((t) => t.state === 'posted' && t.type === 'receipt');
    await expectNoMutation('A', () => warehouseTxns.transition(posted.id, 'reverse', actor, dsA.manager), /cannot be reversed as a document/i);
  });

  it('6/9/10. RECONCILIATION: Σ inventory valuation = GL Inventory 1120 after the whole scenario, and every journal is balanced', async () => {
    await flush('A');
    expect(await totalValuation('A')).toBeCloseTo(await glInventoryBalance('A'), 4);
    expect(await glInventoryBalance('A')).toBeCloseTo(35 + 10 + 10, 4); // 10×3.50 + 4×2.50 + 2×5.00
    const unbalanced = await (await dsOf('A')).query(
      `SELECT je.id FROM "accounting_journal_entries" je JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`,
    );
    expect(unbalanced).toEqual([]);
  });

  it('7/8. ISOLATION: everything stayed in Company A; Company B is untouched; the Platform/control-plane DB holds no outbox/stock/journal rows', async () => {
    const dsB = await dsOf('B');
    for (const t of ['stock_movements', 'warehouse_transactions', 'inventory_valuation_state', 'accounting_financial_events', 'accounting_journal_entries', 'event_outbox']) {
      expect({ t, n: Number((await dsB.query(`SELECT count(*) AS n FROM "${t}"`))[0].n) }).toEqual({ t, n: 0 });
    }
    expect(Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n)).toBe(0);
  });

  it('7b. Company B can run its OWN manual receipt (its own chart/valuation) and it posts only in B — A stays unchanged', async () => {
    const dsB = await dsOf('B');
    const aBefore = await snapshot('A');
    const productB = (await new ProductsService(h.controlPlane, new AuditService(h.controlPlane), events).createProduct('PB', 'Product B', '10.00', actor, null, dsB.manager)).id;
    ids.B.product = productB;
    await assertDataSourceNeverRequestedFor(h.connections, h.companyAId, async () => {
      await inventory.recordManualReceipt(ids.B.wh, productB, 5, '2.00', 'DONATION', null, actor, dsB.manager);
      await flush('B');
    });
    const [e] = await manualReceiptEvents('B');
    expect(e.status).toBe('POSTED');
    expect(await lines('B', e.journalEntryId!)).toEqual(['1120 D 10.00', '3105 C 10.00']);
    expect(await snapshot('A')).toEqual(aBefore);
  });
});
