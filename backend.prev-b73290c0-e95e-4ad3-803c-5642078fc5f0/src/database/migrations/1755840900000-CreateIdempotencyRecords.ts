import { MigrationInterface, QueryRunner } from 'typeorm';

/** Idempotency — Stage 2 build-order item 14. */
export class CreateIdempotencyRecords1755840900000 implements MigrationInterface {
  name = 'CreateIdempotencyRecords1755840900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "idempotency_records" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "scope" VARCHAR(255) NOT NULL,
        "key" VARCHAR(255) NOT NULL,
        "statusCode" INT NOT NULL,
        "responseBody" JSONB NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_idempotency_records_scope_key" ON "idempotency_records" ("scope", "key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "idempotency_records"`);
  }
}
