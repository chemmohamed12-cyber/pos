import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Company Phase 3 V7, Area 6 (Authorization Boundary). Control-Plane
 * `user_company_memberships` — `(userId, companyId) → roleKey`. No FK on
 * `roleKey`: it names a `Role.key` row inside that specific Company's own
 * physically separate database, which a Control-Plane migration cannot
 * reference. `userId` also carries no FK here deliberately — `User` is a
 * Control-Plane entity per earlier Phase 3 sections, but this migration
 * does not touch the `users` table's own constraints, staying within
 * Area 6's own literal scope.
 */
export class CreateUserCompanyMemberships1789800000000 implements MigrationInterface {
  name = 'CreateUserCompanyMemberships1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_company_memberships" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "companyId" UUID NOT NULL REFERENCES "companies"("id"),
        "roleKey" VARCHAR(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_user_company_memberships_user_company" ON "user_company_memberships" ("userId", "companyId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_company_memberships"`);
  }
}
