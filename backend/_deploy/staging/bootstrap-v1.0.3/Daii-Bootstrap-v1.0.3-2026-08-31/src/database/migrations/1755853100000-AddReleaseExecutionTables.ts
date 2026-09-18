import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release Center — Execution Layer. `release_migration_runs` gives
 * per-migration traceability for a deploy (name, start/end, success,
 * error), tied to the specific `releaseId` that ran it — `rollbackRelease`
 * reads these rows (in reverse) to know exactly which migrations to
 * attempt `undoLastMigration()` against. No new permission-grant row is
 * needed: the Phase B migration already granted `admin` 'editable' at the
 * parent `system.release` node, which covers `system.release.deploy` and
 * `system.release.rollback` (used by every route this table backs) via
 * the Permission Engine's ancestor-chain walk. Also fills in the
 * `release_status` terminology entries Phase C's own migration didn't
 * reach yet (`'deploying'` onward — that phase never got that far).
 */
export class AddReleaseExecutionTables1755853100000 implements MigrationInterface {
  name = 'AddReleaseExecutionTables1755853100000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['release_status.deploying', 'release_status', 'جارٍ النشر', 'Deploying'],
    ['release_status.migrating', 'release_status', 'جارٍ تنفيذ الترحيلات', 'Migrating'],
    ['release_status.health_checking', 'release_status', 'فحص الجاهزية', 'Health Checking'],
    ['release_status.succeeded', 'release_status', 'تم بنجاح', 'Succeeded'],
    ['release_status.failed', 'release_status', 'فشل', 'Failed'],
    ['release_status.rolled_back', 'release_status', 'تم التراجع', 'Rolled Back'],
    ['field.migration_name', 'field', 'اسم الترحيل', 'Migration Name'],
    ['action.deploy_release', 'action', 'نشر الإصدار', 'Deploy Release'],
    ['action.rollback_release', 'action', 'التراجع عن الإصدار', 'Rollback Release'],
    ['field.current_version', 'field', 'الإصدار الحالي', 'Current Version'],
    ['field.uploaded_at', 'field', 'تاريخ الرفع', 'Uploaded At'],
    ['field.backup', 'field', 'النسخة الاحتياطية', 'Backup'],
    ['action.upload_release', 'action', 'رفع إصدار جديد', 'Upload Release'],
    ['action.select_backup', 'action', 'اختيار نسخة احتياطية', 'Select Backup'],
    ['action.view_migrations', 'action', 'عرض الترحيلات', 'View Migrations'],
    ['panel.no_releases_yet', 'panel', 'لا توجد إصدارات حتى الآن', 'No releases yet'],
    ['panel.no_backups_yet', 'panel', 'لا توجد نسخ احتياطية حتى الآن', 'No backups yet'],
    ['field.migrations', 'field', 'الترحيلات', 'Migrations'],
    ['field.error', 'field', 'الخطأ', 'Error'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "release_migration_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "releaseId" UUID NOT NULL REFERENCES "releases"("id"),
        "migrationName" VARCHAR(255) NOT NULL,
        "startedAt" TIMESTAMPTZ NOT NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "success" BOOLEAN NOT NULL DEFAULT false,
        "errorMessage" TEXT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_release_migration_runs_releaseId" ON "release_migration_runs" ("releaseId")`);

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
    await queryRunner.query(`DROP TABLE "release_migration_runs"`);
  }
}
