import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { SupplierInvoiceService } from './supplier-invoice.service';
import { SupplierLedgerService } from './supplier-ledger.service';
import { ApReconciliationService } from '../../accounting/application/ap-reconciliation.service';
import { CustomerLedgerService } from '../../customer-finance/application/customer-ledger.service';
import { TreasuryService } from '../../treasury/application/treasury.service';

/**
 * Regression for the latent UTC-vs-session-timezone reconciliation defect (found 2026-10-07 during the
 * Authorization F1 gate; wall-clock dependent — `grni-posting.spec.ts` test 2 failed only between 00:00 and
 * 03:00 Africa/Cairo).
 *
 * Root cause: the GL stamps/reads the UTC calendar date while the subledger compared a `timestamptz` against
 * `$1::date + INTERVAL '1 day'` in the DB SESSION timezone (Africa/Cairo, UTC+3). A supplier invoice posted at
 * 2026-10-07 02:57 +03 (= 2026-10-06T23:57Z) had its subledger entry on "the 7th" but its journal on the UTC 6th,
 * so the AP reconciliation (asOf = UTC 6th) saw GL = 75 and subledger = 0 -> `drift_found`.
 *
 * This spec makes that window deterministic by pinning ONLY `Date` (fake timers; real timers/IO untouched) to
 * 2026-10-06T23:57:33Z, so it proves the fix independent of when the suite is actually run.
 */
describe('AP reconciliation inside the 00:00-03:00 Africa/Cairo window (pinned clock 2026-10-06T23:57:33Z)', () => {
  const PINNED = new Date('2026-10-06T23:57:33Z');
  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const ADMIN_B = 'f539302e-9ae7-4cc2-99cf-381f08acab83';

  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let purchaseOrders: PurchaseOrderService;
  let goodsReceipts: GoodsReceiptService;
  let supplierInvoices: SupplierInvoiceService;
  let supplierLedger: SupplierLedgerService;
  let apReconciliation: ApReconciliationService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    purchaseOrders = moduleRef.get(PurchaseOrderService);
    goodsReceipts = moduleRef.get(GoodsReceiptService);
    supplierInvoices = moduleRef.get(SupplierInvoiceService);
    supplierLedger = moduleRef.get(SupplierLedgerService);
    apReconciliation = moduleRef.get(ApReconciliationService);
  }, 60_000);

  afterAll(async () => {
    jest.useRealTimers();
    await moduleRef.close();
  });

  afterEach(() => jest.useRealTimers());

  /** Pin `Date` only — leave timers/microtasks real so pg / Nest keep working. */
  function pinClock(): void {
    jest.useFakeTimers({
      now: PINNED,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
  }

  it('SQL: the subledger as-of bound is the UTC day end, so a 23:57Z row belongs to that UTC day under a Cairo session', async () => {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await qr.query(`SET LOCAL TIME ZONE 'Africa/Cairo'`);
      const [r] = await qr.query(
        `SELECT
           '2026-10-06T23:57:33Z'::timestamptz <  ((('2026-10-06')::date + INTERVAL '1 day') AT TIME ZONE 'UTC') AS in_utc_day,
           '2026-10-07T00:00:00Z'::timestamptz <  ((('2026-10-06')::date + INTERVAL '1 day') AT TIME ZONE 'UTC') AS next_utc_day_in,
           '2026-10-06T23:57:33Z'::timestamptz <  (('2026-10-06')::date + INTERVAL '1 day')                      AS legacy_session_tz_clause`,
      );
      expect(r.in_utc_day).toBe(true);
      expect(r.next_utc_day_in).toBe(false);
      // Documents the bug: the legacy bare clause (session tz) put the same instant on the NEXT day.
      expect(r.legacy_session_tz_clause).toBe(false);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('AR (customer ledger) and Cash/Bank (treasury) as-of reads use the same UTC day under a Cairo session (rolled back, no data kept)', async () => {
    const customers = moduleRef.get(CustomerLedgerService);
    const treasury = moduleRef.get(TreasuryService);
    const [customer] = await dataSource.query(`SELECT id FROM customers LIMIT 1`);
    const [account] = await dataSource.query(`SELECT id FROM treasury_accounts LIMIT 1`);
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await qr.query(`SET LOCAL TIME ZONE 'Africa/Cairo'`);
      // Both rows are on the UTC 6th (23:57:33Z) but the Cairo 7th (02:57:33 +03).
      await qr.query(
        `INSERT INTO customer_ledger_entries ("entryNumber","customerId","entryType",direction,amount,"entryDate","createdByUserId")
         VALUES ('TZ-REG-AR-1',$1,'sales_invoice','debit',123.45,'2026-10-06T23:57:33Z',$2)`,
        [customer.id, ADMIN_A],
      );
      await qr.query(
        `INSERT INTO treasury_transactions ("transactionNumber",type,"treasuryAccountId",amount,"movementDate","createdByUserId")
         VALUES ('TZ-REG-TR-1','cash_in',$1,543.21,'2026-10-06T23:57:33Z',$2)`,
        [account.id, ADMIN_A],
      );

      const arOn6 = await customers.getAllCustomerBalances('2026-10-06', qr.manager);
      const arOn5 = await customers.getAllCustomerBalances('2026-10-05', qr.manager);
      const arBal = (r: { balances: Array<{ customerId: string; balance: string }> }) => Number(r.balances.find((b) => b.customerId === customer.id)?.balance ?? 0);
      expect(arBal(arOn6) - arBal(arOn5)).toBeCloseTo(123.45, 4); // included on its UTC day, not on the day before

      const trOn6 = await treasury.getAllTreasuryBalances('2026-10-06', qr.manager);
      const trOn5 = await treasury.getAllTreasuryBalances('2026-10-05', qr.manager);
      const trBal = (r: { balances: Array<{ treasuryAccountId: string; balance: string }> }) => Number(r.balances.find((b) => b.treasuryAccountId === account.id)?.balance ?? 0);
      expect(trBal(trOn6) - trBal(trOn5)).toBeCloseTo(543.21, 4);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  }, 30_000);

  it('a Supplier Invoice posted at 23:57:33Z reconciles `matched` against the GL (default as-of = UTC date)', async () => {
    const [supplier] = await dataSource.query(`SELECT id FROM suppliers LIMIT 1`);
    const [warehouse] = await dataSource.query(`SELECT id FROM warehouses LIMIT 1`);
    const [product] = await dataSource.query(`SELECT id FROM products LIMIT 1`);

    pinClock();

    const po = await purchaseOrders.create(
      { supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ productId: product.id, quantity: '10', unitCostBase: '15.00' }] },
      ADMIN_A,
    );
    await purchaseOrders.transition(po.id, 'submit', ADMIN_A);
    await purchaseOrders.transition(po.id, 'approve', ADMIN_B);
    const [poLine] = await dataSource.query(`SELECT id FROM purchase_order_lines WHERE "purchaseOrderId" = $1`, [po.id]);
    await goodsReceipts.post({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '7' }] }, ADMIN_A);
    const invoice = await supplierInvoices.createDraftInvoice(
      { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLine.id, quantity: '5', unitCostBase: '15.00' }] },
      ADMIN_A,
    );
    await supplierInvoices.postInvoice(invoice.id, ADMIN_A);

    // Preconditions that make this the failing window: the subledger row is on the UTC 6th but the Cairo 7th.
    const [entry] = await dataSource.query(
      `SELECT "entryDate", to_char("entryDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
              "entryDate"::date::text AS session_day
         FROM supplier_ledger_entries WHERE "supplierInvoiceId" = $1`,
      [invoice.id],
    );
    expect(entry.utc_day).toBe('2026-10-06');
    expect(entry.session_day).toBe('2026-10-07'); // session TZ = Africa/Cairo (the divergence under test)
    const [je] = await dataSource.query(
      `SELECT je."businessDate"::text AS bd FROM accounting_financial_events fe
         JOIN accounting_journal_entries je ON je.id = fe."journalEntryId"
        WHERE fe."idempotencyKey" = $1`,
      [`procurement:supplier_invoice:${invoice.id}:posted`],
    );
    expect(je.bd).toBe('2026-10-06'); // GL side = UTC date

    // The subledger as-of read now includes it for the UTC 6th, matching the GL.
    const sub = await supplierLedger.getAllSupplierBalances('2026-10-06');
    expect(Number(sub.balances.find((b) => b.supplierId === supplier.id)?.balance ?? 0)).toBeGreaterThanOrEqual(75);

    const apRun = await apReconciliation.reconcile({}, ADMIN_A);
    expect(apRun.asOfDate).toBe('2026-10-06');
    expect(apRun.status).toBe('matched');
    expect(Number(apRun.driftBase)).toBe(0);
  }, 60_000);
});
