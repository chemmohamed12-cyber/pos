import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 — Accounts Receivable (ADR-036). A short follow-up terminology seed
 * for the strings the F04 AR page renders that weren't in the first pass
 * (`1755855200000-SeedArTerminology`). `accounting`-tagged (ADR-025),
 * ON CONFLICT-idempotent, same shape as every other terminology seed.
 */
export class SeedArTerminologyExtras1755855300000 implements MigrationInterface {
  name = 'SeedArTerminologyExtras1755855300000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.contra_account_code', 'field', 'كود الحساب المقابل', 'Contra Account Code'],
    ['field.movement_direction', 'field', 'اتجاه الحركة', 'Direction'],
    ['field.approval_request_id', 'field', 'رقم طلب الموافقة', 'Approval Request ID'],
    ['field.approval_decision', 'field', 'القرار', 'Decision'],
    ['field.drift_breakdown', 'field', 'تفصيل الفرق', 'Drift Breakdown'],
    ['value.movement_direction.debit', 'field', 'مدين', 'Debit'],
    ['value.movement_direction.credit', 'field', 'دائن', 'Credit'],
    ['action.close_reconciliation', 'field', 'إغلاق التسوية', 'Close Run'],
    ['action.load_customer_statement', 'field', 'عرض الكشف', 'Load Statement'],
    ['panel.ar_adjustment_submitted_approval', 'field', 'أُرسِلت التسوية للموافقة (Maker-Checker)', 'Adjustment submitted for approval (maker-checker)'],
    ['panel.ar_adjustment_posted', 'field', 'رُحِّلت التسوية إلى دفتر الأستاذ', 'Adjustment posted to the GL'],
    ['panel.ar_no_statement_rows', 'field', 'لا توجد حركات في الدفتر الفرعي لهذه الفترة', 'No subledger movements in this period'],
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
