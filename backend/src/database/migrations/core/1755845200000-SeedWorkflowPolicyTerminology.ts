import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-1 (EXCEL_BUSINESS_MAPPING_PACKAGE.md, CTO handover directive §6) — per-customer workflow policy UI. */
export class SeedWorkflowPolicyTerminology1755845200000 implements MigrationInterface {
  name = 'SeedWorkflowPolicyTerminology1755845200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.order_workflow_policy', 'field', 'سياسة سير الطلب', 'Order Workflow'],
      ['workflow_policy.standard', 'workflow_policy', 'معياري (مراجعة + عربون)', 'Standard (Review + Deposit)'],
      ['workflow_policy.open_account', 'workflow_policy', 'حساب مفتوح (بدون مراجعة)', 'Open Account (No Review)'],
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
    const codes = ['field.order_workflow_policy', 'workflow_policy.standard', 'workflow_policy.open_account'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
