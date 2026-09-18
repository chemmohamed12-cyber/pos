import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sales — Stage 2 build-order item 23. */
export class CreateSalesTables1755841700000 implements MigrationInterface {
  name = 'CreateSalesTables1755841700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sales_rep_profiles" (
        "userId" UUID PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "salesCode" VARCHAR(32) NOT NULL,
        "territory" VARCHAR(255),
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_sales_rep_profiles_code" ON "sales_rep_profiles" ("salesCode")`);

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('sales_rep', 'REP', false)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'sales_rep'`);
    await queryRunner.query(`DROP TABLE "sales_rep_profiles"`);
  }
}
