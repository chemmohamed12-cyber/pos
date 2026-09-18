import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP Foundation — P9 (ADR-029). `hr`'s only migration — both tables are
 * owned exclusively by `hr` (zero cross-module reference either direction,
 * unlike `core`'s F-P6-1/F-P6-2 guarded cases), so no `to_regclass` guard is
 * needed here or anywhere referencing these tables.
 */
export class CreateHrTables1755854000000 implements MigrationInterface {
  name = 'CreateHrTables1755854000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "hr_departments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_hr_departments_code" ON "hr_departments" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "hr_employees" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "fullName" VARCHAR(255) NOT NULL,
        "departmentId" UUID,
        "position" VARCHAR(128),
        "hireDate" DATE,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_hr_employees_code" ON "hr_employees" ("code")`);
    await queryRunner.query(`CREATE INDEX "IDX_hr_employees_departmentId" ON "hr_employees" ("departmentId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "hr_employees"`);
    await queryRunner.query(`DROP TABLE "hr_departments"`);
  }
}
