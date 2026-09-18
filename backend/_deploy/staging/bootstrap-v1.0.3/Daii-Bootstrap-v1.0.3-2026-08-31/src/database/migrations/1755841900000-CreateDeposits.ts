import { MigrationInterface, QueryRunner } from 'typeorm';

/** Deposit Control — Stage 2 build-order item 26. */
export class CreateDeposits1755841900000 implements MigrationInterface {
  name = 'CreateDeposits1755841900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "deposits" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "salesOrderId" UUID NOT NULL REFERENCES "sales_orders"("id"),
        "amount" NUMERIC(14,2) NOT NULL,
        "method" VARCHAR(32) NOT NULL,
        "reference" VARCHAR(255),
        "evidenceMediaAssetId" UUID,
        "status" VARCHAR(16) NOT NULL DEFAULT 'submitted',
        "submittedByUserId" UUID NOT NULL REFERENCES "users"("id"),
        "reviewedByUserId" UUID REFERENCES "users"("id"),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_deposits_salesOrderId" ON "deposits" ("salesOrderId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "deposits"`);
  }
}
