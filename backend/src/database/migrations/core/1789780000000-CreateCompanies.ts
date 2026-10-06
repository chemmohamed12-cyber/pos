import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Company Phase 3 V7, Area 1 (Installation ↔ Company Model). One
 * new table, purely additive — no code reads it yet. No CHECK constraint
 * on "status" here deliberately: its allowed values and transitions are
 * Area 2 (Company Registry)'s own scope, not this migration's.
 */
export class CreateCompanies1789780000000 implements MigrationInterface {
  name = 'CreateCompanies1789780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "companies" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "installationId" VARCHAR(32) NOT NULL REFERENCES "installation"("id"),
        "name" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_companies_installationId" ON "companies" ("installationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "companies"`);
  }
}
