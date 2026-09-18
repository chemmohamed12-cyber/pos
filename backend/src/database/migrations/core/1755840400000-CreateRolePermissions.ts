import { MigrationInterface, QueryRunner } from 'typeorm';

/** Permission Engine — Stage 2 build-order item 8. */
export class CreateRolePermissions1755840400000 implements MigrationInterface {
  name = 'CreateRolePermissions1755840400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "roleId" UUID NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
        "nodeKey" VARCHAR(255) NOT NULL,
        "access" VARCHAR(16) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_role_permissions_role_node" ON "role_permissions" ("roleId", "nodeKey")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_role_permissions_roleId" ON "role_permissions" ("roleId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "role_permissions"`);
  }
}
