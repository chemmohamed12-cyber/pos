import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-059 (HR Phase 1) — the first HR workflow to use the existing FA-01
 * engine (`ApprovalEngineService`), no new approval mechanism. `status`
 * carries only the two values HR itself ever sets directly
 * (`submitted` on creation, `approved` when the linked `approvalRequestId`
 * is approved) — a rejection is never mirrored here; the linked approval
 * request's own state is authoritative for "rejected," exactly matching
 * this codebase's existing convention (no domain subscribes to
 * `approval.request.rejected` anywhere — confirmed by repo-wide search).
 */
export class CreateHrLeaveRequests1789710200000 implements MigrationInterface {
  name = 'CreateHrLeaveRequests1789710200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "hr_leave_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "employeeId" UUID NOT NULL,
        "leaveType" VARCHAR(32) NOT NULL,
        "startDate" DATE NOT NULL,
        "endDate" DATE NOT NULL,
        "reason" TEXT,
        "status" VARCHAR(16) NOT NULL DEFAULT 'submitted',
        "approvalRequestId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "decidedAt" TIMESTAMPTZ,
        CONSTRAINT "CHK_hr_leave_requests_status" CHECK ("status" IN ('submitted', 'approved'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_hr_leave_requests_employeeId" ON "hr_leave_requests" ("employeeId")`);
    await queryRunner.query(`CREATE INDEX "IDX_hr_leave_requests_approvalRequestId" ON "hr_leave_requests" ("approvalRequestId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "hr_leave_requests"`);
  }
}
