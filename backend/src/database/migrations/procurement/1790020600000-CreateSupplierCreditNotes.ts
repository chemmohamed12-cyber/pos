import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase D-2 / D-3 (owner decisions D6 / D7 / E3, 2026-10-20) - the supplier credit note linked to the original invoice and its lines, and the return of INVOICED goods.
 * Purely additive: two new tables, three nullable columns on purchase-return lines (an invoiced line carries the invoice line it credits and the net / tax credited), two audit counters
 * (`quantityReturnedInvoiced`, default 0) on goods-receipt and purchase-order lines, and terminology. No existing row, amount, journal or number is touched. `down` drops all of it
 * (documented as irreversible once credit notes or invoiced returns exist: it would delete their history).
 */
export class CreateSupplierCreditNotes1790020600000 implements MigrationInterface {
  name = 'CreateSupplierCreditNotes1790020600000';

  private readonly terms: Array<[string, string, string, string]> = [
    ['nav.supplier_credit_notes', 'field', 'إشعارات دائنة الموردين', 'Supplier Credit Notes'],
    ['supplier_credit_note_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['supplier_credit_note_lifecycle.state.submitted', 'field', 'مرسل للاعتماد', 'Submitted'],
    ['supplier_credit_note_lifecycle.state.approved', 'field', 'معتمد', 'Approved'],
    ['supplier_credit_note_lifecycle.state.rejected', 'field', 'مرفوض', 'Rejected'],
    ['supplier_credit_note_lifecycle.state.posted', 'field', 'مرحّل', 'Posted'],
    ['supplier_credit_note_lifecycle.state.void', 'field', 'ملغى', 'Void'],
    ['panel.no_supplier_credit_notes_yet', 'panel', 'لا توجد إشعارات دائنة بعد', 'No supplier credit notes yet'],
    ['permission.procurement.supplier_credit_note.view', 'field', 'عرض إشعارات دائنة الموردين', 'View supplier credit notes'],
    ['permission.procurement.supplier_credit_note.create', 'field', 'إنشاء إشعارات دائنة الموردين', 'Create supplier credit notes'],
    ['permission.procurement.supplier_credit_note.submit', 'field', 'إرسال إشعارات دائنة الموردين للاعتماد', 'Submit supplier credit notes'],
    ['permission.procurement.supplier_credit_note.approve', 'field', 'اعتماد إشعارات دائنة الموردين', 'Approve supplier credit notes'],
    ['permission.procurement.supplier_credit_note.post', 'field', 'ترحيل إشعارات دائنة الموردين', 'Post supplier credit notes'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "goods_receipt_lines" ADD COLUMN IF NOT EXISTS "quantityReturnedInvoiced" NUMERIC(18,3) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "quantityReturnedInvoiced" NUMERIC(18,3) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "purchase_return_lines" ADD COLUMN IF NOT EXISTS "supplierInvoiceLineId" UUID REFERENCES "supplier_invoice_lines"("id")`);
    await queryRunner.query(`ALTER TABLE "purchase_return_lines" ADD COLUMN IF NOT EXISTS "creditNetBase" NUMERIC(14,2)`);
    await queryRunner.query(`ALTER TABLE "purchase_return_lines" ADD COLUMN IF NOT EXISTS "creditTaxBase" NUMERIC(14,2)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_purchase_return_lines_invoice_line" ON "purchase_return_lines" ("supplierInvoiceLineId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplier_credit_notes" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "creditNoteNumber" VARCHAR(32) NOT NULL,
        "supplierInvoiceId" UUID NOT NULL REFERENCES "supplier_invoices"("id"),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "supplierReference" VARCHAR(64),
        "reason" VARCHAR(255) NOT NULL,
        "netAmount" NUMERIC(14,2) NOT NULL CHECK ("netAmount" > 0),
        "taxAmount" NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK ("taxAmount" >= 0),
        "createdByUserId" UUID NOT NULL,
        "submittedByUserId" UUID,
        "approvedByUserId" UUID,
        "approvedAt" TIMESTAMPTZ,
        "postedByUserId" UUID,
        "postedAt" TIMESTAMPTZ,
        "rejectedReason" VARCHAR(500),
        "voidedReason" VARCHAR(255),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_supplier_credit_notes_number" ON "supplier_credit_notes" ("creditNoteNumber")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_credit_notes_invoice" ON "supplier_credit_notes" ("supplierInvoiceId")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supplier_credit_note_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "supplierCreditNoteId" UUID NOT NULL REFERENCES "supplier_credit_notes"("id") ON DELETE CASCADE,
        "supplierInvoiceLineId" UUID NOT NULL REFERENCES "supplier_invoice_lines"("id"),
        "amount" NUMERIC(14,2) NOT NULL CHECK ("amount" > 0)
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_supplier_credit_note_lines_pair" ON "supplier_credit_note_lines" ("supplierCreditNoteId", "supplierInvoiceLineId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_supplier_credit_note_lines_invoice_line" ON "supplier_credit_note_lines" ("supplierInvoiceLineId")`);

    const values = this.terms.map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`).join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "supplier_credit_note_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "supplier_credit_notes"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_purchase_return_lines_invoice_line"`);
    for (const col of ['supplierInvoiceLineId', 'creditNetBase', 'creditTaxBase']) {
      await queryRunner.query(`ALTER TABLE "purchase_return_lines" DROP COLUMN IF EXISTS "${col}"`);
    }
    await queryRunner.query(`ALTER TABLE "goods_receipt_lines" DROP COLUMN IF EXISTS "quantityReturnedInvoiced"`);
    await queryRunner.query(`ALTER TABLE "purchase_order_lines" DROP COLUMN IF EXISTS "quantityReturnedInvoiced"`);
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1::text[])`, [this.terms.map(([code]) => code)]);
  }
}
