import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `logistics`-tagged (ADR-025). Historical Requirements Audit (2026-09-17),
 * A4 — the legacy `ReturnRequest`/custody-reversal flow (shipping company
 * / vehicle custody) MUST stay clearly distinct from the new `ShipmentReturn`
 * aggregate (CTO ratification, 2026-09-16: "leave `ReturnRequest` completely
 * untouched", never merged with the two new Return types). `nav.
 * custody_returns` was seeded (`1755850900000-AddCustodyReturns`, pre-dating
 * `ShipmentReturn` by three weeks) with the Arabic text "مرتجعات الشحن" —
 * BYTE-FOR-BYTE identical to `nav.shipment_returns`'s own Arabic text
 * (confirmed live: both nav entries render the same label in the Arabic-
 * first sidebar, even though their English texts and routes were always
 * correctly distinct). Corrected to "مرتجعات العهدة" ("Custody Returns"),
 * matching this codebase's own existing "عهدة" (custody) vocabulary
 * (`field.custodian_type` et al.). English/routes/permissions/backend
 * untouched — a label-only fix. Same idempotent (`ON CONFLICT`) shape as
 * every other terminology seed.
 */
export class FixCustodyReturnsArabicLabel1789656229165 implements MigrationInterface {
  name = 'FixCustodyReturnsArabicLabel1789656229165';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('nav.custody_returns', 'nav', 'مرتجعات العهدة', 'Custody Returns')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ('nav.custody_returns', 'nav', 'مرتجعات الشحن', 'Custody Returns')
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }
}
