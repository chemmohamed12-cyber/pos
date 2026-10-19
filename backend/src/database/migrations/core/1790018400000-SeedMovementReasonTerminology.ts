import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-INV-04 (2026-10-19) - labels for the movement reason catalog and the reference-enforcement setting. Data only; every code is NEW and the insert never rewrites an existing label
 * (ON CONFLICT DO NOTHING); `down` removes exactly these rows.
 */
export class SeedMovementReasonTerminology1790018400000 implements MigrationInterface {
  name = 'SeedMovementReasonTerminology1790018400000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['movement_reason.found_stock', 'field', 'مخزون وُجد زائدًا', 'Stock found'],
    ['movement_reason.donation', 'field', 'تبرع', 'Donation'],
    ['movement_reason.opening_balance', 'field', 'رصيد افتتاحي', 'Opening balance'],
    ['movement_reason.internal_consumption', 'field', 'استهلاك داخلي', 'Internal consumption'],
    ['movement_reason.sample', 'field', 'عينة', 'Sample'],
    ['movement_reason.scrap_waste', 'field', 'هالك / تالف', 'Scrap / waste'],
    ['movement_reason.sale', 'field', 'بيع', 'Sale'],
    ['movement_reason.count_variance', 'field', 'فرق جرد', 'Count variance'],
    ['movement_reason.damage', 'field', 'تلف', 'Damage'],
    ['movement_reason.correction', 'field', 'تصحيح', 'Correction'],
    ['movement_reason.opening_correction', 'field', 'تصحيح رصيد افتتاحي', 'Opening balance correction'],
    ['movement_reason.internal_transfer', 'field', 'تحويل داخلي', 'Internal transfer'],
    ['policy.inventory_reference_enforcement.label', 'field', 'التحقق من السبب والمرجع في مستندات المخزن', 'Reason / reference check on warehouse documents'],
    ['policy.inventory_reference_enforcement.help', 'panel', 'إيقاف، أو تحذير (يُسمح ويُسجَّل في التدقيق)، أو إلزام (يُرفض المستند قبل أي كتابة).', 'Off, warn (allowed and audited) or enforce (the document is refused before anything is written).'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
