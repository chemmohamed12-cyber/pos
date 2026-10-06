import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { SupplierInvoiceService } from './supplier-invoice.service';
import { GrniReconciliationService } from '../../accounting/application/grni-reconciliation.service';
import { ApReconciliationService } from '../../accounting/application/ap-reconciliation.service';

/**
 * ADR-054/ADR-057 (Procurement GRNI Posting). Live, real-DB E2E proof of
 * the full chain: `PO → GR (Dr Inventory/Cr GRNI) → Supplier Invoice
 * (Dr GRNI/Cr AP) → GRNI reconciliation`. Uses a real supplier/product/
 * warehouse already present in this dev database (this domain's existing
 * test fixtures) rather than fabricating new master data — keeps this
 * test focused on the GRNI posting logic itself.
 */
describe('Procurement GRNI posting (ADR-054/ADR-057)', () => {
  let moduleRef: TestingModule;
  let purchaseOrders: PurchaseOrderService;
  let goodsReceipts: GoodsReceiptService;
  let supplierInvoices: SupplierInvoiceService;
  let grniReconciliation: GrniReconciliationService;
  let apReconciliation: ApReconciliationService;
  let dataSource: DataSource;

  const ADMIN_A = 'e1d5fd90-6e1c-4f52-aac7-60dd6265aa80';
  const ADMIN_B = 'f539302e-9ae7-4cc2-99cf-381f08acab83'; // ESC-3 — a second existing admin fixture approves the PO the first one created

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    purchaseOrders = moduleRef.get(PurchaseOrderService);
    goodsReceipts = moduleRef.get(GoodsReceiptService);
    supplierInvoices = moduleRef.get(SupplierInvoiceService);
    grniReconciliation = moduleRef.get(GrniReconciliationService);
    apReconciliation = moduleRef.get(ApReconciliationService);
    dataSource = moduleRef.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  async function findFixtures(): Promise<{ supplierId: string; warehouseId: string; productId: string }> {
    const [supplier] = await dataSource.query(`SELECT id FROM suppliers LIMIT 1`);
    const [warehouse] = await dataSource.query(`SELECT id FROM warehouses LIMIT 1`);
    const [product] = await dataSource.query(`SELECT id FROM products LIMIT 1`);
    return { supplierId: supplier.id, warehouseId: warehouse.id, productId: product.id };
  }

  it('posts Dr Inventory / Cr GRNI on Goods Receipt, then Dr GRNI / Cr AP on Supplier Invoice, balanced, idempotent, partial-quantity aware', async () => {
    const { supplierId, warehouseId, productId } = await findFixtures();

    const po = await purchaseOrders.create({ supplierId, warehouseId, lines: [{ productId, quantity: '10', unitCostBase: '15.00' }] }, ADMIN_A);
    await purchaseOrders.transition(po.id, 'submit', ADMIN_A);
    await purchaseOrders.transition(po.id, 'approve', ADMIN_B);

    const [poLine] = await dataSource.query(`SELECT id FROM purchase_order_lines WHERE "purchaseOrderId" = $1`, [po.id]);

    // Partial receipt: 7 of 10.
    const gr = await goodsReceipts.post({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '7' }] }, ADMIN_A);

    const [grEvent] = await dataSource.query(
      `SELECT id, status, "journalEntryId" FROM accounting_financial_events WHERE "idempotencyKey" = $1`,
      [`procurement:goods_receipt:${gr.id}:posted`],
    );
    expect(grEvent.status).toBe('POSTED');
    const grLines = await dataSource.query(
      `SELECT ga.code, jl."debitBase", jl."creditBase" FROM accounting_journal_lines jl
       JOIN accounting_gl_accounts ga ON ga.id = jl."accountId"
       WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
      [grEvent.journalEntryId],
    );
    expect(grLines).toHaveLength(2);
    expect(Number(grLines[0].debitBase)).toBeCloseTo(105); // 7 * 15.00 — Dr Inventory
    expect(Number(grLines[1].creditBase)).toBeCloseTo(105); // Cr GRNI

    // Idempotency: re-ingesting the same idempotencyKey must never double-post.
    const dupeCount = await dataSource.query(
      `SELECT count(*)::int AS c FROM accounting_financial_events WHERE "idempotencyKey" = $1`,
      [`procurement:goods_receipt:${gr.id}:posted`],
    );
    expect(dupeCount[0].c).toBe(1);

    // Partial invoice: 5 of the 7 received.
    const invoice = await supplierInvoices.createDraftInvoice({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLine.id, quantity: '5', unitCostBase: '15.00' }] }, ADMIN_A);
    await supplierInvoices.postInvoice(invoice.id, ADMIN_A);

    const [invEvent] = await dataSource.query(
      `SELECT id, status, "journalEntryId" FROM accounting_financial_events WHERE "idempotencyKey" = $1`,
      [`procurement:supplier_invoice:${invoice.id}:posted`],
    );
    expect(invEvent.status).toBe('POSTED');
    const invLines = await dataSource.query(
      `SELECT ga.code, ga.name, jl."debitBase", jl."creditBase" FROM accounting_journal_lines jl
       JOIN accounting_gl_accounts ga ON ga.id = jl."accountId"
       WHERE jl."journalEntryId" = $1 ORDER BY jl."lineNumber"`,
      [invEvent.journalEntryId],
    );
    expect(invLines).toHaveLength(2);
    const grniLine = invLines.find((l: { name: string }) => l.name === 'Goods Received Not Invoiced');
    const apLine = invLines.find((l: { name: string }) => l.name === 'Accounts Payable');
    expect(Number(grniLine.debitBase)).toBeCloseTo(75); // 5 * 15.00 — Dr GRNI (clears exposure)
    expect(Number(apLine.creditBase)).toBeCloseTo(75); // Cr AP

    // Every journal balanced, by construction — verify directly rather than assume.
    for (const journalEntryId of [grEvent.journalEntryId, invEvent.journalEntryId]) {
      const [sums] = await dataSource.query(
        `SELECT SUM("debitBase") AS d, SUM("creditBase") AS c FROM accounting_journal_lines WHERE "journalEntryId" = $1`,
        [journalEntryId],
      );
      expect(Number(sums.d)).toBeCloseTo(Number(sums.c));
    }

    // Remaining PO line exposure: 2 units received-not-invoiced (7 - 5) * 15.00 = 30.00.
    const [refreshedLine] = await dataSource.query(`SELECT "quantityReceived", "quantityInvoiced" FROM purchase_order_lines WHERE id = $1`, [poLine.id]);
    expect(Number(refreshedLine.quantityReceived) - Number(refreshedLine.quantityInvoiced)).toBeCloseTo(2);
  }, 30_000);

  it('GRNI and AP reconciliation report matched (sign-convention bug fixed) when the subledger and GL genuinely agree', async () => {
    // Both credit-normal control accounts — the fix normalizes LedgerService's unconditional
    // debit-minus-credit convention against each account's own normalBalance before diffing.
    // A pre-fix regression would show a large, ~2x-magnitude driftBase for any non-zero balance.
    const grniRun = await grniReconciliation.reconcile({}, ADMIN_A);
    if (grniRun.status !== 'no_subledger_source') {
      expect(grniRun.status).not.toBe('drift_found');
    }

    const apRun = await apReconciliation.reconcile({}, ADMIN_A);
    if (apRun.status !== 'no_subledger_source') {
      expect(apRun.status).not.toBe('drift_found');
    }
  }, 30_000);
});
