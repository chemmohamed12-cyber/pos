import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `logistics`-tagged (ADR-025). Warehouse / Shipment Operations
 * Requirement (2026-09-17) — the dispatch-warehouse board's filter bar
 * needs one label `Shipments.tsx` had no existing code for (customer/
 * governorate/rep/status/from-date/to-date all already existed and are
 * reused as-is). Same idempotent (`ON CONFLICT`) shape as every other
 * terminology seed.
 */
export class SeedShipmentBoardFilterTerminology1789658077538 implements MigrationInterface {
  name = 'SeedShipmentBoardFilterTerminology1789658077538';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('field.shipment_or_order_number', 'field', 'رقم الشحنة / الطلب', 'Shipment / Order Number')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'field.shipment_or_order_number'`);
  }
}
