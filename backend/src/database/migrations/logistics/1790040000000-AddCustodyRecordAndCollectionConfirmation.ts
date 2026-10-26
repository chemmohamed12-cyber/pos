import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehicle Driver Workspace, Stage C / C1 (2026-10-22; D-2, D-3 approved by the CTO) - additive:
 *  1. `shipment_custodies`: the per-shipment custody record (number, vehicle, driver, copied free-text branch, expected amount). One per shipment that actually carries cash; created lazily
 *     by the first collection, never for every shipment. It holds no money: the money stays in the Treasury custody account and in the `collections` rows.
 *  2. `collections` gains the confirmation step (recorded -> confirmed | rejected, who/when/why), a client idempotency key and the link to the custody record. Existing rows are
 *     backfilled from FACTS only: a collection already `remitted` was posted by finance, so it is `confirmed`; every other existing row is `recorded` (the column default).
 * No amount, balance, journal or ledger entry is touched. `down` removes the new columns and the table (the confirmation history is lost - forward-fix once it is in use).
 */
export class AddCustodyRecordAndCollectionConfirmation1790040000000 implements MigrationInterface {
  name = 'AddCustodyRecordAndCollectionConfirmation1790040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shipment_custodies" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "custodyNumber" VARCHAR(32) NOT NULL,
        "shipmentId" VARCHAR(255) NOT NULL,
        "vehicleId" UUID,
        "driverUserId" UUID,
        "branch" VARCHAR(128),
        "expectedAmount" NUMERIC(14,2),
        "openedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shipment_custodies_number" ON "shipment_custodies" ("custodyNumber")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shipment_custodies_shipment" ON "shipment_custodies" ("shipmentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shipment_custodies_vehicle" ON "shipment_custodies" ("vehicleId")`);

    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "verificationStatus" VARCHAR(16) NOT NULL DEFAULT 'recorded'`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "confirmedByUserId" UUID`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMPTZ`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "rejectionReason" VARCHAR(255)`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "clientKey" VARCHAR(64)`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "custodyId" UUID`);
    await queryRunner.query(`UPDATE "collections" SET "verificationStatus" = 'confirmed', "confirmedAt" = "remittedAt" WHERE "remittanceStatus" = 'remitted' AND "verificationStatus" = 'recorded'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_collections_client_key" ON "collections" ("clientKey") WHERE "clientKey" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_collections_custody" ON "collections" ("custodyId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_collections_custody"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_collections_client_key"`);
    for (const c of ['custodyId', 'clientKey', 'rejectionReason', 'confirmedAt', 'confirmedByUserId', 'verificationStatus']) {
      await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN IF EXISTS "${c}"`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "shipment_custodies"`);
  }
}
