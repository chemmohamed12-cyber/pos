import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Security/gap review — the Collection Receipt print page had no
 * terminology entries of its own; reuses every existing code it can
 * (field.waybill, field.rsh_number, field.sales_order, field.customer,
 * field.payment_method, field.shipping_company, field.vehicle,
 * field.collected_amount, remittance_status.pending/remitted all already
 * exist) — only the document title and the one new field are seeded here.
 */
export class SeedCollectionReceiptTerminology1755851900000 implements MigrationInterface {
  name = 'SeedCollectionReceiptTerminology1755851900000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['document.collection_receipt_title', 'document', 'إيصال تحصيل', 'Collection Receipt'],
    ['field.remitted_at', 'field', 'تاريخ التوريد', 'Remitted At'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
  }
}
