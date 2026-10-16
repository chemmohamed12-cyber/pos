import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supplier profile page (master-data gap matrix §5, M7 continued) — the labels that did not exist yet (each code was checked against every
 * earlier migration; the shared profile labels live in 1790016200000 and existing ones such as `field.legal_name` are reused). Data only.
 * `up` never overwrites an existing label (`ON CONFLICT DO NOTHING`); `down` removes exactly these rows.
 */
export class SeedSupplierProfileTerminology1790016400000 implements MigrationInterface {
  name = 'SeedSupplierProfileTerminology1790016400000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.supplier_profile', 'panel', 'ملف المورد', 'Supplier profile'],
    ['panel.supplier_purchases', 'panel', 'المشتريات', 'Purchases'],
    ['panel.purchase_orders', 'panel', 'أوامر الشراء', 'Purchase orders'],
    ['panel.supplier_invoices', 'panel', 'فواتير المورد', 'Supplier invoices'],
    ['panel.supplier_payments', 'panel', 'مدفوعات المورد', 'Supplier payments'],
    ['panel.bank_accounts', 'panel', 'الحسابات البنكية', 'Bank accounts'],
    ['panel.no_records_yet', 'panel', 'لا توجد سجلات بعد', 'No records yet'],
    ['action.open_supplier_profile', 'action', 'فتح ملف المورد', 'Open supplier profile'],
    ['action.back_to_suppliers', 'action', 'العودة إلى الموردين', 'Back to suppliers'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
