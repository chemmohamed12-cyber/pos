import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 3 freeze). Adds
 * `companyId` to the two existing platform-only tables (`backup_runs`,
 * `restore_operations` — null preserves their exact current meaning
 * unchanged), plus two new tables: `company_backup_settings` (D-Backup-02
 * per-Company retention override) and `backup_operations` (D-Backup-03
 * durable retry ledger, deliberately separate from `membership_operations`
 * — same principle, different domain).
 */
export class AddCompanyBackupSupport1789830000000 implements MigrationInterface {
  name = 'AddCompanyBackupSupport1789830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "backup_runs" ADD COLUMN "companyId" UUID REFERENCES "companies"("id")`);
    await queryRunner.query(`CREATE INDEX "IDX_backup_runs_companyId" ON "backup_runs" ("companyId")`);

    await queryRunner.query(`ALTER TABLE "restore_operations" ADD COLUMN "companyId" UUID REFERENCES "companies"("id")`);
    await queryRunner.query(`CREATE INDEX "IDX_restore_operations_companyId" ON "restore_operations" ("companyId")`);

    await queryRunner.query(`
      CREATE TABLE "company_backup_settings" (
        "companyId" UUID PRIMARY KEY REFERENCES "companies"("id"),
        "retentionDaysOverride" INT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "backup_operations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" UUID NULL REFERENCES "companies"("id"),
        "backupRunId" UUID NOT NULL REFERENCES "backup_runs"("id") ON DELETE CASCADE,
        "status" VARCHAR(16) NOT NULL,
        "attempts" INT NOT NULL DEFAULT 0,
        "lastError" TEXT NULL,
        "nextRetryAt" TIMESTAMPTZ NULL,
        "correlationId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_backup_operations_companyId" ON "backup_operations" ("companyId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_backup_operations_backupRunId" ON "backup_operations" ("backupRunId")`);
    await queryRunner.query(`CREATE INDEX "IDX_backup_operations_status" ON "backup_operations" ("status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_backup_operations_correlationId" ON "backup_operations" ("correlationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "backup_operations"`);
    await queryRunner.query(`DROP TABLE "company_backup_settings"`);
    await queryRunner.query(`ALTER TABLE "restore_operations" DROP COLUMN "companyId"`);
    await queryRunner.query(`ALTER TABLE "backup_runs" DROP COLUMN "companyId"`);
  }
}
