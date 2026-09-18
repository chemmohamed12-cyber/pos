import { MigrationInterface, QueryRunner } from 'typeorm';

/** CRM / Customer Management — Stage 2 build-order item 22 (first Phase B domain). */
export class CreateCrmTables1755841500000 implements MigrationInterface {
  name = 'CreateCrmTables1755841500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "customers" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "phone" VARCHAR(32),
        "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
        "classification" VARCHAR(64),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_customers_code" ON "customers" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "customer_assignments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "customerId" UUID NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "salesRepUserId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "assignmentType" VARCHAR(16) NOT NULL DEFAULT 'primary',
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "startDate" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "endDate" TIMESTAMPTZ
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_customer_assignments_customerId" ON "customer_assignments" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_customer_assignments_salesRepUserId" ON "customer_assignments" ("salesRepUserId")`);

    // Register the Customer numbering sequence (Numbering Engine, item 17).
    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('customer', 'CUST', false)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'customer'`);
    await queryRunner.query(`DROP TABLE "customer_assignments"`);
    await queryRunner.query(`DROP TABLE "customers"`);
  }
}
