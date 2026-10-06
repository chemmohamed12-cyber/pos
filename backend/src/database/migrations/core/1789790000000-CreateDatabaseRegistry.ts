import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Company Phase 3 V7, Area 3 (Database Registry). V7 names "one new
 * table" — `database_registries`, the `companyId → {host, port, database
 * name, status}` shape. `database_credentials` is the second table that
 * V7's own Required field forces to exist ("Secrets ... held in a
 * separate store — never inline on the Company/identity row"): it cannot
 * be the same table as the registry by definition. No CHECK constraint on
 * "status" here, same reasoning as Area 1's migration — its allowed
 * values are not this migration's decision to make.
 */
export class CreateDatabaseRegistry1789790000000 implements MigrationInterface {
  name = 'CreateDatabaseRegistry1789790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "database_registries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" UUID NOT NULL UNIQUE REFERENCES "companies"("id"),
        "host" VARCHAR(255) NOT NULL,
        "port" INTEGER NOT NULL,
        "databaseName" VARCHAR(63) NOT NULL,
        "status" VARCHAR(16) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "database_credentials" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "databaseRegistryId" UUID NOT NULL UNIQUE REFERENCES "database_registries"("id"),
        "encryptedValue" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "database_credentials"`);
    await queryRunner.query(`DROP TABLE "database_registries"`);
  }
}
