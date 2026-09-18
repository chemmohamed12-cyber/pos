import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `logistics`-tagged (ADR-025). Historical Requirements Audit (2026-09-17),
 * A1.7 — `ShipmentReturns.tsx`'s create form showed Shipped Quantity and
 * Return Quantity per line but never Previously Returned / Remaining
 * Returnable, even though the CTO-ratified UI spec (2026-09-16) explicitly
 * lists both. `field.available_quantity` (already seeded, `1755863300000`)
 * is reused for "Remaining" — this seeds the one missing label. Same
 * idempotent (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedShipmentReturnCapacityTerminology1789654616058 implements MigrationInterface {
  name = 'SeedShipmentReturnCapacityTerminology1789654616058';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('field.previously_returned_quantity', 'field', 'المرتجع سابقًا', 'Previously Returned')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'field.previously_returned_quantity'`);
  }
}
