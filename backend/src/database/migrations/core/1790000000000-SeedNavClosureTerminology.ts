import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-06 / NAV-08 / NAV-12 / NAV-13 / NAV-14 (2026-10-06):
 *  - NAV-06  canonical-BOM notice.
 *  - NAV-08  Reports hub group titles.
 *  - NAV-12  the Fulfilment sidebar group had the English label "Production", colliding with "Manufacturing" — relabelled "Fulfilment" (the Arabic
 *            label "التجهيز" is unchanged).
 *  - NAV-13  Dashboard "your work areas" title.
 *  - NAV-14  the six approval request types that showed a raw key on the Approvals screen (attendance x2, commission, payroll, targets, fiscal reclose).
 * Idempotent upsert; every text <= 255 characters.
 */
export class SeedNavClosureTerminology1790000000000 implements MigrationInterface {
  name = 'SeedNavClosureTerminology1790000000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.bom_canonical_notice', 'panel', 'قوائم المواد الكاملة (الإصدارات والحالات) تُدار من شاشة التصنيع:', 'Full bills of materials (versions, statuses) are managed from the Manufacturing screen:'],
    ['reports_hub.title', 'panel', 'كل التقارير في مكان واحد', 'All reports in one place'],
    ['reports_hub.financial', 'panel', 'القوائم والتقارير المالية', 'Financial statements'],
    ['reports_hub.partners', 'panel', 'العملاء والموردون (أعمار الديون وكشوف الحساب)', 'Customers & suppliers (aging and statements)'],
    ['reports_hub.reconciliations', 'panel', 'التسويات والمطابقات', 'Reconciliations'],
    ['nav_group.production', 'nav', 'التجهيز', 'Fulfilment'],
    ['panel.dashboard_sections_title', 'panel', 'أقسام العمل المتاحة لك', 'Your work areas'],
    ['action.attendance_submit_approval_batch', 'action', 'اعتماد دفعة الحضور', 'Approve attendance batch'],
    ['action.attendance_correction', 'action', 'تصحيح بيانات الحضور', 'Attendance correction'],
    ['action.commission_submit_approval', 'action', 'اعتماد العمولات', 'Approve commissions'],
    ['action.payroll_submit_approval', 'action', 'اعتماد مسير الرواتب', 'Approve payroll run'],
    ['action.targets_submit_approval', 'action', 'اعتماد المستهدفات', 'Approve targets'],
    ['action.fiscal_period_reclose', 'action', 'إعادة إقفال فترة مالية', 'Re-close fiscal period'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // nav_group.production goes back to its previous English label; every other row was new
    await queryRunner.query(`UPDATE "terminology_entries" SET "en" = 'Production' WHERE code = 'nav_group.production'`);
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code).filter((c) => c !== 'nav_group.production')]);
  }
}
