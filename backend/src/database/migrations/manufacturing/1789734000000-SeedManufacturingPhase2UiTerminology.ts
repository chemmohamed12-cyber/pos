import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manufacturing UI Phase 2 (team directive, post-ADR-061 §18 delivery) —
 * terminology for the new Work Orders list columns/filters, the
 * Manufacturing Cover's WIP/activity additions, and the Work Order
 * Detail's new Financial Events / Audit Trail sections. Only codes that do
 * NOT already exist elsewhere in the codebase are seeded here
 * (`field.debit`/`field.credit`/`panel.no_financial_events_yet`/
 * `field.all_document_types`/`field.rejection_reason`/`field.business_date`
 * already exist and are reused unmodified — verified by direct query
 * before writing this migration).
 */
export class SeedManufacturingPhase2UiTerminology1789734000000 implements MigrationInterface {
  name = 'SeedManufacturingPhase2UiTerminology1789734000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['field.account', 'field', 'الحساب', 'Account'],
    ['field.actor', 'field', 'المستخدم', 'Actor'],
    ['field.result', 'field', 'النتيجة', 'Result'],
    ['field.financial_events', 'field', 'الأحداث المالية', 'Financial Events'],
    ['field.audit_trail', 'field', 'سجل التدقيق', 'Audit Trail'],
    ['field.in_production', 'field', 'قيد الإنتاج', 'In Production'],
    ['field.recent_work_orders', 'field', 'أحدث أوامر الإنتاج', 'Recent Work Orders'],
    ['panel.no_audit_trail_yet', 'panel', 'لا يوجد سجل تدقيق بعد', 'No audit trail yet'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = this.rows
      .map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`)
      .join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = this.rows.map(([code]) => `'${code}'`).join(', ');
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code IN (${codes})`);
  }
}
