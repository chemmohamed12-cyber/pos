import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization Foundation F6 — `access_scopes` (Blueprint §9.2). Additive and behaviour-preserving: an empty table changes nothing (the scope a user already has —
 * their org memberships — is still honoured; records without an org-unit link stay visible to everyone). Core-tagged: the scope engine is a foundation service,
 * available in every Company database whichever modules it runs.
 */
export class AccessScopes1790010000000 implements MigrationInterface {
  name = 'AccessScopes1790010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "access_scopes" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "orgUnitId" uuid NOT NULL,
        "includeDescendants" boolean NOT NULL DEFAULT true,
        "createdBy" uuid NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_access_scopes" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_access_scopes_user_unit" ON "access_scopes" ("userId", "orgUnitId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_access_scopes_userId" ON "access_scopes" ("userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_access_scopes_orgUnitId" ON "access_scopes" ("orgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "access_scopes"`);
  }
}
