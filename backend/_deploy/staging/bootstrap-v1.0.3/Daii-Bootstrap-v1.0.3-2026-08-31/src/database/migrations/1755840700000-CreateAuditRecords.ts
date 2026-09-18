import { MigrationInterface, QueryRunner } from 'typeorm';

/** Audit Engine — Stage 2 build-order item 11. Append-only ledger, no UPDATE/DELETE in application code. */
export class CreateAuditRecords1755840700000 implements MigrationInterface {
  name = 'CreateAuditRecords1755840700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_records" (
        "seq" SERIAL PRIMARY KEY,
        "timestamp" TIMESTAMPTZ NOT NULL,
        "actorUserId" UUID,
        "organizationId" UUID,
        "action" VARCHAR(128) NOT NULL,
        "resource" VARCHAR(128) NOT NULL,
        "resourceId" VARCHAR(255),
        "result" VARCHAR(16) NOT NULL,
        "correlationId" VARCHAR(64),
        "before" JSONB,
        "after" JSONB,
        "prevHash" VARCHAR(64) NOT NULL,
        "hash" VARCHAR(64) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_audit_records_actorUserId" ON "audit_records" ("actorUserId")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_records_resource" ON "audit_records" ("resource", "resourceId")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_records_correlationId" ON "audit_records" ("correlationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_records"`);
  }
}
