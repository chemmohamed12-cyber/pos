import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Frontend recovery/integration pass,
 * systematic gap audit after Phase 1/2 (2026-09-17) — F13 (Financial
 * Closing, ADR-046) shipped its full backend (routine `FiscalPeriod`
 * transitions + FA-01-gated period close/reopen + FA-01-gated fiscal year
 * close) but `AccountingSettings.tsx` (built in this same recovery pass)
 * only wired fiscal year creation/activation, not closing — this seeds the
 * remaining action/value labels `AccountingSettings.tsx` needs to close
 * that gap. `action.close_fiscal_year`/`action.reopen_fiscal_period`
 * already existed (`SeedAccountingTerminology1755854500000`) and are
 * reused as-is, not re-seeded here. Same idempotent (`ON CONFLICT`) shape
 * as every other terminology seed.
 */
export class SeedFiscalClosingTerminology1789622214177 implements MigrationInterface {
  name = 'SeedFiscalClosingTerminology1789622214177';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['action.soft_close', 'field', 'إغلاق مبدئي', 'Soft Close'],
    ['action.reopen_from_soft_close', 'field', 'التراجع عن الإغلاق المبدئي', 'Reopen from Soft Close'],
    ['action.close_after_reopen', 'field', 'إغلاق بعد إعادة الفتح', 'Close After Reopen'],
    ['action.submit_period_close', 'field', 'تقديم طلب إغلاق نهائي', 'Submit Period Close'],
    ['value.fiscal_year_status.planned', 'field', 'مخطط لها', 'Planned'],
    ['value.fiscal_year_status.active', 'field', 'نشطة', 'Active'],
    ['value.fiscal_year_status.closed', 'field', 'مغلقة', 'Closed'],
    ['value.fiscal_period_status.open', 'field', 'مفتوحة', 'Open'],
    ['value.fiscal_period_status.soft_close', 'field', 'إغلاق مبدئي', 'Soft Closed'],
    ['value.fiscal_period_status.closed', 'field', 'مغلقة', 'Closed'],
    ['value.fiscal_period_status.reopened', 'field', 'أُعيد فتحها', 'Reopened'],
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
