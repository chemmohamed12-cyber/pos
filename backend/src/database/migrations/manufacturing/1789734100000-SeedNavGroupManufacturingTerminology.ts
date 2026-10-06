import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Navigation Root-Cause Fix (2026-09-26, CTO-authorized — "Full Navigation
 * Closure"). Same gap `SeedNavGroupHrTerminology1755854300000` fixed for
 * `nav_group.hr`: `nav.manufacturing_work_orders` (the item label) was
 * already seeded (`SeedManufacturingTerminology`), but the nav GROUP label
 * itself, `nav_group.manufacturing`, was never seeded — confirmed absent
 * anywhere in migration history before this file. Seeding the label does
 * NOT entitle/enable anything — the group still renders empty today
 * because `manufacturing.work_orders` (the feature gate on the one item
 * in this group) is `default: false`; this only ensures the group header
 * shows a real label instead of a raw-code fallback on the day that
 * feature is turned on for an installation.
 */
export class SeedNavGroupManufacturingTerminology1789734100000 implements MigrationInterface {
  name = 'SeedNavGroupManufacturingTerminology1789734100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('nav_group.manufacturing', 'nav', 'التصنيع', 'Manufacturing')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'nav_group.manufacturing'`);
  }
}
