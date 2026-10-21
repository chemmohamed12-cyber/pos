import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Procurement invoicing redesign, phase C-1 (D2 tolerances + D5 lifecycle + D1 controlled exception) - purely additive:
 *  - nullable columns on `supplier_invoices` for the approval trail and the matching result (no existing value is touched);
 *  - `procurement_invoice_policies`: ONE row per Company (unique on a constant) with the approval switch and the price-tolerance limits. No row = the legacy behaviour
 *    (direct draft -> posted, price variance informational), so an existing Company behaves exactly as before until its administrator turns the approval workflow on;
 *  - terminology for the new states and screens.
 * `down` drops the table and the columns (the columns hold approval metadata only; documents, numbers, amounts, journals are untouched).
 */
export class AddSupplierInvoiceApprovalAndPolicy1790020200000 implements MigrationInterface {
  name = 'AddSupplierInvoiceApprovalAndPolicy1790020200000';

  private readonly columns: Array<[string, string]> = [
    ['submittedByUserId', 'UUID'],
    ['submittedAt', 'TIMESTAMPTZ'],
    ['approvedByUserId', 'UUID'],
    ['approvedAt', 'TIMESTAMPTZ'],
    ['matchStatus', 'VARCHAR(24)'],
    ['matchDetail', 'JSONB'],
    ['holdReason', 'VARCHAR(500)'],
    ['exceptionReason', 'VARCHAR(500)'],
    ['rejectedReason', 'VARCHAR(500)'],
  ];

  private readonly terms: Array<[string, string, string, string]> = [
    ['supplier_invoice_lifecycle.state.submitted', 'field', 'مرسلة للاعتماد', 'Submitted'],
    ['supplier_invoice_lifecycle.state.approved', 'field', 'معتمدة', 'Approved'],
    ['supplier_invoice_lifecycle.state.on_hold', 'field', 'معلّقة للمراجعة', 'On hold'],
    ['supplier_invoice_lifecycle.state.rejected', 'field', 'مرفوضة', 'Rejected'],
    ['action.submit_supplier_invoice', 'field', 'إرسال للاعتماد', 'Submit for approval'],
    ['action.approve_supplier_invoice', 'field', 'اعتماد الفاتورة', 'Approve invoice'],
    ['action.approve_invoice_exception', 'field', 'اعتماد استثنائي', 'Approve as exception'],
    ['action.reject_supplier_invoice', 'field', 'رفض الفاتورة', 'Reject invoice'],
    ['action.reopen_supplier_invoice', 'field', 'إعادة فتح كمسودة', 'Reopen as draft'],
    ['field.match_status', 'field', 'نتيجة المطابقة', 'Matching result'],
    ['field.hold_reason', 'field', 'سبب التعليق', 'Hold reason'],
    ['field.exception_reason', 'field', 'سبب الاستثناء', 'Exception reason'],
    ['permission.procurement.supplier_invoice.submit', 'field', 'إرسال فواتير الموردين للاعتماد', 'Submit supplier invoices'],
    ['permission.procurement.supplier_invoice.approve', 'field', 'اعتماد فواتير الموردين', 'Approve supplier invoices'],
    ['permission.procurement.supplier_invoice.override', 'field', 'اعتماد استثنائي لفواتير الموردين', 'Approve supplier invoice exceptions'],
    ['permission.procurement.invoice_policy.manage', 'field', 'ضبط سياسة مطابقة فواتير الموردين', 'Manage supplier invoice matching policy'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, type] of this.columns) {
      await queryRunner.query(`ALTER TABLE "supplier_invoices" ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
    }
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "procurement_invoice_policies" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "singleton" BOOLEAN NOT NULL DEFAULT true CHECK ("singleton"),
        "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
        "priceTolerancePct" NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK ("priceTolerancePct" >= 0),
        "priceToleranceAmount" NUMERIC(18,2) CHECK ("priceToleranceAmount" IS NULL OR "priceToleranceAmount" >= 0),
        "toleranceDirection" VARCHAR(12) NOT NULL DEFAULT 'both' CHECK ("toleranceDirection" IN ('both','over_only')),
        "updatedByUserId" UUID,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_procurement_invoice_policies_singleton" ON "procurement_invoice_policies" ("singleton")`);

    const values = this.terms.map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`).join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "procurement_invoice_policies"`);
    for (const [name] of this.columns) {
      await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN IF EXISTS "${name}"`);
    }
    const codes = this.terms.map(([code]) => `'${code}'`).join(', ');
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code IN (${codes})`);
  }
}
