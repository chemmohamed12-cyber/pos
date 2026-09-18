import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release Center — Controlled Data Repair. `data_repair_runs` records one
 * repair operation end to end (audit → mapping → verified-backup link →
 * repair → integrity verification) as a single self-documenting evidence
 * row — the CTO's "keep the pre-repair backup + repair report + mapping as
 * Release Evidence" requirement, made into a table rather than loose files.
 *
 * No new permission-grant row: `AddReleaseRestoreTable` /
 * `AddReleasesTable` already granted `admin` 'editable' at the parent
 * `system.release` node, which the Permission Engine's ancestor-chain walk
 * extends to every `system.release.*` leaf — the data-repair routes reuse
 * `system.release.restore` (mutations) and `system.release.view` (reads).
 *
 * This is an ordinary additive schema migration (new table + index only) —
 * distinct from the deferred `RepairNonCompliantUuids` DATA migration,
 * which stays deferred and is driven through this table by
 * `DataRepairService`.
 */
export class AddDataRepairRunTable1755853200000 implements MigrationInterface {
  name = 'AddDataRepairRunTable1755853200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "data_repair_runs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "kind" VARCHAR(32) NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "backupRunId" UUID NULL REFERENCES "backup_runs"("id"),
        "auditResult" JSONB NULL,
        "mapping" JSONB NULL,
        "rowsRepaired" INTEGER NULL,
        "integrityResult" JSONB NULL,
        "initiatedByUserId" UUID NULL,
        "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMPTZ NULL,
        "errorMessage" TEXT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_data_repair_runs_backupRunId" ON "data_repair_runs" ("backupRunId")`);
    await queryRunner.query(`CREATE INDEX "IDX_data_repair_runs_startedAt" ON "data_repair_runs" ("startedAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "data_repair_runs"`);
  }
}
