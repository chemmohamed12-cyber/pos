import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Company Plans / Packages (2026-10-05, CTO: "Super Admin workflow — create a
 * company, assign its package"). Three new tables, purely additive. Nothing
 * reads them until a Plan is assigned to a Company, so every existing Company
 * keeps resolving to the installation's own entitlement unchanged.
 *
 * `company_plan_assignments."companyId"` references `companies` (platform DB);
 * `plan_modules` is stored with the dependency closure already expanded.
 */
export class CreatePlansAndCompanyAssignments1789890000000 implements MigrationInterface {
  name = 'CreatePlansAndCompanyAssignments1789890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "plans" (
        "code" VARCHAR(64) PRIMARY KEY,
        "name" VARCHAR(128) NOT NULL,
        "description" TEXT,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_plans_status" CHECK ("status" IN ('active', 'archived'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "plan_modules" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "planCode" VARCHAR(64) NOT NULL REFERENCES "plans"("code") ON DELETE CASCADE,
        "moduleCode" VARCHAR(64) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_plan_modules_plan_module" ON "plan_modules" ("planCode", "moduleCode")`);
    await queryRunner.query(`
      CREATE TABLE "company_plan_assignments" (
        "companyId" UUID PRIMARY KEY REFERENCES "companies"("id"),
        "planCode" VARCHAR(64) NOT NULL REFERENCES "plans"("code"),
        "assignedByUserId" UUID,
        "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_company_plan_assignments_planCode" ON "company_plan_assignments" ("planCode")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "company_plan_assignments"`);
    await queryRunner.query(`DROP TABLE "plan_modules"`);
    await queryRunner.query(`DROP TABLE "plans"`);
  }
}
