import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierInvoiceLineReceipt } from '../infrastructure/supplier-invoice-line-receipt.entity';

const q3 = (n: number) => Math.round(n * 1000) / 1000;

export interface AllocationRequest {
  supplierInvoiceLineId: string;
  purchaseOrderLineId: string;
  quantity: number;
  /** optional: bill this goods-receipt line first (it must have enough free quantity); the rest, if any, is taken first-in-first-out */
  goodsReceiptLineId?: string | null;
}

export interface PoLineInvoicingRow {
  purchaseOrderLineId: string;
  productId: string;
  ordered: string;
  received: string;
  /** phase D-1: units sent back to the supplier by posted purchase returns (net received = received - returned) */
  returned: string;
  invoiced: string;
  remainingToReceive: string;
  remainingToInvoice: string;
  receipts: Array<{ goodsReceiptLineId: string; grNumber: string; received: string; returned: string; invoiced: string; free: string }>;
}

export interface InvoicingReconciliationIssue {
  kind: 'po_line_aggregate' | 'invoice_line_allocation' | 'receipt_over_allocated' | 'payment_allocation_total' | 'invoice_payment_vs_ledger';
  detail: string;
}

/**
 * Procurement invoicing redesign, phase A (CTO-approved 2026-10-20): which goods receipts each supplier invoice line bills.
 *
 * Rows exist ONLY for live (not void / cancelled) invoice lines. `allocate` runs inside the invoice-creating transaction, takes a per-purchase-order-line advisory lock (so two simultaneous invoices
 * can never both claim the same received quantity) and writes exactly the line's quantity, first-in-first-out over the order line's receipts unless a receipt line is named. If the received-and-not-yet-billed
 * quantity is not enough the whole creation fails and rolls back. `release` removes the rows when the invoice is voided / cancelled. It never touches an amount, a journal, a number or a stock movement.
 */
@Injectable()
export class InvoiceAllocationService {
  constructor(private readonly dataSource: DataSource) {}

  async allocate(requests: AllocationRequest[], m: EntityManager): Promise<void> {
    // lock every affected order line, in a fixed order, before reading any capacity
    const poLineIds = [...new Set(requests.map((r) => r.purchaseOrderLineId))].sort();
    for (const id of poLineIds) await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supplier_invoice_po_line:${id}`]);

    const repo = m.getRepository(SupplierInvoiceLineReceipt);
    const capacity = new Map<string, Array<{ id: string; free: number }>>();
    for (const poLineId of poLineIds) {
      const rows: Array<{ id: string; received: string; allocated: string }> = await m.query(
        `SELECT grl."id", (grl."quantityReceived" - grl."quantityReturned")::text AS received,
                COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."goodsReceiptLineId" = grl."id"), 0)::text AS allocated
           FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr."id" = grl."goodsReceiptId"
          WHERE grl."purchaseOrderLineId" = $1
          ORDER BY gr."createdAt", grl."id"`,
        [poLineId],
      );
      capacity.set(poLineId, rows.map((r) => ({ id: r.id, free: q3(Number(r.received) - Number(r.allocated)) })));
    }

    for (const req of requests) {
      const slots = capacity.get(req.purchaseOrderLineId) ?? [];
      let need = q3(req.quantity);
      const take = (slot: { id: string; free: number }, qty: number) => {
        const t = q3(Math.min(slot.free, qty));
        if (t <= 0) return 0;
        slot.free = q3(slot.free - t);
        need = q3(need - t);
        rowsToSave.push(repo.create({ supplierInvoiceLineId: req.supplierInvoiceLineId, goodsReceiptLineId: slot.id, quantity: t.toFixed(3), allocationBasis: 'recorded' }));
        return t;
      };
      const rowsToSave: SupplierInvoiceLineReceipt[] = [];
      if (req.goodsReceiptLineId) {
        const pinned = slots.find((s) => s.id === req.goodsReceiptLineId);
        if (!pinned) throw new ConflictException(`Goods receipt line "${req.goodsReceiptLineId}" does not belong to purchase order line "${req.purchaseOrderLineId}".`);
        take(pinned, need);
      }
      for (const slot of slots) {
        if (need <= 0) break;
        take(slot, need);
      }
      if (need > 0) {
        throw new ConflictException(`Cannot allocate ${req.quantity} to goods receipts for purchase order line "${req.purchaseOrderLineId}" - ${need} more than the received-and-not-yet-invoiced quantity. Nothing was saved.`);
      }
      const total = rowsToSave.reduce((s, r) => s + Number(r.quantity), 0);
      if (q3(total) !== q3(req.quantity)) throw new ConflictException('Allocation total does not equal the invoiced quantity (data integrity). Nothing was saved.');
      await repo.save(rowsToSave);
    }
  }

  /** Remove the allocations of voided / cancelled invoice lines, inside the caller's transaction. */
  async release(supplierInvoiceLineIds: string[], m: EntityManager): Promise<number> {
    if (supplierInvoiceLineIds.length === 0) return 0;
    const res = await m.query(`DELETE FROM "supplier_invoice_line_receipts" WHERE "supplierInvoiceLineId" = ANY($1::uuid[])`, [supplierInvoiceLineIds]);
    return Array.isArray(res) ? (res[1] as number) ?? 0 : 0;
  }

  /** Per order line: ordered / received / invoiced / remaining, with the per-receipt breakdown. Read-only. */
  async getPurchaseOrderInvoicing(purchaseOrderId: string, manager?: EntityManager): Promise<PoLineInvoicingRow[]> {
    const run = manager ?? this.dataSource;
    const lines: Array<{ id: string; productId: string; quantityOrdered: string; quantityReceived: string; quantityReturned: string; quantityInvoiced: string }> = await run.query(
      `SELECT "id", "productId", "quantity"::text AS "quantityOrdered", "quantityReceived"::text, "quantityReturned"::text, "quantityInvoiced"::text FROM "purchase_order_lines" WHERE "purchaseOrderId" = $1 ORDER BY "id"`,
      [purchaseOrderId],
    );
    const receipts: Array<{ poLineId: string; id: string; grNumber: string; received: string; returned: string; invoiced: string }> = await run.query(
      `SELECT grl."purchaseOrderLineId" AS "poLineId", grl."id", gr."grNumber", grl."quantityReceived"::text AS received, grl."quantityReturned"::text AS returned,
              COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."goodsReceiptLineId" = grl."id"), 0)::text AS invoiced
         FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr."id" = grl."goodsReceiptId"
        WHERE gr."purchaseOrderId" = $1 ORDER BY gr."createdAt", grl."id"`,
      [purchaseOrderId],
    );
    return lines.map((l) => ({
      purchaseOrderLineId: l.id,
      productId: l.productId,
      ordered: l.quantityOrdered,
      received: l.quantityReceived,
      returned: l.quantityReturned,
      invoiced: l.quantityInvoiced,
      remainingToReceive: q3(Number(l.quantityOrdered) - Number(l.quantityReceived)).toFixed(3),
      remainingToInvoice: q3(Number(l.quantityReceived) - Number(l.quantityReturned) - Number(l.quantityInvoiced)).toFixed(3),
      receipts: receipts
        .filter((r) => r.poLineId === l.id)
        .map((r) => ({ goodsReceiptLineId: r.id, grNumber: r.grNumber, received: r.received, returned: r.returned, invoiced: r.invoiced, free: q3(Number(r.received) - Number(r.returned) - Number(r.invoiced)).toFixed(3) })),
    }));
  }

  /**
   * Read-only reconciliation of the allocation model against the documents it summarises. An empty list = consistent.
   *  - PO line: quantityInvoiced = sum of live invoice lines = sum of allocations of those lines
   *  - every live invoice line: allocations sum to its quantity
   *  - every receipt line: allocated <= received
   *  - every payment: allocations sum to its amount; every invoice: payment allocations sum = payments applied in the supplier ledger
   */
  async reconcile(manager?: EntityManager): Promise<InvoicingReconciliationIssue[]> {
    const run = manager ?? this.dataSource;
    const issues: InvoicingReconciliationIssue[] = [];
    const live = `COALESCE(pi."currentState", 'draft') <> 'void'`;
    const liveJoin = `LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = si."id"::text`;

    const poLines: Array<{ id: string; aggregate: string; lines: string; allocated: string }> = await run.query(
      `SELECT pol."id", pol."quantityInvoiced"::text AS aggregate,
              COALESCE((SELECT SUM(sil."quantity") FROM "supplier_invoice_lines" sil JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId" ${liveJoin} WHERE sil."purchaseOrderLineId" = pol."id" AND ${live}), 0)::text AS lines,
              COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r JOIN "goods_receipt_lines" grl ON grl."id" = r."goodsReceiptLineId" WHERE grl."purchaseOrderLineId" = pol."id"), 0)::text AS allocated
         FROM "purchase_order_lines" pol`,
    );
    for (const r of poLines) {
      if (Number(r.aggregate) !== Number(r.lines) || Number(r.lines) !== Number(r.allocated)) {
        issues.push({ kind: 'po_line_aggregate', detail: `PO line ${r.id}: quantityInvoiced ${r.aggregate}, live invoice lines ${r.lines}, receipt allocations ${r.allocated}` });
      }
    }

    const lineIssues: Array<{ id: string; quantity: string; allocated: string }> = await run.query(
      `SELECT sil."id", sil."quantity"::text AS quantity, COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."supplierInvoiceLineId" = sil."id"), 0)::text AS allocated
         FROM "supplier_invoice_lines" sil JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId" ${liveJoin} WHERE ${live}`,
    );
    for (const r of lineIssues) {
      if (Number(r.quantity) !== Number(r.allocated)) issues.push({ kind: 'invoice_line_allocation', detail: `Invoice line ${r.id}: quantity ${r.quantity}, allocated ${r.allocated}` });
    }

    const over: Array<{ id: string; received: string; allocated: string }> = await run.query(
      `SELECT grl."id", (grl."quantityReceived" - grl."quantityReturned")::text AS received, SUM(r."quantity")::text AS allocated
         FROM "goods_receipt_lines" grl JOIN "supplier_invoice_line_receipts" r ON r."goodsReceiptLineId" = grl."id"
        GROUP BY grl."id", grl."quantityReceived", grl."quantityReturned" HAVING SUM(r."quantity") > grl."quantityReceived" - grl."quantityReturned"`,
    );
    for (const r of over) issues.push({ kind: 'receipt_over_allocated', detail: `Receipt line ${r.id}: received ${r.received}, allocated ${r.allocated}` });

    const pay: Array<{ id: string; amount: string; allocated: string }> = await run.query(
      `SELECT p."id", p."amount"::text AS amount, COALESCE((SELECT SUM(a."amount") FROM "supplier_payment_allocations" a WHERE a."supplierPaymentId" = p."id"), 0)::text AS allocated FROM "supplier_payments" p`,
    );
    for (const r of pay) {
      if (Number(r.amount) !== Number(r.allocated)) issues.push({ kind: 'payment_allocation_total', detail: `Payment ${r.id}: amount ${r.amount}, allocated ${r.allocated}` });
    }

    const inv: Array<{ id: string; allocated: string; applied: string }> = await run.query(
      `SELECT si."id",
              COALESCE((SELECT SUM(a."amount") FROM "supplier_payment_allocations" a WHERE a."supplierInvoiceId" = si."id"), 0)::text AS allocated,
              COALESCE((SELECT SUM(CASE WHEN l."direction" = 'debit' THEN l."amount" ELSE -l."amount" END) FROM "supplier_ledger_entries" l WHERE l."supplierInvoiceId" = si."id" AND l."entryType" = 'payment'), 0)::text AS applied
         FROM "supplier_invoices" si`,
    );
    for (const r of inv) {
      if (Number(r.allocated) !== Number(r.applied)) issues.push({ kind: 'invoice_payment_vs_ledger', detail: `Invoice ${r.id}: payment allocations ${r.allocated}, ledger payments ${r.applied}` });
    }
    return issues;
  }
}
