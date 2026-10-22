import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise Organizational Structure Engine — Stage 8. Append-only audit trail of every organizational reference the legacy reconciliation writes: which record,
 * which column, the value before (always NULL — only unassigned records are touched), the value after, the business relationship it was derived from, and who ran it.
 * Additive; nothing reads it except the reconciliation report.
 */
export class OrgMigrationLog1790021600000 implements MigrationInterface {
  name = 'OrgMigrationLog1790021600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "org_migration_log" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "runId" UUID NOT NULL,
        "tableName" VARCHAR(64) NOT NULL,
        "columnName" VARCHAR(64) NOT NULL,
        "recordId" UUID NOT NULL,
        "fromValue" UUID NULL,
        "toValue" UUID NOT NULL,
        "source" VARCHAR(128) NOT NULL,
        "actorUserId" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_org_migration_log" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_org_migration_log_run" ON "org_migration_log" ("runId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_org_migration_log_record" ON "org_migration_log" ("tableName", "recordId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "org_migration_log"`);
  }
}
