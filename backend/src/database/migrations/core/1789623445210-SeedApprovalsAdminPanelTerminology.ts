import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `core`-tagged (ADR-025). Systematic gap audit after Phase 1/2 (2026-09-17)
 * — `nav.approvals` + the approval-matrix field/action labels were seeded
 * by `CreateApprovalEngine1755855500000` (FA-01's own migration) but no
 * frontend page was ever built to consume them (confirmed: zero references
 * to `/approvals/matrix-rules` or `/approvals/request-types` anywhere in
 * the workspace). This is the two small panel/field labels a generic
 * `Approvals.tsx` admin page needs that weren't already covered. Same
 * idempotent (`ON CONFLICT`) shape as every other terminology seed.
 */
export class SeedApprovalsAdminPanelTerminology1789623445210 implements MigrationInterface {
  name = 'SeedApprovalsAdminPanelTerminology1789623445210';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.request_type_code', 'field', 'رمز نوع الطلب', 'Request Type Code'],
    ['panel.no_approval_requests_pending', 'field', 'لا توجد طلبات معلّقة', 'No pending requests'],
    ['panel.no_matrix_rules_yet', 'field', 'لا توجد قواعد موافقة بعد', 'No approval rules yet'],
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
