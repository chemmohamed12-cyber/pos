import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F4 / AZ-13 (Hybrid ownership, CTO 2026-10-07) — the PLATFORM-owned half: the Integration Catalog (provider definitions, versions, global
 * availability, optional package/module gating). Company-owned data (connections, credential references, mappings, activation, webhooks, sync state, logs) never
 * lives here. Additive and idempotent; the table is only populated on the control plane (by the platform seeder), so it is inert on Company databases.
 */
export class IntegrationProviderCatalog1790008000000 implements MigrationInterface {
  name = 'IntegrationProviderCatalog1790008000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_providers" (
        "code" VARCHAR(64) PRIMARY KEY,
        "nameEn" VARCHAR(120) NOT NULL,
        "nameAr" VARCHAR(120) NOT NULL,
        "descriptionEn" TEXT NULL,
        "descriptionAr" TEXT NULL,
        "version" VARCHAR(32) NOT NULL DEFAULT '1',
        "status" VARCHAR(16) NOT NULL DEFAULT 'available',
        "requiresModule" VARCHAR(64) NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_integration_providers_status" CHECK ("status" IN ('available','disabled'))
      )
    `);
  }

  public async down(): Promise<void> {
    // Additive-only: the catalog is configuration data; dropping it would lose platform decisions.
  }
}
