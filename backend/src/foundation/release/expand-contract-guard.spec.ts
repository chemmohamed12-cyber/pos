import { scanForContraction } from './expand-contract-guard';

/**
 * 2026-09-22 false-positive, found validating v1.1.2's real migration set
 * against the newly-hardened (unconditional) expand/contract gate: widening
 * a Postgres CHECK constraint requires DROP + re-ADD under the same name
 * (no `ALTER CHECK CONSTRAINT` exists) — purely additive in effect, but
 * textually identical to a genuine unsafe drop to a per-statement scanner.
 * `1789760000000-AddTransientDatabaseErrorClosingExceptionCategory.ts` and
 * `1789730300000-AddBiometricDailySummaryImport.ts` were both incorrectly
 * blocked by this. These are their exact `up()` bodies (trimmed to the
 * relevant statements).
 */
describe('scanForContraction — DROP CONSTRAINT same-name redefinition', () => {
  it('does NOT flag a CHECK constraint dropped and redefined under the same name (v1.1.2 real case: accounting)', () => {
    const source = `
      export class AddTransientDatabaseErrorClosingExceptionCategory1789760000000 {
        public async up(queryRunner) {
          await queryRunner.query(\`ALTER TABLE "accounting_closing_exceptions" DROP CONSTRAINT "CHK_accounting_closing_exceptions_category"\`);
          await queryRunner.query(\`
            ALTER TABLE "accounting_closing_exceptions" ADD CONSTRAINT "CHK_accounting_closing_exceptions_category" CHECK ("category" IN (
              'LIVE_DISCREPANCY', 'DORMANT_SOURCE', 'EXPECTED_BUSINESS_REJECTION',
              'CONFIGURATION_EXCEPTION', 'HISTORICAL_TEST_ARTIFACT', 'TRANSIENT_DATABASE_ERROR', 'UNCLASSIFIED_REJECTION'
            ))
          \`);
        }
        public async down(queryRunner) {}
      }`;
    const violations = scanForContraction([{ path: 'src/database/migrations/accounting/x.ts', source }]);
    expect(violations).toEqual([]);
  });

  it('does NOT flag a CHECK constraint dropped and redefined under the same name (v1.1.2 real case: attendance, plus unrelated additive DDL)', () => {
    const source = `
      export class AddBiometricDailySummaryImport1789730300000 {
        public async up(queryRunner) {
          await queryRunner.query(\`ALTER TABLE "attendance_raw_records" DROP CONSTRAINT "CHK_attendance_raw_records_sourceType"\`);
          await queryRunner.query(
            \`ALTER TABLE "attendance_raw_records" ADD CONSTRAINT "CHK_attendance_raw_records_sourceType" CHECK ("sourceType" IN ('manual', 'excel_import', 'api', 'biometric'))\`,
          );
          await queryRunner.query(\`CREATE TABLE "attendance_biometric_daily_facts" ("id" UUID PRIMARY KEY)\`);
        }
        public async down(queryRunner) {}
      }`;
    const violations = scanForContraction([{ path: 'src/database/migrations/attendance/x.ts', source }]);
    expect(violations).toEqual([]);
  });

  it('STILL flags a DROP CONSTRAINT with no same-name redefinition anywhere in up() (genuine removal)', () => {
    const source = `
      export class DropWithoutRedefine {
        public async up(queryRunner) {
          await queryRunner.query(\`ALTER TABLE "t" DROP CONSTRAINT "CHK_t_status"\`);
        }
        public async down(queryRunner) {}
      }`;
    const violations = scanForContraction([{ path: 'src/database/migrations/core/x.ts', source }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toContain('DROP CONSTRAINT');
  });

  it('STILL flags a DROP CONSTRAINT re-added under a DIFFERENT name (a rename — the old name is never restored)', () => {
    const source = `
      export class RenameConstraint {
        public async up(queryRunner) {
          await queryRunner.query(\`ALTER TABLE "t" DROP CONSTRAINT "CHK_t_old_name"\`);
          await queryRunner.query(\`ALTER TABLE "t" ADD CONSTRAINT "CHK_t_new_name" CHECK ("status" IN ('a','b'))\`);
        }
        public async down(queryRunner) {}
      }`;
    const violations = scanForContraction([{ path: 'src/database/migrations/core/x.ts', source }]);
    expect(violations).toHaveLength(1);
  });

  it('other contraction patterns (DROP COLUMN, DROP TABLE) are unaffected by this change', () => {
    const source = `
      export class DropColumnAndTable {
        public async up(queryRunner) {
          await queryRunner.query(\`ALTER TABLE "t" DROP COLUMN "old_col"\`);
          await queryRunner.query(\`DROP TABLE "legacy_table"\`);
        }
        public async down(queryRunner) {}
      }`;
    const violations = scanForContraction([{ path: 'src/database/migrations/core/x.ts', source }]);
    expect(violations.map((v) => v.rule)).toEqual([
      expect.stringContaining('DROP COLUMN'),
      expect.stringContaining('DROP TABLE'),
    ]);
  });
});
