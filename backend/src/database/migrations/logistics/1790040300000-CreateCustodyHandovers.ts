import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle Driver Workspace, Stage C / C4 (2026-10-22) - additive: `custody_handovers`, the driver's declaration that he handed an amount of cash to the cashier, and the cashier's
 * confirmation (a different person). It is an operational record only: the money movement from the custody account to the settlement account and the receivable credit stay with the
 * existing remittance of each collection. `down` drops the table (the handover history is lost - forward-fix once it is in use).
 */
export class CreateCustodyHandovers1790040300000 implements MigrationInterface {
  name = 'CreateCustodyHandovers1790040300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "custody_handovers" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "handoverNumber" VARCHAR(32) NOT NULL,
        "vehicleId" UUID NOT NULL,
        "driverUserId" UUID NOT NULL,
        "amount" NUMERIC(14,2) NOT NULL,
        "note" VARCHAR(255),
        "status" VARCHAR(16) NOT NULL DEFAULT 'declared',
        "clientKey" VARCHAR(64),
        "confirmedByUserId" UUID,
        "decidedAt" TIMESTAMPTZ,
        "rejectionReason" VARCHAR(255),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_custody_handovers_status" CHECK ("status" IN ('declared','confirmed','rejected')),
        CONSTRAINT "CHK_custody_handovers_amount" CHECK ("amount" > 0)
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custody_handovers_number" ON "custody_handovers" ("handoverNumber")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custody_handovers_client_key" ON "custody_handovers" ("clientKey") WHERE "clientKey" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_custody_handovers_vehicle" ON "custody_handovers" ("vehicleId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "custody_handovers"`);
  }
}
