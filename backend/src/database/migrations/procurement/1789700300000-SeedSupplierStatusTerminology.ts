import { MigrationInterface, QueryRunner } from 'typeorm';

/** `procurement`-tagged (ADR-025). `StatusBadge` codes for `Supplier.status` — same shape as `warehouse_status.*`. */
export class SeedSupplierStatusTerminology1789700300000 implements MigrationInterface {
  name = 'SeedSupplierStatusTerminology1789700300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ('supplier_status.active', 'field', 'نشط', 'Active'),
       ('supplier_status.inactive', 'field', 'غير نشط', 'Inactive'),
       ('action.activate_supplier', 'field', 'تفعيل المورد', 'Activate Supplier'),
       ('action.deactivate_supplier', 'field', 'إلغاء تفعيل المورد', 'Deactivate Supplier')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "terminology_entries" WHERE code IN ('supplier_status.active','supplier_status.inactive','action.activate_supplier','action.deactivate_supplier')`,
    );
  }
}
