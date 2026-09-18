import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive (Phase 5 — Custody/Visibility, resumed) — terminology for
 * the Custody/COD Report, the dedicated Collection Settlements page, the
 * per-custodian detail page, and the in-transit filter on the Shipments
 * list. `field.custody_balance` / `field.active_shipments` already exist
 * (seeded by an earlier session) and are reused as-is, not reseeded here.
 */
export class SeedPhase5CustodyVisibilityTerminology1755851200000 implements MigrationInterface {
  name = 'SeedPhase5CustodyVisibilityTerminology1755851200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.cod_collected', 'field', 'إجمالي التحصيل (COD)', 'COD Collected'],
      ['field.cod_pending', 'field', 'قيد التوريد (COD)', 'COD Pending Remittance'],
      ['field.cod_remitted', 'field', 'تم توريده (COD)', 'COD Remitted'],
      ['panel.custody_cod_report', 'panel', 'تقرير العهدة والتحصيل النقدي', 'Custody & COD Report'],
      ['field.custodian_type', 'field', 'نوع الجهة الحائزة', 'Custodian Type'],
      ['panel.custodian_detail', 'panel', 'تفاصيل العهدة', 'Custodian Detail'],
      ['field.in_transit_only', 'field', 'الشحنات في الطريق فقط', 'In-Transit Only'],
      ['nav.collection_settlements', 'nav', 'تسويات التحصيل', 'Collection Settlements'],
      ['nav.custody_cod_report', 'nav', 'تقرير العهدة والتحصيل', 'Custody & COD Report'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [
      [
        'field.cod_collected',
        'field.cod_pending',
        'field.cod_remitted',
        'panel.custody_cod_report',
        'field.custodian_type',
        'panel.custodian_detail',
        'field.in_transit_only',
        'nav.collection_settlements',
        'nav.custody_cod_report',
      ],
    ]);
  }
}
