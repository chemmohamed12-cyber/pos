import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F03 GL Posting Concurrency RCA (`docs/studies/
 * F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`), Option C — CTO-approved
 * 2026-09-21 alongside Option B (automatic deadlock retry,
 * `financial-event.service.ts`). Widens the `category` CHECK constraint
 * `1789701400000-CreateClosingExceptionTable.ts` originally shipped
 * (ADR-051 §3's six values) to also accept `'TRANSIENT_DATABASE_ERROR'` —
 * `closing-exception-classification.ts`'s new, distinct classification
 * for a rejection matching a Postgres transient-concurrency-error
 * signature (deadlock/serialization failure), separate from
 * `UNCLASSIFIED_REJECTION`. Postgres has no `ALTER CHECK CONSTRAINT`;
 * drop and recreate with the widened list is the standard mechanism —
 * purely additive, no existing row's category value is affected.
 */
export class AddTransientDatabaseErrorClosingExceptionCategory1789760000000 implements MigrationInterface {
  name = 'AddTransientDatabaseErrorClosingExceptionCategory1789760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_closing_exceptions" DROP CONSTRAINT "CHK_accounting_closing_exceptions_category"`);
    await queryRunner.query(`
      ALTER TABLE "accounting_closing_exceptions" ADD CONSTRAINT "CHK_accounting_closing_exceptions_category" CHECK ("category" IN (
        'LIVE_DISCREPANCY', 'DORMANT_SOURCE', 'EXPECTED_BUSINESS_REJECTION',
        'CONFIGURATION_EXCEPTION', 'HISTORICAL_TEST_ARTIFACT', 'TRANSIENT_DATABASE_ERROR', 'UNCLASSIFIED_REJECTION'
      ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "accounting_closing_exceptions" DROP CONSTRAINT "CHK_accounting_closing_exceptions_category"`);
    await queryRunner.query(`
      ALTER TABLE "accounting_closing_exceptions" ADD CONSTRAINT "CHK_accounting_closing_exceptions_category" CHECK ("category" IN (
        'LIVE_DISCREPANCY', 'DORMANT_SOURCE', 'EXPECTED_BUSINESS_REJECTION',
        'CONFIGURATION_EXCEPTION', 'HISTORICAL_TEST_ARTIFACT', 'UNCLASSIFIED_REJECTION'
      ))
    `);
  }
}
