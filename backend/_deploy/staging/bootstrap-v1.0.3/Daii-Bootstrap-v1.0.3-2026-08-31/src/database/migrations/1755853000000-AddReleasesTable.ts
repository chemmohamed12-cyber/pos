import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release Center — Phase C (foundation slice: release/manifest tracking
 * + the mandatory-verified-backup deployment gate). See `Release` entity
 * and `ReleaseManagerService` doc comments for the full rationale.
 * `version` is unique — the same version string can never be registered
 * twice, closing off a real "did I already upload this" ambiguity before
 * it can happen. No new permission-grant row needed: the Phase B
 * migration already granted `admin` 'editable' at the parent
 * `system.release` node, which covers `system.release.deploy` (used by
 * every route this migration's table backs) via the Permission Engine's
 * ancestor-chain walk.
 */
export class AddReleasesTable1755853000000 implements MigrationInterface {
  name = 'AddReleasesTable1755853000000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.release_version', 'field', 'إصدار النسخة', 'Release Version'],
    ['field.package_type', 'field', 'نوع الحزمة', 'Package Type'],
    ['package_type.full', 'package_type', 'كاملة', 'Full'],
    ['package_type.delta', 'package_type', 'جزئية (دلتا)', 'Delta'],
    ['release_status.registered', 'release_status', 'مسجلة', 'Registered'],
    ['release_status.validated', 'release_status', 'تم التحقق', 'Validated'],
    ['release_status.validation_failed', 'release_status', 'فشل التحقق', 'Validation Failed'],
    ['release_status.backup_verified', 'release_status', 'النسخة الاحتياطية موثقة', 'Backup Verified'],
    ['action.register_release', 'action', 'تسجيل إصدار جديد', 'Register Release'],
    ['action.link_backup', 'action', 'ربط نسخة احتياطية', 'Link Backup'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "releases" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "version" VARCHAR(32) NOT NULL,
        "packageType" VARCHAR(8) NOT NULL,
        "baseVersion" VARCHAR(32) NULL,
        "manifest" JSONB NOT NULL,
        "manifestChecksum" VARCHAR(64) NOT NULL,
        "status" VARCHAR(24) NOT NULL,
        "uploadedByUserId" UUID NOT NULL,
        "uploadedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "backupRunId" UUID NULL REFERENCES "backup_runs"("id"),
        "completedAt" TIMESTAMPTZ NULL,
        "errorMessage" TEXT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_releases_version" ON "releases" ("version")`);

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
    await queryRunner.query(`DROP TABLE "releases"`);
  }
}
