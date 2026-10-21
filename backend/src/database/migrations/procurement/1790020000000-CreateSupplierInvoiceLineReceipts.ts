import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Procurement invoicing redesign, phase A (CTO-approved 2026-10-20) - receipt-level allocation of supplier invoice lines.
 *
 * 1. New table `supplier_invoice_line_receipts` (invoice line -> goods receipt line, quantity). Purely additive.
 * 2. Historical backfill for invoices that predate it: for every purchase order line, the LIVE (not void) invoice lines are allocated first-in-first-out against the order's receipt lines. Those rows
 *    are tagged `allocationBasis = 'backfill_fifo'` because they are an INFERENCE, not a record of which receipt the supplier billed. The backfill touches no amount, no journal, no number and no
 *    status; it skips invoice lines that already have rows, so running it again inserts nothing. If any live invoiced quantity cannot be allocated (invoiced > received - an inconsistent document)
 *    the migration STOPS with a list of the offending lines and nothing is written: that is a decision for a person, not something to repair silently.
 * `down` drops the table (the allocations are derived data; the invoice lines, quantities and journals are untouched).
 */
export class CreateSupplierInvoiceLineReceipts1790020000000 implements MigrationInterface {
  name = 'CreateSupplierInvoiceLineReceipts1790020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplier_invoice_line_receipts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierInvoiceLineId" UUID NOT NULL REFERENCES "supplier_invoice_lines"("id") ON DELETE CASCADE,
        "goodsReceiptLineId" UUID NOT NULL REFERENCES "goods_receipt_lines"("id"),
        "quantity" NUMERIC(18,3) NOT NULL CHECK ("quantity" > 0),
        "allocationBasis" VARCHAR(16) NOT NULL DEFAULT 'recorded' CHECK ("allocationBasis" IN ('recorded','backfill_fifo')),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_supplier_invoice_line_receipts_pair" ON "supplier_invoice_line_receipts" ("supplierInvoiceLineId", "goodsReceiptLineId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_invoice_line_receipts_line" ON "supplier_invoice_line_receipts" ("supplierInvoiceLineId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_invoice_line_receipts_receipt" ON "supplier_invoice_line_receipts" ("goodsReceiptLineId")`);

    // ---- historical backfill (FIFO, marked as inferred) ----
    const lines: Array<{ id: string; purchaseOrderLineId: string; quantity: string }> = await queryRunner.query(`
      SELECT sil."id", sil."purchaseOrderLineId", sil."quantity"::text AS quantity
        FROM "supplier_invoice_lines" sil
        JOIN "supplier_invoices" si ON si."id" = sil."supplierInvoiceId"
        LEFT JOIN "process_instances" pi ON pi."definitionKey" = 'supplier_invoice_lifecycle' AND pi."entityId" = si."id"::text
       WHERE COALESCE(pi."currentState", 'draft') <> 'void'
         AND NOT EXISTS (SELECT 1 FROM "supplier_invoice_line_receipts" r WHERE r."supplierInvoiceLineId" = sil."id")
       ORDER BY sil."purchaseOrderLineId", si."createdAt", sil."id"`);
    if (lines.length === 0) return;

    // free capacity of every receipt line of the affected order lines, in receipt order
    const poLineIds = [...new Set(lines.map((l) => l.purchaseOrderLineId))];
    const receipts: Array<{ id: string; purchaseOrderLineId: string; received: string; allocated: string }> = await queryRunner.query(
      `SELECT grl."id", grl."purchaseOrderLineId", grl."quantityReceived"::text AS received,
              COALESCE((SELECT SUM(r."quantity") FROM "supplier_invoice_line_receipts" r WHERE r."goodsReceiptLineId" = grl."id"), 0)::text AS allocated
         FROM "goods_receipt_lines" grl JOIN "goods_receipts" gr ON gr."id" = grl."goodsReceiptId"
        WHERE grl."purchaseOrderLineId" = ANY($1::uuid[])
        ORDER BY gr."createdAt", grl."id"`,
      [poLineIds],
    );
    const free = new Map<string, Array<{ id: string; free: number }>>();
    for (const r of receipts) {
      const list = free.get(r.purchaseOrderLineId) ?? [];
      list.push({ id: r.id, free: Math.round((Number(r.received) - Number(r.allocated)) * 1000) / 1000 });
      free.set(r.purchaseOrderLineId, list);
    }

    const inserts: Array<[string, string, number]> = [];
    const unallocatable: string[] = [];
    for (const line of lines) {
      let need = Math.round(Number(line.quantity) * 1000) / 1000;
      for (const slot of free.get(line.purchaseOrderLineId) ?? []) {
        if (need <= 0) break;
        const take = Math.min(slot.free, need);
        if (take > 0) {
          inserts.push([line.id, slot.id, take]);
          slot.free = Math.round((slot.free - take) * 1000) / 1000;
          need = Math.round((need - take) * 1000) / 1000;
        }
      }
      if (need > 0) unallocatable.push(`invoice line ${line.id} (purchase order line ${line.purchaseOrderLineId}): ${need} invoiced beyond what was received`);
    }
    if (unallocatable.length > 0) {
      throw new Error(`Receipt allocation backfill STOPPED - inconsistent invoiced / received quantities, nothing was written. Decide these documents first:\n${unallocatable.join('\n')}`);
    }
    for (const [lineId, receiptLineId, qty] of inserts) {
      await queryRunner.query(
        `INSERT INTO "supplier_invoice_line_receipts" ("supplierInvoiceLineId", "goodsReceiptLineId", "quantity", "allocationBasis") VALUES ($1, $2, $3, 'backfill_fifo') ON CONFLICT DO NOTHING`,
        [lineId, receiptLineId, qty],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "supplier_invoice_line_receipts"`);
  }
}
