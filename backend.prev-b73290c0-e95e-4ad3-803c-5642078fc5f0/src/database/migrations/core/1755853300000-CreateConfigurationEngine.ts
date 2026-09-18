import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runtime Configuration Engine — ERP Foundation P2.
 * planning/erp-foundation/P2_BLUEPRINT.md §2.3.
 *
 * migration_tag intent: `core` (ADR-025). This file is relocated to
 * `src/database/migrations/core/` when the per-module partitioning runner
 * lands in P6 — a content-preserving move, no re-timestamp (ADR-025 §8).
 *
 * Creates `config_keys` (the registry — rebuilt from code on every boot by
 * ConfigRegistrySeeder, so NO data seed here) and `config_values` (the only
 * user-writable table). Grants `admin` 'editable' at the `core.config`
 * permission node so `core.config.view` / `core.config.edit` resolve via the
 * Permission Engine's ancestor-chain walk — same pattern as `system.release`.
 */
export class CreateConfigurationEngine1755853300000 implements MigrationInterface {
  name = 'CreateConfigurationEngine1755853300000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['perm.core.config', 'permission', 'إعدادات النظام', 'System Configuration'],
    ['action.config_set', 'action', 'تعديل إعداد', 'Change Setting'],
    ['action.config_clear', 'action', 'إزالة إعداد', 'Clear Setting'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "config_keys" (
        "key" VARCHAR(160) PRIMARY KEY,
        "ownerModule" VARCHAR(32) NOT NULL,
        "valueType" VARCHAR(16) NOT NULL,
        "allowed" JSONB NULL,
        "defaultValue" TEXT NOT NULL,
        "scopeLevels" JSONB NOT NULL,
        "platformLocked" BOOLEAN NOT NULL DEFAULT false,
        "securitySensitive" BOOLEAN NOT NULL DEFAULT false,
        "isFeatureFlag" BOOLEAN NOT NULL DEFAULT false,
        "titleCode" VARCHAR(128) NOT NULL,
        "description" TEXT NULL,
        "flagOwner" VARCHAR(128) NULL,
        "flagRemoveBy" DATE NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "config_values" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" VARCHAR(160) NOT NULL,
        "scopeType" VARCHAR(16) NOT NULL,
        "scopeId" VARCHAR(128) NULL,
        "value" TEXT NOT NULL,
        "setByUserId" UUID NULL,
        "setAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "archivedAt" TIMESTAMPTZ NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_config_values_key_active" ON "config_values" ("key") WHERE "archivedAt" IS NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_config_values_scope" ON "config_values" ("scopeType", "scopeId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_config_values_key_scope" ON "config_values" ("key", "scopeType", "scopeId") WHERE "archivedAt" IS NULL`,
    );

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
      SELECT "id", 'core.config', 'editable' FROM "roles" WHERE "key" = 'admin'
      ON CONFLICT DO NOTHING
    `);

    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
    await queryRunner.query(
      `DELETE FROM "role_permissions" WHERE "nodeKey" = 'core.config' AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
    );
    await queryRunner.query(`DROP TABLE "config_values"`);
    await queryRunner.query(`DROP TABLE "config_keys"`);
  }
}
