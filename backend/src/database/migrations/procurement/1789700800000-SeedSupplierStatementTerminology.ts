import { MigrationInterface, QueryRunner } from 'typeorm';

/** `procurement`-tagged (ADR-025). Supplier Statement screen — every other field/action code it uses already exists (field.document_type, field.date_from/to, action.search/export, …), reused as-is. */
export class SeedSupplierStatementTerminology1789700800000 implements MigrationInterface {
  name = 'SeedSupplierStatementTerminology1789700800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ('nav.supplier_statement', 'field', 'كشف حساب المورد', 'Supplier Statement'),
       ('panel.select_supplier_to_view_statement', 'panel', 'اختر موردًا لعرض كشف الحساب', 'Select a supplier to view their statement')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code IN ('nav.supplier_statement','panel.select_supplier_to_view_statement')`);
  }
}
