import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-059 (HR Phase 1) — additive Employee aggregate expansion: manual
 * Employee<->User linkage (D2, nullable, one employee per user), a
 * reporting line (`managerId`, self-referential), employment type, and
 * termination evidence (D3 — date/reason captured directly, since
 * termination is a direct action, not routed through an approval request
 * that would otherwise carry this evidence). Also creates
 * `hr_employee_status_history` — every status transition is now recorded
 * (closing the "HrService never audits" gap the Phase 0 study found),
 * separate from the platform-wide `audit_records` table so the employee's
 * own history can be queried/displayed directly without joining audit.
 */
export class ExpandHrEmployeeAggregate1789710100000 implements MigrationInterface {
  name = 'ExpandHrEmployeeAggregate1789710100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hr_employees"
        ADD COLUMN "userId" UUID,
        ADD COLUMN "managerId" UUID,
        ADD COLUMN "employmentType" VARCHAR(16),
        ADD COLUMN "terminationDate" DATE,
        ADD COLUMN "terminationReason" TEXT
    `);
    await queryRunner.query(`CREATE INDEX "IDX_hr_employees_userId" ON "hr_employees" ("userId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_hr_employees_userId_unique" ON "hr_employees" ("userId") WHERE "userId" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_hr_employees_managerId" ON "hr_employees" ("managerId")`);

    await queryRunner.query(`
      CREATE TABLE "hr_employee_status_history" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employeeId" UUID NOT NULL,
        "fromStatus" VARCHAR(16) NOT NULL,
        "toStatus" VARCHAR(16) NOT NULL,
        "reason" TEXT,
        "changedByUserId" UUID NOT NULL,
        "changedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_hr_employee_status_history_employeeId" ON "hr_employee_status_history" ("employeeId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "hr_employee_status_history"`);
    await queryRunner.query(`ALTER TABLE "hr_employees"
      DROP COLUMN "userId",
      DROP COLUMN "managerId",
      DROP COLUMN "employmentType",
      DROP COLUMN "terminationDate",
      DROP COLUMN "terminationReason"`);
  }
}
