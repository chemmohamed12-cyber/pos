import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `procurement`-tagged (ADR-025). Supplier Invoice/AP + Supplier Ledger +
 * Supplier Payment (the `supplier-finance` bounded context) — the exact
 * mirror of `customer-finance`'s `sales_invoices`/`customer_ledger_entries`/
 * `customer_payments`. Adds `quantityInvoiced` to `purchase_order_lines`
 * for the invoice-side 3-way-match guard (invoiced ≤ received ≤ ordered).
 */
export class CreateSupplierInvoiceAndLedgerTables1789700600000 implements MigrationInterface {
  name = 'CreateSupplierInvoiceAndLedgerTables1789700600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "purchase_order_lines" ADD COLUMN "quantityInvoiced" NUMERIC(18,3) NOT NULL DEFAULT 0`);

    await queryRunner.query(`
      CREATE TABLE "supplier_invoices" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceNumber" VARCHAR(32) NOT NULL,
        "supplierReference" VARCHAR(64),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "purchaseOrderId" UUID NOT NULL REFERENCES "purchase_orders"("id"),
        "totalAmount" NUMERIC(14,2) NOT NULL,
        "dueDate" TIMESTAMPTZ,
        "priceVarianceAmount" NUMERIC(14,2) NOT NULL DEFAULT 0,
        "createdByUserId" UUID NOT NULL,
        "postedByUserId" UUID,
        "voidedReason" VARCHAR(255),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_supplier_invoices_invoice_number" ON "supplier_invoices" ("invoiceNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_invoices_supplier" ON "supplier_invoices" ("supplierId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_invoices_po" ON "supplier_invoices" ("purchaseOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_invoice_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierInvoiceId" UUID NOT NULL REFERENCES "supplier_invoices"("id") ON DELETE CASCADE,
        "purchaseOrderLineId" UUID NOT NULL REFERENCES "purchase_order_lines"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" NUMERIC(18,3) NOT NULL,
        "unitCostBase" NUMERIC(18,4) NOT NULL,
        "lineTotalBase" NUMERIC(18,2) NOT NULL,
        "unitCostVariance" NUMERIC(18,4) NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_invoice_lines_invoice" ON "supplier_invoice_lines" ("supplierInvoiceId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_invoice_lines_po_line" ON "supplier_invoice_lines" ("purchaseOrderLineId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_ledger_entries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "entryNumber" VARCHAR(32) NOT NULL,
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "entryType" VARCHAR(32) NOT NULL,
        "direction" VARCHAR(8) NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "purchaseOrderId" UUID REFERENCES "purchase_orders"("id"),
        "supplierInvoiceId" UUID REFERENCES "supplier_invoices"("id"),
        "supplierPaymentId" UUID,
        "treasuryTransactionId" UUID,
        "reference" VARCHAR(255),
        "reason" VARCHAR(255),
        "entryDate" TIMESTAMPTZ NOT NULL,
        "createdByUserId" UUID NOT NULL,
        "reversalOfEntryId" UUID,
        "status" VARCHAR(16) NOT NULL DEFAULT 'posted',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_supplier_ledger_entries_direction" CHECK ("direction" IN ('debit','credit')),
        CONSTRAINT "CHK_supplier_ledger_entries_status" CHECK ("status" IN ('posted','reversed'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_supplier_ledger_entries_entry_number" ON "supplier_ledger_entries" ("entryNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_ledger_entries_supplier" ON "supplier_ledger_entries" ("supplierId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_ledger_entries_invoice" ON "supplier_ledger_entries" ("supplierInvoiceId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_ledger_entries_po" ON "supplier_ledger_entries" ("purchaseOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "supplier_payments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "paymentNumber" VARCHAR(32) NOT NULL,
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "supplierInvoiceId" UUID NOT NULL REFERENCES "supplier_invoices"("id"),
        "amount" NUMERIC(14,2) NOT NULL,
        "method" VARCHAR(32) NOT NULL,
        "treasuryAccountId" UUID NOT NULL,
        "treasuryTransactionId" UUID,
        "reference" VARCHAR(255),
        "recordedByUserId" UUID NOT NULL,
        "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_supplier_payments_payment_number" ON "supplier_payments" ("paymentNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_payments_supplier" ON "supplier_payments" ("supplierId")`);
    await queryRunner.query(`CREATE INDEX "IDX_supplier_payments_invoice" ON "supplier_payments" ("supplierInvoiceId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "supplier_payments"`);
    await queryRunner.query(`DROP TABLE "supplier_ledger_entries"`);
    await queryRunner.query(`DROP TABLE "supplier_invoice_lines"`);
    await queryRunner.query(`DROP TABLE "supplier_invoices"`);
    await queryRunner.query(`ALTER TABLE "purchase_order_lines" DROP COLUMN "quantityInvoiced"`);
  }
}
