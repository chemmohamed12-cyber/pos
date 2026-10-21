import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { GrniBalanceEntry, GrniLedgerContract } from '../../../foundation/module-registry/contracts/grni-events.contract';

/**
 * ADR-054/ADR-056/ADR-057 — `GRNI_LEDGER_CONTRACT`'s real implementation.
 * No dedicated ledger table — GRNI has no operational document of its own
 * (unlike Supplier Invoice/Payment): outstanding GRNI exposure is exactly
 * `Σ (quantityReceived − quantityInvoiced) × unitCostBase` over every
 * `PurchaseOrderLine` with a positive balance (ADR-057 §10), the SAME
 * columns `GoodsReceiptService.post`/`SupplierInvoiceService
 * .createDraftInvoice` already maintain atomically under the existing
 * 3-way-match guard — never a second, independently-maintained ledger that
 * could drift from them. `getAllGrniBalances`'s `goodsReceiptId`/
 * `goodsReceiptNumber` name the most recent `GoodsReceipt` that
 * contributed to that PO line, for traceability (ADR-054 item 4) — not an
 * exact per-receipt FIFO allocation, which ADR-057 §6 explicitly declines
 * to build as outside what was ratified.
 *
 * `asOfDate` is accepted for interface-shape compatibility but not used
 * for historical reconstruction — the same already-accepted convention
 * `MovingAverageCostEngine.getValuedOnHandTotal` established (ADR-041 D23)
 * for the identical reason (no historical reconstruction of a running
 * quantity/cost state in V1).
 */
@Injectable()
export class GrniLedgerService implements GrniLedgerContract {
  constructor(private readonly dataSource: DataSource) {}

  /** `_asOfDate` is accepted for `GrniLedgerContract` parity — pre-existing behaviour: balances are always "as of now" (not changed by Area 21). */
  async getAllGrniBalances(_asOfDate?: string, manager?: EntityManager): Promise<{ balances: GrniBalanceEntry[]; total: string }> {
    const rows: Array<{
      purchaseOrderId: string;
      supplierId: string;
      balance: string;
      goodsReceiptId: string | null;
      goodsReceiptNumber: string | null;
    }> = await (manager ?? this.dataSource).query(
      `SELECT pol."purchaseOrderId",
              po."supplierId",
              ((pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced") * pol."unitCostBase")::numeric(20,4) AS balance,
              (SELECT gr.id FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr.id = grl."goodsReceiptId"
                WHERE grl."purchaseOrderLineId" = pol.id ORDER BY gr."createdAt" DESC LIMIT 1) AS "goodsReceiptId",
              (SELECT gr."grNumber" FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr.id = grl."goodsReceiptId"
                WHERE grl."purchaseOrderLineId" = pol.id ORDER BY gr."createdAt" DESC LIMIT 1) AS "goodsReceiptNumber"
       FROM "purchase_order_lines" pol
       JOIN "purchase_orders" po ON po.id = pol."purchaseOrderId"
       WHERE (pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced") > 0
       ORDER BY pol."purchaseOrderId"`,
    );
    const [tot] = await (manager ?? this.dataSource).query(
      `SELECT COALESCE(SUM((pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced") * pol."unitCostBase"), 0)::numeric(20,4) AS total
       FROM "purchase_order_lines" pol
       WHERE (pol."quantityReceived" - pol."quantityReturned" - pol."quantityInvoiced") > 0`,
    );
    return {
      balances: rows.map((r) => ({
        goodsReceiptId: r.goodsReceiptId ?? '',
        goodsReceiptNumber: r.goodsReceiptNumber,
        purchaseOrderId: r.purchaseOrderId,
        supplierId: r.supplierId,
        balance: r.balance,
      })),
      total: tot.total,
    };
  }
}
