import { MigrationInterface, QueryRunner } from 'typeorm';

/** Returns — Stage 2 build-order item 32 (final Phase B domain). */
export class CreateReturnsTables1755842400000 implements MigrationInterface {
  name = 'CreateReturnsTables1755842400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "return_requests" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "salesOrderId" VARCHAR(255) NOT NULL,
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" INT NOT NULL,
        "warehouseId" UUID NOT NULL REFERENCES "warehouses"("id"),
        "reason" VARCHAR(255) NOT NULL,
        "requestedByUserId" UUID NOT NULL REFERENCES "users"("id"),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_return_requests_salesOrderId" ON "return_requests" ("salesOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "return_dispositions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "returnRequestId" UUID NOT NULL REFERENCES "return_requests"("id") ON DELETE CASCADE,
        "disposition" VARCHAR(16) NOT NULL,
        "notes" VARCHAR(500),
        "inspectedByUserId" UUID NOT NULL REFERENCES "users"("id"),
        "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_return_dispositions_returnRequestId" ON "return_dispositions" ("returnRequestId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "return_dispositions"`);
    await queryRunner.query(`DROP TABLE "return_requests"`);
  }
}
