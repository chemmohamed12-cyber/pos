import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entitlement Engine — ERP Foundation P3. planning/erp-foundation/P3_BLUEPRINT.md §7.
 * migration_tag intent: `core` (ADR-025 — relocated to migrations/core/ in P6).
 *
 * Creates the single-row `installation` table + the Edition catalog, seeds
 * exactly one edition (DAII_STANDARD = all 5 module codes), and grants `admin`
 * 'editable' at `core.entitlement`. NO `installation` row is seeded — its
 * absence + ENTITLEMENT_MODE=unlicensed-full = the implicit full edition, so
 * the current product runs unchanged.
 */
export class CreateEntitlement1755853400000 implements MigrationInterface {
  name = 'CreateEntitlement1755853400000';

  private readonly modules = ['sales', 'inventory', 'logistics', 'finance', 'reporting'];
  private readonly terminology: Array<[string, string, string, string]> = [
    ['perm.core.entitlement', 'permission', 'استحقاق النسخة', 'Installation Entitlement'],
    ['edition.daii_standard', 'edition', 'ضى الإصدار القياسي', 'Daii Standard Edition'],
    ['action.entitlement_apply', 'action', 'تطبيق بيان استحقاق', 'Apply Entitlement Manifest'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "installation" (
        "id" VARCHAR(32) PRIMARY KEY DEFAULT 'installation',
        "installationId" VARCHAR(64) NOT NULL,
        "customerName" VARCHAR(255) NOT NULL,
        "editionCode" VARCHAR(32) NOT NULL,
        "editionVersion" VARCHAR(32) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "termStart" TIMESTAMPTZ NULL,
        "termEnd" TIMESTAMPTZ NULL,
        "graceDays" INT NOT NULL DEFAULT 0,
        "entitlementManifest" JSONB NOT NULL,
        "manifestSignature" VARCHAR(128) NULL,
        "manifestKid" VARCHAR(64) NULL,
        "issuedAt" TIMESTAMPTZ NULL,
        "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "lastTrustedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "verificationState" VARCHAR(16) NOT NULL DEFAULT 'unlicensed',
        CONSTRAINT "CHK_installation_singleton" CHECK ("id" = 'installation')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "editions" (
        "code" VARCHAR(32) PRIMARY KEY,
        "name" VARCHAR(128) NOT NULL,
        "latestVersion" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
        "status" VARCHAR(16) NOT NULL DEFAULT 'published'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "edition_modules" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "editionCode" VARCHAR(32) NOT NULL,
        "moduleCode" VARCHAR(32) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_edition_modules" ON "edition_modules" ("editionCode", "moduleCode")`);
    await queryRunner.query(`
      CREATE TABLE "edition_features" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "editionCode" VARCHAR(32) NOT NULL,
        "featureCode" VARCHAR(96) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_edition_features" ON "edition_features" ("editionCode", "featureCode")`);
    await queryRunner.query(`
      CREATE TABLE "edition_limits" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "editionCode" VARCHAR(32) NOT NULL,
        "limitKey" VARCHAR(96) NOT NULL,
        "value" BIGINT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_edition_limits" ON "edition_limits" ("editionCode", "limitKey")`);

    // seed DAII_STANDARD (the current product = all 5 modules)
    await queryRunner.query(`INSERT INTO "editions" ("code", "name") VALUES ('DAII_STANDARD', 'Daii Standard Edition')`);
    for (const m of this.modules) {
      await queryRunner.query(`INSERT INTO "edition_modules" ("editionCode", "moduleCode") VALUES ('DAII_STANDARD', $1)`, [m]);
    }

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
      SELECT "id", 'core.entitlement', 'editable' FROM "roles" WHERE "key" = 'admin'
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([c]) => c)]);
    await queryRunner.query(
      `DELETE FROM "role_permissions" WHERE "nodeKey" = 'core.entitlement' AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
    );
    await queryRunner.query(`DROP TABLE "edition_limits"`);
    await queryRunner.query(`DROP TABLE "edition_features"`);
    await queryRunner.query(`DROP TABLE "edition_modules"`);
    await queryRunner.query(`DROP TABLE "editions"`);
    await queryRunner.query(`DROP TABLE "installation"`);
  }
}
