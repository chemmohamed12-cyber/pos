import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-071 (Commission Phase 1) — Policies, Results, Batches screens.
 * `field.employee`, `field.status`, `field.actions`, `field.amount`,
 * `field.reason`, `field.adjustment_kind`, `field.amount_delta`,
 * `value.adjustment_kind.*`, `value.approval_status.*` already exist
 * (Payroll's own seed, `1789740200000-SeedPayrollPhase1Terminology.ts`)
 * and are reused as-is — the same shape `PayrollAdjustment` and
 * `CommissionAdjustment` already share.
 */
export class SeedCommissionPhase1Terminology1789751300000 implements MigrationInterface {
  name = 'SeedCommissionPhase1Terminology1789751300000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.commission', 'field', 'العمولات', 'Commission'],
    ['nav.commission_policies', 'field', 'سياسات العمولة', 'Commission Policies'],
    ['nav.commission_results', 'field', 'نتائج العمولة', 'Commission Results'],
    ['nav.commission_batches', 'field', 'دفعات اعتماد العمولة', 'Commission Batches'],

    ['field.scope', 'field', 'النطاق', 'Scope'],
    ['field.basis', 'field', 'الأساس', 'Basis'],
    ['field.rate_model', 'field', 'نموذج النسبة', 'Rate Model'],
    ['field.flat_rate', 'field', 'نسبة ثابتة', 'Flat Rate'],
    ['field.rate', 'field', 'النسبة', 'Rate'],
    ['field.tier_order', 'field', 'ترتيب الشريحة', 'Tier Order'],
    ['field.from_percent', 'field', 'من نسبة%', 'From %'],
    ['field.to_percent', 'field', 'إلى نسبة%', 'To %'],
    ['field.batch', 'field', 'الدفعة', 'Batch'],
    ['field.unbatched_results', 'field', 'نتائج غير مجمّعة', 'Unbatched Results'],

    ['action.create_policy', 'action', 'إنشاء سياسة عمولة', 'Create Policy'],
    ['action.add_tier', 'action', 'إضافة شريحة', 'Add Tier'],
    ['action.view_tiers', 'action', 'عرض الشرائح', 'View Tiers'],
    ['action.create_adjustment', 'action', 'تسجيل تسوية', 'Create Adjustment'],
    ['action.submit_batch', 'action', 'تقديم الدفعة للاعتماد', 'Submit Batch'],

    ['panel.no_policies_yet', 'panel', 'لا توجد سياسات عمولة بعد', 'No commission policies yet'],
    [
      'panel.customer_group_inert_notice',
      'panel',
      'نطاق مجموعة العملاء موجود معماريًا لكنه غير مُفعَّل حاليًا — لا يوجد كيان مجموعة عملاء منظم بعد؛ التصنيف يبقى حقل نصي حر.',
      'The Customer Group scope is architecturally present but functionally inert — there is no structured Customer Group entity yet; classification remains free text.',
    ],
    ['panel.no_results_yet', 'panel', 'لا توجد نتائج عمولة بعد', 'No commission results yet'],
    ['panel.no_batches_yet', 'panel', 'لا توجد دفعات اعتماد بعد', 'No approval batches yet'],

    ['value.commission_scope.sales_rep', 'field', 'مندوب مبيعات', 'Sales Rep'],
    ['value.commission_scope.customer', 'field', 'عميل', 'Customer'],
    ['value.commission_scope.customer_group', 'field', 'مجموعة عملاء', 'Customer Group'],

    ['value.commission_basis.gross_sales', 'field', 'إجمالي المبيعات', 'Gross Sales'],
    ['value.commission_basis.net_sales', 'field', 'صافي المبيعات', 'Net Sales'],
    ['value.commission_basis.collected_amount', 'field', 'المبلغ المُحصَّل', 'Collected Amount'],

    ['value.commission_rate_model.flat', 'field', 'ثابتة', 'Flat'],
    ['value.commission_rate_model.target_tiered', 'field', 'شرائح حسب المستهدف', 'Target-Tiered'],

    ['value.commission_batch_status.draft', 'field', 'مسودة', 'Draft'],
    ['value.commission_batch_status.submitted', 'field', 'مقدّمة للاعتماد', 'Submitted'],
    ['value.commission_batch_status.approved', 'field', 'معتمدة', 'Approved'],
    ['value.commission_batch_status.rejected', 'field', 'مرفوضة', 'Rejected'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
