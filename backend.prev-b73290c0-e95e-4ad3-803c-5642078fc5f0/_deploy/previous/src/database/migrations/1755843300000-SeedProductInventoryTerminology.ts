import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terminology Registry expansion, part 4 — Products/Warehouses/Inventory
 * management screens (CTO directive §2/§5).
 */
export class SeedProductInventoryTerminology1755843300000 implements MigrationInterface {
  name = 'SeedProductInventoryTerminology1755843300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.sku', 'field', 'رمز المنتج', 'SKU'],
      ['field.on_hand', 'field', 'الرصيد الفعلي', 'On Hand'],
      ['field.reserved', 'field', 'محجوز', 'Reserved'],
      ['field.available', 'field', 'المتاح', 'Available'],
      ['field.movement_type', 'field', 'نوع الحركة', 'Movement Type'],
      ['product_status.draft', 'product_status', 'مسودة', 'Draft'],
      ['product_status.active', 'product_status', 'نشط', 'Active'],
      ['product_status.discontinued', 'product_status', 'موقوف', 'Discontinued'],
      ['movement_type.receipt', 'movement_type', 'إذن استلام', 'Receipt'],
      ['movement_type.dispatch', 'movement_type', 'إذن صرف', 'Dispatch'],
      ['movement_type.adjustment', 'movement_type', 'تسوية مخزون', 'Adjustment'],
      ['movement_type.transfer_in', 'movement_type', 'تحويل وارد', 'Transfer In'],
      ['movement_type.transfer_out', 'movement_type', 'تحويل صادر', 'Transfer Out'],
      ['movement_type.return', 'movement_type', 'مرتجع', 'Return'],
      ['action.activate', 'action', 'تفعيل', 'Activate'],
      ['action.discontinue', 'action', 'إيقاف', 'Discontinue'],
      ['action.record_movement', 'action', 'تسجيل حركة مخزون', 'Record Movement'],
      ['action.check_stock', 'action', 'استعلام عن الرصيد', 'Check Stock'],
      ['panel.no_products_yet', 'panel', 'لا توجد منتجات بعد', 'No products yet.'],
      ['panel.no_warehouses_yet', 'panel', 'لا توجد مخازن بعد', 'No warehouses yet.'],
    ];

    for (const [code, category, ar, en] of seed) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = [
      'field.sku', 'field.on_hand', 'field.reserved', 'field.available', 'field.movement_type',
      'product_status.draft', 'product_status.active', 'product_status.discontinued',
      'movement_type.receipt', 'movement_type.dispatch', 'movement_type.adjustment',
      'movement_type.transfer_in', 'movement_type.transfer_out', 'movement_type.return',
      'action.activate', 'action.discontinue', 'action.record_movement', 'action.check_stock',
      'panel.no_products_yet', 'panel.no_warehouses_yet',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
