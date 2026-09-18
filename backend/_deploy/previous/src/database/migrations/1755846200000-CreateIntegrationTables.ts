import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * External Integrations (Control Center) — CTO handover directive "Daii
 * <-> QR Store Integration & Pairing Architecture" §9. Reusable
 * foundation: connectors, their (separately-tabled, encrypted)
 * credentials, product mappings, and a sync log doubling as the
 * idempotency ledger for inbound events (§16).
 */
export class CreateIntegrationTables1755846200000 implements MigrationInterface {
  name = 'CreateIntegrationTables1755846200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "integration_connectors" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connectorType" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "config" JSONB NOT NULL DEFAULT '{}',
        "lastConnectedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_integration_connectors_connectorType" ON "integration_connectors" ("connectorType")`);

    await queryRunner.query(`
      CREATE TABLE "integration_credentials" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connectorId" UUID NOT NULL REFERENCES "integration_connectors"("id") ON DELETE CASCADE,
        "encryptedValue" TEXT NOT NULL,
        "revoked" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "revokedAt" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_integration_credentials_connectorId" ON "integration_credentials" ("connectorId")`);

    await queryRunner.query(`
      CREATE TABLE "integration_product_mappings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connectorId" UUID NOT NULL REFERENCES "integration_connectors"("id") ON DELETE CASCADE,
        "daiiProductId" UUID NOT NULL REFERENCES "products"("id"),
        "externalProductId" VARCHAR(128) NOT NULL,
        "lastSyncedAt" TIMESTAMPTZ,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_integration_product_mappings_connectorId" ON "integration_product_mappings" ("connectorId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_integration_product_mappings_connectorId_daiiProductId" ON "integration_product_mappings" ("connectorId", "daiiProductId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_integration_product_mappings_connectorId_externalProductId" ON "integration_product_mappings" ("connectorId", "externalProductId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "integration_sync_logs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "connectorId" UUID NOT NULL REFERENCES "integration_connectors"("id") ON DELETE CASCADE,
        "direction" VARCHAR(16) NOT NULL,
        "eventType" VARCHAR(64) NOT NULL,
        "externalReference" VARCHAR(128),
        "status" VARCHAR(16) NOT NULL,
        "detail" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_integration_sync_logs_connectorId" ON "integration_sync_logs" ("connectorId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_integration_sync_logs_connectorId_eventType_externalReference" ON "integration_sync_logs" ("connectorId", "eventType", "externalReference")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "integration_sync_logs"`);
    await queryRunner.query(`DROP TABLE "integration_product_mappings"`);
    await queryRunner.query(`DROP TABLE "integration_credentials"`);
    await queryRunner.query(`DROP TABLE "integration_connectors"`);
  }
}
