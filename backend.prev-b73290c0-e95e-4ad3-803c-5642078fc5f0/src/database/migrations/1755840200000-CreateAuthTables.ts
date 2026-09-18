import { MigrationInterface, QueryRunner } from 'typeorm';

/** Authentication — Stage 2 build-order item 6. */
export class CreateAuthTables1755840200000 implements MigrationInterface {
  name = 'CreateAuthTables1755840200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "credentials" (
        "userId" UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "passwordHash" VARCHAR(255) NOT NULL,
        "passwordChangedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "family" UUID NOT NULL,
        "tokenHash" VARCHAR(64) NOT NULL,
        "revokedAt" TIMESTAMPTZ,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_refresh_tokens_hash" ON "refresh_tokens" ("tokenHash")`);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_userId" ON "refresh_tokens" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_family" ON "refresh_tokens" ("family")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "credentials"`);
  }
}
