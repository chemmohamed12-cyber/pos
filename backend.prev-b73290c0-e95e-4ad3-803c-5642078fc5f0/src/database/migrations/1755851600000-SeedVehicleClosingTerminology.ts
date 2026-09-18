import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master continuation directive (Company Vehicle Shipping §5) — terminology
 * for the new "close vehicle custody" card on CustodianDetail.tsx. Reuses
 * the existing `action.start_count` code (already seeded for the general
 * Stock Count screen) — only the vehicle-closing-specific labels are new.
 */
export class SeedVehicleClosingTerminology1755851600000 implements MigrationInterface {
  name = 'SeedVehicleClosingTerminology1755851600000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['panel.close_vehicle_custody', 'panel', 'إغلاق عهدة السيارة', 'Close Vehicle Custody'],
    [
      'panel.close_vehicle_custody_blocked',
      'panel',
      'لا يمكن الإغلاق أثناء وجود شحنات نشطة على هذه السيارة — يجب تسليمها أو إرجاعها أولاً.',
      'Cannot close while this vehicle has active shipments — deliver or return them first.',
    ],
    ['field.transfer_destination_warehouse', 'field', 'المخزن المستلم', 'Destination Warehouse'],
    ['action.transfer_remaining_stock', 'action', 'ترحيل المتبقي إلى المخزن', 'Transfer Remaining Stock'],
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
