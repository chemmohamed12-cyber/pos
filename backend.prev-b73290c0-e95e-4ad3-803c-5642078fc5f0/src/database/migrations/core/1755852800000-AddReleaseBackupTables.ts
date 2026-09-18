import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release Center — Phase A (Backup Foundation). Creates `backup_runs` +
 * `backup_artifacts` (see `BackupRun`/`BackupArtifact` entity doc
 * comments for the full data model rationale), and seeds the one
 * `role_permissions` row the `admin` role needs to actually use
 * `ReleaseController` — the Permission Engine has NO admin auto-bypass
 * (confirmed by reading `permission.service.ts` directly: `resolve()` is
 * purely row-driven, no rows anywhere = 'hidden'), so without this row
 * every admin action in this controller would 404 immediately. Granting
 * at `system.release.backup` (not a narrower per-action node) covers
 * every current and future `system.release.backup.*` sub-node via the
 * Permission Engine's ancestor-chain walk, with zero further migration
 * needed if finer sub-nodes are introduced later.
 */
export class AddReleaseBackupTables1755852800000 implements MigrationInterface {
  name = 'AddReleaseBackupTables1755852800000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.release_center', 'nav', 'مركز الإصدارات', 'Release Center'],
    ['field.backup_status', 'field', 'حالة النسخة الاحتياطية', 'Backup Status'],
    ['field.backup_type', 'field', 'نوع النسخة الاحتياطية', 'Backup Type'],
    ['backup_type.database', 'backup_type', 'قاعدة البيانات', 'Database'],
    ['backup_type.media', 'backup_type', 'الملفات والوسائط', 'Media'],
    ['backup_run_status.running', 'backup_run_status', 'جارٍ', 'Running'],
    ['backup_run_status.completed', 'backup_run_status', 'مكتملة', 'Completed'],
    ['backup_run_status.failed', 'backup_run_status', 'فشلت', 'Failed'],
    ['backup_run_status.partially_failed', 'backup_run_status', 'مكتملة جزئيًا', 'Partially Failed'],
    ['backup_artifact_status.verified', 'backup_artifact_status', 'تم التحقق', 'Verified'],
    ['backup_artifact_status.verification_failed', 'backup_artifact_status', 'فشل التحقق', 'Verification Failed'],
    ['action.create_backup', 'action', 'إنشاء نسخة احتياطية', 'Create Backup'],
    ['action.verify_backup', 'action', 'إعادة التحقق', 'Re-verify'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "backup_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "trigger" VARCHAR(16) NOT NULL,
        "initiatedByUserId" UUID NULL,
        "status" VARCHAR(16) NOT NULL,
        "sourceAppVersion" VARCHAR(32) NOT NULL,
        "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMPTZ NULL,
        "errorMessage" TEXT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_backup_runs_completedAt" ON "backup_runs" ("completedAt")`);

    await queryRunner.query(`
      CREATE TABLE "backup_artifacts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "backupRunId" UUID NOT NULL REFERENCES "backup_runs"("id") ON DELETE CASCADE,
        "type" VARCHAR(16) NOT NULL,
        "filePath" VARCHAR(512) NOT NULL,
        "sizeBytes" BIGINT NOT NULL,
        "checksumSha256" VARCHAR(64) NOT NULL,
        "status" VARCHAR(24) NOT NULL,
        "verifiedAt" TIMESTAMPTZ NULL,
        "errorMessage" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_backup_artifacts_backupRunId" ON "backup_artifacts" ("backupRunId")`);

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
      SELECT "id", 'system.release.backup', 'editable' FROM "roles" WHERE "key" = 'admin'
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
      `DELETE FROM "role_permissions" WHERE "nodeKey" = 'system.release.backup' AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
    );
    await queryRunner.query(`DROP TABLE "backup_artifacts"`);
    await queryRunner.query(`DROP TABLE "backup_runs"`);
  }
}
