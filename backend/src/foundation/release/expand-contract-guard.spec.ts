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

/**
 * 2026-10-09 false-positive found by the first production-path rehearsal on a copy of daii_dev: the F2 (`1790003000000-MembershipLifecycleAndInvitations`) and
 * F3 (`1790005000000-RoleMetadataAndRolesManageNode`) migrations add several columns in ONE `ALTER TABLE`, every required column carrying its own DEFAULT — fully
 * expand-safe — yet the guard refused them, because its regex looked for the DEFAULT only on the same line as the `ADD` it started from and let the match run on
 * into a later column's NOT NULL. The rule is now judged per column definition. The first two cases below are those migrations' ORIGINAL statements, verbatim.
 */
describe('scanForContraction — ADD COLUMN NOT NULL is judged per column, not per line', () => {
  const scan = (sql: string) =>
    scanForContraction([{ path: 'src/database/migrations/core/x.ts', source: `export class X { async up(q) { await q.query(\`${sql}\`); } async down(q) {} }` }]);

  it('does NOT flag the original F2 statement (required columns with DEFAULT, optional columns interleaved)', () => {
    expect(
      scan(`
        DO $$ BEGIN
          ALTER TABLE "user_company_memberships"
            ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'active',
            ADD COLUMN "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN "invitedBy" UUID NULL,
            ADD COLUMN "lastAccessAt" TIMESTAMPTZ NULL,
            ADD COLUMN "authzVersion" INTEGER NOT NULL DEFAULT 1;
        END $$;`),
    ).toEqual([]);
  });

  it('does NOT flag the original F3 statement (twelve columns, three required, each with DEFAULT)', () => {
    expect(
      scan(`
        ALTER TABLE "roles"
          ADD COLUMN "type" VARCHAR(16) NOT NULL DEFAULT 'custom',
          ADD COLUMN "templateKey" VARCHAR(64) NULL,
          ADD COLUMN "templateVersion" INTEGER NULL,
          ADD COLUMN "templateIgnoredVersion" INTEGER NULL,
          ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
          ADD COLUMN "customized" BOOLEAN NULL,
          ADD COLUMN "nameAr" VARCHAR(120) NULL,
          ADD COLUMN "nameEn" VARCHAR(120) NULL,
          ADD COLUMN "descriptionAr" TEXT NULL,
          ADD COLUMN "descriptionEn" TEXT NULL,
          ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          ADD COLUMN "createdBy" UUID NULL;`),
    ).toEqual([]);
  });

  it('the verdict no longer depends on column ORDER or on where the DEFAULT sits (same columns, reordered and DEFAULT on the next line)', () => {
    expect(scan(`ALTER TABLE "t" ADD COLUMN "a" INTEGER NULL, ADD COLUMN "b" INTEGER NOT NULL DEFAULT 1;`)).toEqual([]);
    expect(scan(`ALTER TABLE "t" ADD COLUMN "b" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "a" INTEGER NULL;`)).toEqual([]);
    expect(scan(`ALTER TABLE "t"\n  ADD COLUMN "b" INTEGER NOT NULL\n    DEFAULT 1;`)).toEqual([]);
  });

  it('commas inside parentheses or quotes do not split a column definition (DEFAULT coalesce(x, 1), DEFAULT \'a,b\', NUMERIC(10,2))', () => {
    expect(scan(`ALTER TABLE "t" ADD COLUMN "a" NUMERIC(10,2) NOT NULL DEFAULT coalesce(0, 1), ADD COLUMN "b" TEXT NOT NULL DEFAULT 'a,b';`)).toEqual([]);
  });

  it('STILL flags a plain required column with no DEFAULT (with or without the COLUMN keyword)', () => {
    expect(scan(`ALTER TABLE "t" ADD COLUMN "x" INTEGER NOT NULL;`)).toHaveLength(1);
    expect(scan(`ALTER TABLE "t" ADD "x" INTEGER NOT NULL;`)).toHaveLength(1);
  });

  it('STILL flags the required column that lacks a DEFAULT inside a multi-column statement — wherever it sits', () => {
    expect(scan(`ALTER TABLE "t"\n  ADD COLUMN "a" INTEGER NULL,\n  ADD COLUMN "b" INTEGER NOT NULL;`)).toHaveLength(1);
    expect(scan(`ALTER TABLE "t"\n  ADD COLUMN "a" INTEGER NOT NULL,\n  ADD COLUMN "b" INTEGER NOT NULL DEFAULT 1;`)).toHaveLength(1);
  });

  it('STILL flags a required column whose DEFAULT belongs to a DIFFERENT column on the same line (the old regex let this one through)', () => {
    expect(scan(`ALTER TABLE "t" ADD COLUMN "a" INTEGER NOT NULL, ADD COLUMN "b" INTEGER DEFAULT 1;`)).toHaveLength(1);
  });

  it('does not mistake constraints or IF NOT EXISTS for required columns', () => {
    expect(scan(`ALTER TABLE "t" ADD CONSTRAINT "chk" CHECK ("a" IS NOT NULL);`)).toEqual([]);
    expect(scan(`ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" JSONB NULL;`)).toEqual([]);
    expect(scan(`ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "x" JSONB NOT NULL DEFAULT '[]';`)).toEqual([]);
  });
});
