import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D9 (2026-10-05, CTO register: supplier edit + auto-numbered code, no per-supplier GL account) — Suppliers screen: the code is
 * issued by the system (read-only after creation) and master data can be edited. Same idempotent seed shape as every other
 * terminology migration.
 */
export class SeedSupplierEditTerminology1789970000000 implements MigrationInterface {
  name = 'SeedSupplierEditTerminology1789970000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.supplier_code_auto', 'panel', 'يُولَّد كود المورد تلقائيًا عند الحفظ ولا يمكن تغييره لاحقًا.', 'The supplier code is generated automatically on save and cannot be changed later.'],
    ['action.edit_supplier', 'action', 'تعديل بيانات المورد', 'Edit supplier'],
    ['panel.supplier_edit_note', 'panel', 'تعديل البيانات لا يغيّر المستندات السابقة. رقم التسجيل الضريبي مطلوب لتسجيل فاتورة مورد بها ضريبة قيمة مضافة. الحسابات البنكية تخضع للموافقة.', 'Edits do not alter past documents. A VAT registration number is required to post a supplier invoice that carries VAT. Bank accounts remain approval-gated.'],
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
