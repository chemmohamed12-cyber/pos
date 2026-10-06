import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { PurchaseOrderService } from '../../procurement/application/purchase-order.service';
import { GoodsReceiptService } from '../../procurement/application/goods-receipt.service';
import { SupplierInvoiceService } from '../../procurement/application/supplier-invoice.service';
import { SupplierLedgerService } from '../../procurement/application/supplier-ledger.service';
import { SupplierPaymentService } from '../../procurement/application/supplier-payment.service';
import { TreasuryService } from '../../treasury/application/treasury.service';
import { InventoryService } from '../../inventory-warehouse/application/inventory.service';
import { ProductsService } from '../../commerce/application/products.service';
import { InventoryValuationService } from '../../inventory-valuation/application/inventory-valuation.service';
import { MovingAverageCostEngine } from '../../inventory-valuation/application/moving-average-cost-engine.service';
import { JournalEntryService, JOURNAL_ENTRY_DOCUMENT_TYPE } from '../application/journal-entry.service';
import { FinancialEventService } from '../application/financial-events/financial-event.service';
import { FinancialEventHandlerRegistry } from '../application/financial-events/handler-registry';
import { GLAccountService } from '../application/gl-account.service';
import { FiscalPeriodService } from '../application/fiscal-period.service';
import { CurrencyService } from '../application/currency.service';
import { FinancialDimensionService } from '../application/financial-dimension.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { ProcessEngineService } from '../../../foundation/process-engine/process-engine.service';
import { ConfigurationEngineService } from '../../../foundation/configuration-engine/configuration-engine.service';
import { setUpTwoCompanyHarness, TwoCompanyHarness } from '../../../foundation/testing/two-company-real-pg-harness';
import { makeProductLifecycleGate } from '../../procurement/interface/product-lifecycle-gate.test-helper';

/**
 * T0 — Clean-Company functional/accounting BASELINE (CTO-approved 2026-10-04, ERP Integrity Audit).
 * Disposable real-Postgres harness: fresh control-plane + two fresh Company databases, torn down afterwards.
 * Never touches the shared dev DB. Company A runs the scenario; Company B is the untouched witness.
 *
 * This spec RECORDS the current behavior as evidence — it is a baseline, not a remediation. It asserts only
 * the CTO's STOP conditions (fresh DB, isolation, balanced journals, no stuck/failed events, GL actually
 * posting in A). Observations that the audit expects to be wrong today (e.g. which GL account a supplier
 * payment credits, inventory GL vs valuation) are written to the evidence file and deliberately NOT asserted,
 * so later remediation (D2/D3/D5) does not "break" this baseline.
 *
 * Opt-in only: `T0_BASELINE=1 [T0_EVIDENCE_FILE=path] npx jest ...t0-clean-company-baseline.spec.ts`.
 */
const run = process.env.T0_BASELINE === '1' ? describe : describe.skip;

run('T0 clean-company baseline — real-Postgres, disposable', () => {
  jest.setTimeout(580_000);
  let h: TwoCompanyHarness;
  const actor = randomUUID();
  const approver = randomUUID(); // ESC-3 — maker != checker on the PO
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const evidence: Record<string, unknown> = {};

  const TABLES = [
    'stock_movements',
    'inventory_valuation_state',
    'accounting_financial_events',
    'accounting_journal_entries',
    'accounting_journal_lines',
    'supplier_ledger_entries',
    'supplier_payments',
    'supplier_invoices',
    'goods_receipts',
    'purchase_orders',
    'treasury_transactions',
    'event_outbox',
  ] as const;

  async function counts(ds: { query: (q: string) => Promise<Array<{ n: string }>> }): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number((await ds.query(`SELECT count(*) AS n FROM "${t}"`))[0].n);
    return out;
  }

  const sum = (rows: Array<{ v: string | null }>) => Number(rows[0]?.v ?? 0);

  it('runs the baseline and records evidence; asserts only the STOP conditions', async () => {
    h = await setUpTwoCompanyHarness({
      namePrefix: 't0_baseline',
      extraCompanyTags: ['sales', 'inventory', 'finance', 'procurement', 'accounting'],
    });
    try {
      const dsA = await h.connections.getDataSource(h.companyAId);
      const dsB = await h.connections.getDataSource(h.companyBId);
      const mA = dsA.manager;

      // ---- STOP condition: both Company DBs are fresh/empty straight after provisioning, BEFORE any seeding or business activity ----
      const before = await counts(dsA);
      const beforeB = await counts(dsB);
      evidence.freshness = { companyA_before: before, companyB_before: beforeB, treasuryAccounts: await dsA.query(`SELECT code, "glAccountCode" FROM "treasury_accounts" ORDER BY code`) };
      for (const t of TABLES) {
        expect({ t, n: before[t] }).toEqual({ t, n: 0 });
        expect({ t, n: beforeB[t] }).toEqual({ t, n: 0 });
      }


      // ---- services: all real; the ambient (control-plane) outbox repository is inert, the ambient DataSource has only 'core' tables ----
      const inert = {} as never;
      const audit = new AuditService(h.controlPlane);
      const numbering = new NumberingService(h.controlPlane);
      const events = new EventBusService(inert, h.connections);
      const processEngine = new ProcessEngineService(h.controlPlane);
      const config = { get: () => undefined } as unknown as ConfigurationEngineService;
      const currencies = new CurrencyService(h.controlPlane, audit);
      const glAccounts = new GLAccountService(h.controlPlane, audit, events, inert, inert, currencies);
      const fiscalPeriods = new FiscalPeriodService(h.controlPlane, processEngine, audit, inert, events, inert, inert);
      const dimensions = new FinancialDimensionService(h.controlPlane, audit);
      const journals = new JournalEntryService(h.controlPlane, glAccounts, fiscalPeriods, currencies, audit, events, numbering, processEngine, config, dimensions);
      new FinancialEventService(h.controlPlane, currencies, journals, audit, events, new FinancialEventHandlerRegistry(), config).onModuleInit();

      const products = new ProductsService(h.controlPlane, audit, events);
      const valuation = new InventoryValuationService(new MovingAverageCostEngine(h.controlPlane));
      const inventory = new InventoryService(h.controlPlane, audit, products as never, inert, numbering, events, valuation as never);
      const treasury = new TreasuryService(h.controlPlane, numbering, audit, inert, events);
      const purchaseOrders = new PurchaseOrderService(h.controlPlane, processEngine, numbering, audit, makeProductLifecycleGate(h.controlPlane));
      const goodsReceipts = new GoodsReceiptService(h.controlPlane, processEngine, numbering, audit, inventory, events, makeProductLifecycleGate(h.controlPlane));
      const supplierLedger = new SupplierLedgerService(h.controlPlane, numbering, audit);
      const invoices = new SupplierInvoiceService(h.controlPlane, numbering, processEngine, audit, supplierLedger, events);
      const payments = new SupplierPaymentService(h.controlPlane, numbering, audit, treasury, supplierLedger, invoices, events);

      // ---- minimal dataset (Company A only) ----
      await dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'T0 Operator','t0-op@test.local') ON CONFLICT DO NOTHING`, [actor]);
      await dsA.query(`INSERT INTO "users" ("id","fullName","email") VALUES ($1,'T0 Approver','t0-approver@test.local') ON CONFLICT DO NOTHING`, [approver]);
      const chart: Array<[string, string, string, string, string]> = [
        ['1101', 'Cash on Hand', 'asset', 'debit', 'bank'],
        ['1102', 'Bank — Current Account', 'asset', 'debit', 'bank'],
        ['1120', 'Inventory', 'asset', 'debit', 'inventory'],
        ['2101', 'Accounts Payable', 'liability', 'credit', 'ap'],
        ['2115', 'Goods Received Not Invoiced', 'liability', 'credit', 'grni'],
      ];
      for (const [code, name, type, normal, fn] of chart) {
        await dsA.query(
          `INSERT INTO "accounting_gl_accounts" ("id","code","name","accountType","normalBalance","isPostable","allowManualJournal","isActive","controlFunction")
           VALUES ($1,$2,$3,$4,$5,true,false,true,$6)`,
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
      await numbering.registerDocumentType(JOURNAL_ENTRY_DOCUMENT_TYPE, 'JV', true, mA);

      const wh = await inventory.createWarehouse('WH1', 'Main Warehouse', null, null, null, 'main', mA);
      const p1 = await products.createProduct('P1', 'Product One', '10.00', actor, null, mA);
      const p2 = await products.createProduct('P2', 'Product Two', '20.00', actor, null, mA);
      const supplierId = randomUUID();
      await dsA.query(`INSERT INTO "suppliers" ("id","code","legalName") VALUES ($1,'SUP-1','T0 Supplier')`, [supplierId]);

      const accountTypes = await treasury.listAccountTypes(mA);
      const bankType = accountTypes.find((t) => t.code === 'bank')!;
      const unmapped = (await dsA.query(`SELECT id, code FROM "treasury_accounts" WHERE "code" = 'MAIN-CASH'`))[0] as { id: string; code: string };
      const mapped = await treasury.createAccount('BANK-1', 'Bank Account 1 (GL-mapped)', bankType.id, actor, mA);
      await treasury.setAccountGlMapping(mapped.id, '1102', actor, mA);

      // ---- fund both treasury accounts through the real contract path (cashIn: non-emitting) ----
      await treasury.cashIn(mapped.id, '1000.00', null, null, null, 'T0 funding', actor, mA);
      await treasury.cashIn(unmapped.id, '1000.00', null, null, null, 'T0 funding', actor, mA);

      // ---- 1. inventory opening ----
      const opening = await inventory.importOpeningStockRows([{ warehouseCode: 'WH1', productSku: 'P1', quantity: '20', unitCost: '4.00' }], actor, mA);
      expect(opening.rejected).toEqual([]);

      // ---- 2. procurement chain: PO -> approve -> partial GR -> final GR -> invoice -> two payments ----
      const po = await purchaseOrders.create(
        { supplierId, warehouseId: wh.id, notes: 'T0', lines: [{ productId: p1.id, quantity: '10', unitCostBase: '5.00' }, { productId: p2.id, quantity: '4', unitCostBase: '12.50' }] },
        actor,
        mA,
      );
      await purchaseOrders.transition(po.id, 'submit', actor, mA);
      await purchaseOrders.transition(po.id, 'approve', approver, mA);
      const lines: Array<{ id: string; productId: string }> = await dsA.query(`SELECT id, "productId" FROM "purchase_order_lines" WHERE "purchaseOrderId" = $1`, [po.id]);
      const line = (pid: string) => lines.find((l) => l.productId === pid)!.id;

      await goodsReceipts.post({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: line(p1.id), quantityReceived: '10' }, { purchaseOrderLineId: line(p2.id), quantityReceived: '2' }] }, actor, mA);
      await goodsReceipts.post({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: line(p2.id), quantityReceived: '2' }] }, actor, mA);

      // STOP-condition capture: if a step touches something it must not, record WHERE and still dump the partial evidence (observation only, never a workaround)
      let stopError: unknown = null;
      let inv: { id: string; totalAmount: string } | null = null;
      const payNumbers: string[] = [];
      try {
        const draft = await invoices.createDraftInvoice(
          { purchaseOrderId: po.id, supplierReference: 'T0-INV-1', lines: [{ purchaseOrderLineId: line(p1.id), quantity: '10', unitCostBase: '5.00' }, { purchaseOrderLineId: line(p2.id), quantity: '4', unitCostBase: '12.50' }] },
          actor,
          mA,
        );
        inv = await invoices.postInvoice(draft.id, actor, mA);
        const pay1 = await payments.recordPayment(supplierId, inv.id, '60.00', 'bank_transfer', mapped.id, null, actor, mA);
        // D2 (2026-10-04): an UNMAPPED paying account is now rejected before any mutation (pre-D2 it was accepted and
        // posted to control account 1101 — recorded in T0-CLEAN-COMPANY-BASELINE-2026-10-04.md). Record the outcome as
        // evidence, then pay the remaining 40.00 from the mapped account.
        evidence.unmappedPaymentAttempt = await payments
          .recordPayment(supplierId, inv.id, '40.00', 'cash', unmapped.id, null, actor, mA)
          .then(
            () => 'ACCEPTED (unexpected after D2)',
            (e: unknown) => 'REJECTED: ' + (e instanceof Error ? e.message : String(e)),
          );
        const pay2 = await payments.recordPayment(supplierId, inv.id, '40.00', 'cash', mapped.id, null, actor, mA);
        payNumbers.push(pay1.paymentNumber, pay2.paymentNumber);

      } catch (e) {
        stopError = e;
        evidence.stopped = { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? (e.stack ?? '').split('\n').slice(0, 6) : [] };
      }

      // belt-and-braces: drain anything the in-request flush left (the per-Company scheduler's job in production)
      await events.dispatchAfterCommit(mA);

      // ================= evidence =================
      const after = await counts(dsA);
      const afterB = await counts(dsB);
      evidence.after = { companyA: after, companyB: afterB };

      const stock = await dsA.query(`SELECT p.sku, sum(m.quantity)::text AS on_hand FROM "stock_movements" m JOIN "products" p ON p.id = m."productId" GROUP BY 1 ORDER BY 1`);
      const valuationRows = await dsA.query(`SELECT p.sku, v."onHandQuantity"::text AS qty, v."totalValueBase"::text AS value, v."averageCostBase"::text AS avg FROM "inventory_valuation_state" v JOIN "products" p ON p.id = v."productId" ORDER BY 1`);
      const movementTypes = await dsA.query(`SELECT "movementType", count(*)::int AS n FROM "stock_movements" GROUP BY 1 ORDER BY 1`);
      evidence.inventory = { stockOnHand: stock, valuation: valuationRows, movementTypes };

      const fe = await dsA.query(`SELECT "eventType", status, count(*)::int AS n FROM "accounting_financial_events" GROUP BY 1,2 ORDER BY 1,2`);
      const feRejected = await dsA.query(`SELECT "eventType", "rejectionReason" FROM "accounting_financial_events" WHERE status NOT IN ('POSTED')`);
      const outboxStatus = await dsA.query(`SELECT topic, status, count(*)::int AS n FROM "event_outbox" GROUP BY 1,2 ORDER BY 1,2`);
      evidence.financialEvents = { byTypeStatus: fe, notPosted: feRejected, outbox: outboxStatus };

      const journalLines = await dsA.query(
        `SELECT je."entryNumber" AS jv, fe."eventType", ga.code, jl."debitBase"::text AS dr, jl."creditBase"::text AS cr
           FROM "accounting_journal_lines" jl
           JOIN "accounting_journal_entries" je ON je.id = jl."journalEntryId"
           JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId"
           LEFT JOIN "accounting_financial_events" fe ON fe."journalEntryId" = je.id
          ORDER BY je."createdAt", jl."lineNumber"`,
      );
      evidence.journalLines = journalLines;

      const unbalanced = await dsA.query(
        `SELECT je.id FROM "accounting_journal_entries" je JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = je.id GROUP BY je.id HAVING sum(jl."debitBase") <> sum(jl."creditBase")`,
      );
      const totals = await dsA.query(`SELECT sum("debitBase")::text AS dr, sum("creditBase")::text AS cr FROM "accounting_journal_lines"`);
      const gl = await dsA.query(
        `SELECT ga.code, ga.name, round(sum(jl."debitBase" - jl."creditBase"), 2)::text AS balance_dr_minus_cr
           FROM "accounting_journal_lines" jl JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId" GROUP BY 1,2 ORDER BY 1`,
      );
      evidence.gl = { totals: totals[0], unbalancedJournals: unbalanced, accountBalances: gl };

      const supplierNetAp = sum(await dsA.query(`SELECT sum(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)::text AS v FROM "supplier_ledger_entries"`));
      const ledgerRows = await dsA.query(`SELECT "entryType", direction, amount::text FROM "supplier_ledger_entries" ORDER BY "createdAt"`);
      const glBal = (code: string) => Number((gl as Array<{ code: string; balance_dr_minus_cr: string }>).find((r) => r.code === code)?.balance_dr_minus_cr ?? 0);
      evidence.supplierLedger = { entries: ledgerRows, netPayable: supplierNetAp, glAp2101: -glBal('2101'), grni2115: -glBal('2115') };

      const treasuryBalances = {
        mapped: { code: 'BANK-1', glAccountCode: '1102', treasuryBalance: await treasury.getAccountBalance(mapped.id, mA), gl1102: glBal('1102') },
        unmapped: { code: 'MAIN-CASH', glAccountCode: null, treasuryBalance: await treasury.getAccountBalance(unmapped.id, mA), gl1101: glBal('1101') },
      };
      evidence.treasury = treasuryBalances;

      // BASELINE observation (not asserted): which GL accounts did each supplier payment actually credit?
      evidence.paymentBankLeg = await dsA.query(
        `SELECT sp."paymentNumber", sp.amount::text, ta.code AS "paidFromTreasuryAccount", ta."glAccountCode" AS "treasuryMappedGl",
                (SELECT string_agg(ga.code || ' CR ' || jl."creditBase", ', ') FROM "accounting_financial_events" fe
                   JOIN "accounting_journal_lines" jl ON jl."journalEntryId" = fe."journalEntryId" AND jl."creditBase" > 0
                   JOIN "accounting_gl_accounts" ga ON ga.id = jl."accountId"
                  WHERE fe."sourceEntityId" = sp.id::text AND fe."eventType" = 'finance.supplier_payment.recorded') AS "glAccountCredited"
           FROM "supplier_payments" sp JOIN "treasury_accounts" ta ON ta.id = sp."treasuryAccountId" ORDER BY sp."paymentNumber"`,
      );
      evidence.invoice = inv ? { id: inv.id, totalAmount: inv.totalAmount, payments: payNumbers } : null;

      // ---- isolation witnesses ----
      const controlPlaneOutbox = Number((await h.controlPlane.query(`SELECT count(*) AS n FROM "event_outbox"`))[0].n);
      evidence.isolation = { controlPlaneOutboxRows: controlPlaneOutbox, companyB_after: afterB };

      const file = process.env.T0_EVIDENCE_FILE;
      if (file) writeFileSync(file, JSON.stringify(evidence, null, 2), 'utf8');
      console.log('T0_EVIDENCE ' + JSON.stringify(evidence));

      // a scenario step hit a STOP condition: the partial evidence is already on disk — surface the stop itself, do not assert past it
      if (stopError) throw stopError;

      // ================= STOP-condition assertions =================
      for (const t of TABLES) expect({ t, n: afterB[t] }).toEqual({ t, n: 0 }); // Company B untouched
      expect(controlPlaneOutbox).toBe(0); // nothing leaked to the Platform/shared DB
      expect(unbalanced).toEqual([]); // every journal balanced
      expect(Number((totals[0] as { dr: string }).dr)).toBeCloseTo(Number((totals[0] as { cr: string }).cr), 4); // Dr = Cr
      expect(after.accounting_journal_entries).toBeGreaterThan(0); // GL posting actually happened in Company A
      expect((feRejected as unknown[]).length).toBe(0); // no REJECTED/IGNORED/RECEIVED financial events
      const stuck = await dsA.query(`SELECT 1 FROM "event_outbox" WHERE status IN ('pending','processing','failed')`);
      expect(stuck).toEqual([]); // no event left failed/processing/pending
      const posted = (fe as Array<{ eventType: string; status: string; n: number }>).filter((r) => r.status === 'POSTED');
      const n = (t: string) => posted.find((r) => r.eventType === t)?.n ?? 0;
      expect(n('procurement.goods_receipt.posted')).toBe(2);
      expect(n('finance.supplier_invoice.posted')).toBe(1);
      expect(n('finance.supplier_payment.recorded')).toBe(2);
    } finally {
      // a teardown race ("permission denied to terminate process") must never mask the real assertion/scenario error
      await h.teardown().catch((e) => console.warn("T0 teardown warning: " + (e instanceof Error ? e.message : String(e))));
    }
  });
});
