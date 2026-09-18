import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release Center — Phase B (Restore). Creates `restore_operations` (see
 * `RestoreOperation` entity doc comment for the full preflight/confirm
 * rationale). Also widens the Permission Engine grant from the narrower
 * `system.release.backup` node (Phase A) to the PARENT `system.release`
 * node — the CTO directive's own permission list
 * (`system.release.view`/`deploy`/`rollback`, "وأي permissions إضافية
 * ضرورية بنفس النمط") implies several sibling action nodes under
 * `system.release`, and granting at the parent covers all of them (and
 * any future ones) via the Permission Engine's ancestor-chain walk,
 * without a new migration every time a leaf node is added. The narrower
 * Phase A row is left in place (harmless — same 'editable' result either
 * way for admin) rather than edited, per this project's own
 * never-edit-a-past-migration discipline.
 */
export class AddReleaseRestoreTable1755852900000 implements MigrationInterface {
  name = 'AddReleaseRestoreTable1755852900000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.restore_status', 'field', 'حالة الاستعادة', 'Restore Status'],
    ['restore_status.pending_confirmation', 'restore_status', 'بانتظار التأكيد', 'Pending Confirmation'],
    ['restore_status.expired', 'restore_status', 'منتهية الصلاحية', 'Expired'],
    ['restore_status.running', 'restore_status', 'جارٍ التنفيذ', 'Running'],
    ['restore_status.completed', 'restore_status', 'مكتملة', 'Completed'],
    ['restore_status.failed', 'restore_status', 'فشلت', 'Failed'],
    ['action.preflight_restore', 'action', 'فحص مبدئي قبل الاستعادة', 'Preflight Restore'],
    ['action.confirm_restore', 'action', 'تأكيد الاستعادة', 'Confirm Restore'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "restore_operations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "backupRunId" UUID NOT NULL REFERENCES "backup_runs"("id"),
        "status" VARCHAR(24) NOT NULL,
        "requestedByUserId" UUID NOT NULL,
        "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "preflightResult" JSONB NULL,
        "confirmedByUserId" UUID NULL,
        "confirmedAt" TIMESTAMPTZ NULL,
        "safetyBackupRunId" UUID NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "errorMessage" TEXT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_restore_operations_backupRunId" ON "restore_operations" ("backupRunId")`);

    await queryRunner.query(`
      INSERT INTO "role_permissions" ("roleId", "nodeKey", "access")
      SELECT "id", 'system.release', 'editable' FROM "roles" WHERE "key" = 'admin'
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
      `DELETE FROM "role_permissions" WHERE "nodeKey" = 'system.release' AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'admin')`,
    );
    await queryRunner.query(`DROP TABLE "restore_operations"`);
  }
}
