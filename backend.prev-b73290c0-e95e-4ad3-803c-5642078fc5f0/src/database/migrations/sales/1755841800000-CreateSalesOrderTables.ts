import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sales Orders — Stage 2 build-order item 24. sales_order sequence already seeded (Milestone 1's demo migration). */
export class CreateSalesOrderTables1755841800000 implements MigrationInterface {
  name = 'CreateSalesOrderTables1755841800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sales_orders" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "orderNumber" VARCHAR(32) NOT NULL,
        "customerId" UUID NOT NULL REFERENCES "customers"("id"),
        "salesRepUserId" UUID NOT NULL REFERENCES "users"("id"),
        "totalAmount" NUMERIC(14,2) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_sales_orders_orderNumber" ON "sales_orders" ("orderNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_orders_customerId" ON "sales_orders" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_orders_salesRepUserId" ON "sales_orders" ("salesRepUserId")`);

    await queryRunner.query(`
      CREATE TABLE "sales_order_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "salesOrderId" UUID NOT NULL REFERENCES "sales_orders"("id") ON DELETE CASCADE,
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" INT NOT NULL,
        "unitPrice" NUMERIC(12,2) NOT NULL,
        "lineTotal" NUMERIC(14,2) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_sales_order_lines_salesOrderId" ON "sales_order_lines" ("salesOrderId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "sales_order_lines"`);
    await queryRunner.query(`DROP TABLE "sales_orders"`);
  }
}
