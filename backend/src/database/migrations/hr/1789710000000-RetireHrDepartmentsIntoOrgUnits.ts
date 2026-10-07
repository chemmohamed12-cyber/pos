import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-059 D1 (HR Phase 1) — retires `hr_departments`; `org_units`
 * (`type = 'department'`) becomes the single source of truth for
 * departments, closing the "two unrelated department concepts" gap the
 * Phase 0 study found. `org_units` gains a nullable `code` column
 * (additive — every existing non-department row keeps `code IS NULL`).
 *
 * Row ids are PRESERVED across the copy (`hr_departments.id` ->
 * `org_units.id`): `hr_employees."departmentId"` was always a plain uuid
 * column, never a DB-level FK (confirmed in `CreateHrTables1755854000000`
 * — no `REFERENCES` clause), so it keeps resolving correctly into
 * `org_units` with zero change to any `hr_employees` row.
 */
export class RetireHrDepartmentsIntoOrgUnits1789710000000 implements MigrationInterface {
  name = 'RetireHrDepartmentsIntoOrgUnits1789710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS (2026-10-07, Authorization F1.5): core migration 1790002000000 now ensures this column in every database; a Company that enables HR later must not collide with it.
    await queryRunner.query(`ALTER TABLE "org_units" ADD COLUMN IF NOT EXISTS "code" VARCHAR(32)`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_org_units_code" ON "org_units" ("code") WHERE "code" IS NOT NULL`);

    await queryRunner.query(`
      INSERT INTO "org_units" ("id", "type", "name", "code", "parentId", "createdAt")
      SELECT "id", 'department', "name", "code", NULL, "createdAt" FROM "hr_departments"
    `);

    await queryRunner.query(`DROP TABLE "hr_departments"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "hr_departments" (
        "id" UUID PRIMARY KEY,
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO "hr_departments" ("id", "code", "name", "createdAt", "updatedAt")
      SELECT "id", COALESCE("code", ''), "name", "createdAt", "createdAt" FROM "org_units" WHERE "type" = 'department'
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_hr_departments_code" ON "hr_departments" ("code")`);
    await queryRunner.query(`DELETE FROM "org_units" WHERE "type" = 'department'`);
    await queryRunner.query(`DROP INDEX "IDX_org_units_code"`);
    await queryRunner.query(`ALTER TABLE "org_units" DROP COLUMN "code"`);
  }
}
