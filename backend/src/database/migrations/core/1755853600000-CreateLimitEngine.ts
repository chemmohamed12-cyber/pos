import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Limit Engine — ERP Foundation P5. `ERP_FOUNDATION_PHASE_PLAN.md`'s P5
 * section, `LIMIT_INTEGRATION_CONTRACT.md` §2.
 *
 * migration_tag intent: `core` (ADR-025) — same as
 * `CreateConfigurationEngine`/`CreateEntitlement`; relocated to
 * `src/database/migrations/core/` when P6's per-module partitioning
 * runner lands, content-preserving, no re-timestamp.
 *
 * Creates `limit_profiles` (the configured cap per key — row absence
 * means unlimited, fail-open) and `limit_usage_counters` (live usage,
 * one row per key for a flat limit, one row per calendar period for a
 * windowed one). NO data seed here — `LimitRegistrySeeder` seeds
 * `limit_profiles` from manifest defaults at boot, same division of
 * responsibility as `config_keys`/`ConfigRegistrySeeder`. Grants `admin`
 * 'editable' at `core.limit` so `core.limit.view`/`core.limit.edit`
 * resolve via the Permission Engine's ancestor-chain walk — same pattern
 * as `core.config`.
 */
export class CreateLimitEngine1755853600000 implements MigrationInterface {
  name = 'CreateLimitEngine1755853600000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['perm.core.limit', 'permission', 'حدود الاستخدام', 'Usage Limits'],
    ['action.limit_set', 'action', 'تعديل حد', 'Set Limit'],
    ['action.limit_clear', 'action', 'إزالة حد', 'Clear Limit'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "limit_profiles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "limitKey" VARCHAR(160) NOT NULL,
        "moduleCode" VARCHAR(32) NOT NULL,
        "unit" VARCHAR(16) NOT NULL,
        "maxValue" INT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_limit_profiles_key" ON "limit_profiles" ("limitKey")`);

    await queryRunner.query(`
      CREATE TABLE "limit_usage_counters" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "limitKey" VARCHAR(160) NOT NULL,
        "periodStart" TIMESTAMPTZ NULL,
        "currentValue" INT NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_limit_usage_counters_key_period" ON "limit_usage_counters" ("limitKey", "periodStart")`,
    );

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
      SELECT "id", 'core.limit', 'editable' FROM "roles" WHERE "key" = 'admin'
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
      `DELETE FROM "role_permissions" WHERE "nodeKey" = 'core.limit' AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
    );
    await queryRunner.query(`DROP TABLE "limit_usage_counters"`);
    await queryRunner.query(`DROP TABLE "limit_profiles"`);
  }
}
