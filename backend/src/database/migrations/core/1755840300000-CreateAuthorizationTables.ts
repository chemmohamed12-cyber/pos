import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authorization — Stage 2 build-order item 7. Seeds the V1 role keys as
 * data (blueprint §37 — canonical values, not hardcoded in application
 * logic), matching the actors named in the V1 business flow
 * (Daii_Platform_Architecture_Blueprint_V1.md §11, §16, §25).
 */
export class CreateAuthorizationTables1755840300000 implements MigrationInterface {
  name = 'CreateAuthorizationTables1755840300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" VARCHAR(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_roles_key" ON "roles" ("key")`);

    await queryRunner.query(`
      CREATE TABLE "user_roles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "roleId" UUID NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
        "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_user_roles_user_role" ON "user_roles" ("userId", "roleId")`);
    await queryRunner.query(`CREATE INDEX "IDX_user_roles_userId" ON "user_roles" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_user_roles_roleId" ON "user_roles" ("roleId")`);

    const v1RoleKeys = ['admin', 'sales_rep', 'sales_supervisor', 'sales_manager', 'warehouse_worker', 'driver'];
    for (const key of v1RoleKeys) {
      await queryRunner.query(`INSERT INTO "roles" ("key") VALUES ($1)`, [key]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_roles"`);
    await queryRunner.query(`DROP TABLE "roles"`);
  }
}
