import { MigrationInterface, QueryRunner } from 'typeorm';

/** T3 (2026-10-20) - labels for the two Treasury posting-profile policy entries and the four new Treasury navigation items (same idempotent seed shape as every other terminology migration). */
export class SeedTreasuryDocumentTerminology1790030200000 implements MigrationInterface {
  name = 'SeedTreasuryDocumentTerminology1790030200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['policy.treasury_receipt_reason_accounts.label', 'field', 'حسابات أسباب الاستلام النقدي المتنوع', 'Miscellaneous receipt reason accounts'],
    ['policy.treasury_receipt_reason_accounts.help', 'panel', 'لكل سبب استلام حساب مقابل معتمد؛ لا يمكن تحضير مستند استلام بسبب غير مربوط.', 'One approved counter account per receipt reason; a receipt document with an unmapped reason cannot be prepared.'],
    ['policy.treasury_disbursement_reason_accounts.label', 'field', 'حسابات أسباب الصرف النقدي', 'Disbursement reason accounts'],
    ['policy.treasury_disbursement_reason_accounts.help', 'panel', 'لكل سبب صرف حساب مقابل معتمد؛ لا يمكن تحضير مستند صرف بسبب غير مربوط.', 'One approved counter account per disbursement reason; a disbursement document with an unmapped reason cannot be prepared.'],
    ['nav.treasury_workspace', 'nav', 'مساحة عمل الخزينة', 'Treasury workspace'],
    ['nav.treasury_documents', 'nav', 'مستندات الخزينة', 'Treasury documents'],
    ['nav.treasury_bank_statements', 'nav', 'كشوف الحسابات البنكية', 'Bank statements'],
    ['nav.treasury_cash_sessions', 'nav', 'جلسات الخزينة النقدية', 'Cash sessions'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
