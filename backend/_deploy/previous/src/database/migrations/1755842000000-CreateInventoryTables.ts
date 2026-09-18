import { MigrationInterface, QueryRunner } from 'typeorm';

/** Inventory & Warehouse — Stage 2 build-order item 27. */
export class CreateInventoryTables1755842000000 implements MigrationInterface {
  name = 'CreateInventoryTables1755842000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "warehouses" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_warehouses_code" ON "warehouses" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "stock_movements" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "warehouseId" UUID NOT NULL REFERENCES "warehouses"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" INT NOT NULL,
        "movementType" VARCHAR(16) NOT NULL,
        "referenceType" VARCHAR(64),
        "referenceId" VARCHAR(255),
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_stock_movements_wh_product" ON "stock_movements" ("warehouseId", "productId")`);

    await queryRunner.query(`
      CREATE TABLE "stock_reservations" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "warehouseId" UUID NOT NULL REFERENCES "warehouses"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" INT NOT NULL,
        "salesOrderId" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_stock_reservations_wh_product" ON "stock_reservations" ("warehouseId", "productId")`);
    await queryRunner.query(`CREATE INDEX "IDX_stock_reservations_salesOrderId" ON "stock_reservations" ("salesOrderId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "stock_reservations"`);
    await queryRunner.query(`DROP TABLE "stock_movements"`);
    await queryRunner.query(`DROP TABLE "warehouses"`);
  }
}
