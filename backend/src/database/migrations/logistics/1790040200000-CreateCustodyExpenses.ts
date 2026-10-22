import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle Driver Workspace, Stage C / C3 (2026-10-22; D-4, D-5 approved by the CTO) - additive: `custody_expenses`, the driver's claim for money spent out of the cash he is carrying
 * (fuel, tolls, ...). The row is a claim + its approval/posting trail; it is NOT a ledger: the money moves only through the existing Treasury cash-out when the expense is posted,
 * after a SEPARATE approver (FA-01 maker-checker) approved it. The category is a reason code of the company's disbursement posting profile - no GL account lives here.
 * `down` drops the table (the claim history is lost - forward-fix once it is in use).
 */
export class CreateCustodyExpenses1790040200000 implements MigrationInterface {
  name = 'CreateCustodyExpenses1790040200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "custody_expenses" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "expenseNumber" VARCHAR(32) NOT NULL,
        "custodyId" UUID NOT NULL,
        "shipmentId" VARCHAR(255) NOT NULL,
        "vehicleId" UUID,
        "custodyAccountId" UUID NOT NULL,
        "category" VARCHAR(64) NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "reason" VARCHAR(255) NOT NULL,
        "incurredOn" DATE NOT NULL,
        "evidenceAssetId" UUID,
        "status" VARCHAR(24) NOT NULL DEFAULT 'pending_approval',
        "claimedByUserId" UUID NOT NULL,
        "clientKey" VARCHAR(64),
        "approvalRequestId" UUID,
        "decidedByUserId" UUID,
        "decidedAt" TIMESTAMPTZ,
        "decisionNote" VARCHAR(255),
        "postedByUserId" UUID,
        "postedAt" TIMESTAMPTZ,
        "treasuryTransactionId" UUID,
        "cancelReason" VARCHAR(255),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_custody_expenses_status" CHECK ("status" IN ('pending_approval','approved','rejected','posted','cancelled')),
        CONSTRAINT "CHK_custody_expenses_amount" CHECK ("amount" > 0)
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custody_expenses_number" ON "custody_expenses" ("expenseNumber")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custody_expenses_client_key" ON "custody_expenses" ("clientKey") WHERE "clientKey" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_custody_expenses_custody" ON "custody_expenses" ("custodyId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_custody_expenses_shipment" ON "custody_expenses" ("shipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_custody_expenses_vehicle" ON "custody_expenses" ("vehicleId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_custody_expenses_approval" ON "custody_expenses" ("approvalRequestId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "custody_expenses"`);
  }
}
