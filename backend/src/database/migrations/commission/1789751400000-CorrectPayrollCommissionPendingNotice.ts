import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-070 §J/ADR-071 §9 — `panel.payroll_commission_pending_notice` (seeded
 * by `1789740200000-SeedPayrollPhase1Terminology.ts`, when Commission
 * itself did not exist yet) said Commission consumption "is not yet wired
 * in this release." `PayrollService.calculate()` now consumes
 * `CommissionService.listApprovedCommissionResults()` for real (this same
 * commit) — the old text is stale and actively misleading in the Payroll
 * Run Detail UI. Corrected via the same idempotent upsert every
 * terminology migration in this codebase uses — supersede via new
 * content, never rewrite history.
 */
export class CorrectPayrollCommissionPendingNotice1789751400000 implements MigrationInterface {
  name = 'CorrectPayrollCommissionPendingNotice1789751400000';

  private readonly code = 'panel.payroll_commission_pending_notice';
  private readonly newAr = 'مبلغ العمولة هنا يعكس فقط نتائج العمولة المعتمدة (Approved Commission Result) من وحدة العمولات — أي نتيجة غير معتمدة لا تُدرج أبدًا.';
  private readonly newEn = "Commission Amount here reflects only APPROVED Commission Results from the Commission module — an unapproved result is never included.";
  private readonly oldAr = 'استهلاك نتائج العمولة المعتمدة من Commission لم يُفعَّل بعد في هذا الإصدار.';
  private readonly oldEn = 'Consumption of Approved Commission Results is not yet wired in this release.';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "terminology_entries" SET "ar" = $1, "en" = $2, "version" = "version" + 1 WHERE "code" = $3`,
      [this.newAr, this.newEn, this.code],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "terminology_entries" SET "ar" = $1, "en" = $2, "version" = "version" + 1 WHERE "code" = $3`,
      [this.oldAr, this.oldEn, this.code],
    );
  }
}
