import { MigrationInterface, QueryRunner } from 'typeorm';

/** Organization — Stage 2 build-order item 10. */
export class CreateOrganizationTables1755840600000 implements MigrationInterface {
  name = 'CreateOrganizationTables1755840600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "org_units" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" VARCHAR(16) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "parentId" UUID REFERENCES "org_units"("id") ON DELETE CASCADE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_org_units_parentId" ON "org_units" ("parentId")`);

    await queryRunner.query(`
      CREATE TABLE "org_memberships" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "orgUnitId" UUID NOT NULL REFERENCES "org_units"("id") ON DELETE CASCADE,
        "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_org_memberships_unique" ON "org_memberships" ("userId", "orgUnitId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_org_memberships_userId" ON "org_memberships" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_org_memberships_orgUnitId" ON "org_memberships" ("orgUnitId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "org_memberships"`);
    await queryRunner.query(`DROP TABLE "org_units"`);
  }
}
