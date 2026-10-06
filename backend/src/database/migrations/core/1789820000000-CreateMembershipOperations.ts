import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Company Membership HTTP Management (2026-09-24, D5). Platform-DB
 * durable operation ledger for grant/revoke/role-change against a
 * Company's own database — see `membership-operation.entity.ts`'s doc
 * comment for the full rationale (no distributed transaction across the
 * two databases; this table plus `MembershipReconciliationScheduler` is
 * the decided substitute).
 */
export class CreateMembershipOperations1789820000000 implements MigrationInterface {
  name = 'CreateMembershipOperations1789820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "membership_operations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "companyId" UUID NOT NULL,
        "operationType" VARCHAR(16) NOT NULL,
        "previousRoleKey" VARCHAR(64),
        "targetRoleKey" VARCHAR(64),
        "status" VARCHAR(16) NOT NULL,
        "attempts" INT NOT NULL DEFAULT 0,
        "lastError" TEXT,
        "correlationId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_membership_operations_userId" ON "membership_operations" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_membership_operations_companyId" ON "membership_operations" ("companyId")`);
    await queryRunner.query(`CREATE INDEX "IDX_membership_operations_status" ON "membership_operations" ("status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_membership_operations_correlationId" ON "membership_operations" ("correlationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "membership_operations"`);
  }
}
