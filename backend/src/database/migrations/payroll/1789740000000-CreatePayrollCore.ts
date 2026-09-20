import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-070 (Payroll Phase 1) — the core data model in one migration,
 * entirely additive. `payroll` is promoted out of `RESERVED_MODULE_CODES`
 * (`module-manifest.type.ts`, ADR-070 §2) — the same mechanism
 * `hr`/`accounting`/`procurement`/`manufacturing` already went through.
 * No `financialEventId` column on `payroll_runs` — reconciliation joins
 * `accounting_financial_events.sourceEntityId` back to `payroll_runs.id`
 * instead (`ADR-070 §4`'s own correction, no forward reference stored).
 */
export class CreatePayrollCore1789740000000 implements MigrationInterface {
  name = 'CreatePayrollCore1789740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "payroll_periods" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "startDate" DATE NOT NULL,
        "endDate" DATE NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'open',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payroll_periods_status" CHECK ("status" IN ('open', 'closed'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_periods_code" ON "payroll_periods" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "payroll_compensations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employeeId" UUID NOT NULL,
        "effectiveFrom" TIMESTAMPTZ NOT NULL,
        "effectiveTo" TIMESTAMPTZ,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payroll_compensations_status" CHECK ("status" IN ('active', 'superseded'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_compensations_employeeId" ON "payroll_compensations" ("employeeId")`);
    // ADR-070 §4 — "exactly one ACTIVE compensation row per employee at a time," the same
    // partial-unique-index pattern `attendance_employee_mappings` already uses (ADR-062 §5).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payroll_compensations_active_employee" ON "payroll_compensations" ("employeeId") WHERE "effectiveTo" IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "payroll_earning_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "compensationId" UUID NOT NULL,
        "componentCode" VARCHAR(32) NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_earning_lines_compensationId" ON "payroll_earning_lines" ("compensationId")`);

    await queryRunner.query(`
      CREATE TABLE "payroll_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "payrollPeriodId" UUID NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
        "approvalRequestId" UUID,
        "createdByUserId" UUID NOT NULL,
        "calculatedAt" TIMESTAMPTZ,
        "reviewedByUserId" UUID,
        "reviewedAt" TIMESTAMPTZ,
        "approvedAt" TIMESTAMPTZ,
        "postedAt" TIMESTAMPTZ,
        "disbursedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payroll_runs_status" CHECK ("status" IN ('draft', 'calculated', 'reviewed', 'approved', 'posted'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_runs_code" ON "payroll_runs" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_runs_payrollPeriodId" ON "payroll_runs" ("payrollPeriodId")`);
    // ADR-070 §6 — "no two PayrollRuns for the same PayrollPeriod without an explicit
    // superseding rule." Phase 1 scope is company-wide (one populationScope), so this reduces to:
    // at most one non-superseded run per period. A prior run must be explicitly recalculated
    // (ADR-070 §18) — modeled by simply not allowing a second row per period, full stop, in Phase 1.
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_runs_period" ON "payroll_runs" ("payrollPeriodId")`);

    await queryRunner.query(`
      CREATE TABLE "payroll_run_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "payrollRunId" UUID NOT NULL,
        "employeeId" UUID NOT NULL,
        "compensationSnapshot" JSONB NOT NULL,
        "grossPay" NUMERIC(14,2) NOT NULL,
        "totalDeductions" NUMERIC(14,2) NOT NULL DEFAULT 0,
        "netPay" NUMERIC(14,2) NOT NULL,
        "commissionAmount" NUMERIC(14,2),
        "overtimeAmount" NUMERIC(14,2),
        "calculationTimestamp" TIMESTAMPTZ NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_run_lines_payrollRunId" ON "payroll_run_lines" ("payrollRunId")`);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_run_lines_employeeId" ON "payroll_run_lines" ("employeeId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_payroll_run_lines_run_employee" ON "payroll_run_lines" ("payrollRunId", "employeeId")`);

    await queryRunner.query(`
      CREATE TABLE "payroll_attendance_day_classifications" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "payrollRunLineId" UUID NOT NULL,
        "calendarDate" DATE NOT NULL,
        "attendanceStatus" VARCHAR(16) NOT NULL,
        "dayType" VARCHAR(16) NOT NULL,
        "payImpact" VARCHAR(16) NOT NULL,
        CONSTRAINT "CHK_payroll_day_class_dayType" CHECK ("dayType" IN ('working', 'weekend', 'holiday', 'approved_leave', 'unclassified')),
        CONSTRAINT "CHK_payroll_day_class_payImpact" CHECK ("payImpact" IN ('none', 'deduction', 'leave'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_day_class_payrollRunLineId" ON "payroll_attendance_day_classifications" ("payrollRunLineId")`);

    await queryRunner.query(`
      CREATE TABLE "payroll_deduction_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "payrollRunLineId" UUID NOT NULL,
        "category" VARCHAR(16) NOT NULL,
        "type" VARCHAR(32) NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "sourceReference" UUID,
        CONSTRAINT "CHK_payroll_deduction_category" CHECK ("category" IN ('system_derived', 'approved_external'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_deduction_lines_payrollRunLineId" ON "payroll_deduction_lines" ("payrollRunLineId")`);

    await queryRunner.query(`
      CREATE TABLE "payroll_adjustments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "originalPayrollRunLineId" UUID NOT NULL,
        "kind" VARCHAR(16) NOT NULL,
        "reason" TEXT NOT NULL,
        "amountDelta" NUMERIC(14,2) NOT NULL,
        "createdByUserId" UUID NOT NULL,
        "approvalRequestId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_payroll_adjustments_kind" CHECK ("kind" IN ('adjustment', 'correction', 'recalculation'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_payroll_adjustments_originalPayrollRunLineId" ON "payroll_adjustments" ("originalPayrollRunLineId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payroll_adjustments"`);
    await queryRunner.query(`DROP TABLE "payroll_deduction_lines"`);
    await queryRunner.query(`DROP TABLE "payroll_attendance_day_classifications"`);
    await queryRunner.query(`DROP TABLE "payroll_run_lines"`);
    await queryRunner.query(`DROP TABLE "payroll_runs"`);
    await queryRunner.query(`DROP TABLE "payroll_earning_lines"`);
    await queryRunner.query(`DROP TABLE "payroll_compensations"`);
    await queryRunner.query(`DROP TABLE "payroll_periods"`);
  }
}
