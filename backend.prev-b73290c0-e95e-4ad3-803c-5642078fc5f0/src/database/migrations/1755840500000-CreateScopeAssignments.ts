import { MigrationInterface, QueryRunner } from 'typeorm';

/** Scope Engine — Stage 2 build-order item 9. */
export class CreateScopeAssignments1755840500000 implements MigrationInterface {
  name = 'CreateScopeAssignments1755840500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "scope_assignments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "resourceType" VARCHAR(64) NOT NULL,
        "resourceId" VARCHAR(255) NOT NULL,
        "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_scope_assignments_unique" ON "scope_assignments" ("userId", "resourceType", "resourceId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_scope_assignments_userId" ON "scope_assignments" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_scope_assignments_resourceId" ON "scope_assignments" ("resourceId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "scope_assignments"`);
  }
}
