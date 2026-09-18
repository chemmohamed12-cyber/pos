import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `accounting`-tagged (ADR-025). Systematic gap audit after Phase 1/2
 * (2026-09-17), found live via the new `Approvals.tsx` admin page: F04
 * (`ArAdjustmentService.onModuleInit`) registers its FA-01 request types
 * with `action.ar_${kind}` titleCodes, and F13 (`FiscalPeriodService.
 * onModuleInit`) with `action.fiscal_period_close`/`_reopen`/
 * `action.fiscal_year_close` — but unlike F05's identical `action.ap_*`
 * pattern (`SeedApTerminology1755855410000`), NONE of these 8 codes were
 * ever seeded, so `ApprovalRequestType.titleCode` rendered as a raw,
 * untranslated code everywhere it's read (confirmed live in `Approvals.
 * tsx`'s request-type picker). Same idempotent (`ON CONFLICT`) shape,
 * same Arabic/English style as `SeedApTerminology`'s own `action.ap_*`
 * rows.
 */
export class SeedArAndFiscalClosingRequestTypeTitles1789623729706 implements MigrationInterface {
  name = 'SeedArAndFiscalClosingRequestTypeTitles1789623729706';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['action.ar_write_off', 'field', 'اعتماد إعدام دين', 'Approve Write-off'],
    ['action.ar_credit_note', 'field', 'اعتماد إشعار دائن', 'Approve Credit Note'],
    ['action.ar_debit_note', 'field', 'اعتماد إشعار مدين', 'Approve Debit Note'],
    ['action.ar_adjustment', 'field', 'اعتماد تسوية ذمم مدينة', 'Approve AR Adjustment'],
    ['action.ar_opening_balance', 'field', 'اعتماد رصيد افتتاحي (ذمم مدينة)', 'Approve AR Opening Balance'],
    ['action.fiscal_period_close', 'field', 'اعتماد إغلاق الفترة المالية', 'Approve Fiscal Period Close'],
    ['action.fiscal_period_reopen', 'field', 'اعتماد إعادة فتح الفترة المالية', 'Approve Fiscal Period Reopen'],
    ['action.fiscal_year_close', 'field', 'اعتماد إغلاق السنة المالية', 'Approve Fiscal Year Close'],
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
