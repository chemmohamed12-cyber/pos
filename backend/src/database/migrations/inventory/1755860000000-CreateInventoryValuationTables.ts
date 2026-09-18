import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F08 — Inventory Valuation (ADR-041 D1/D4/D5/D22). Tagged `inventory` —
 * F08 ships as its own domain under the EXISTING `inventory` module, not
 * `accounting` (D1). Exactly 2 new tables, no cost-layer table (D4 — one
 * valuation method now, Moving Average only). Additive only; touches no
 * existing `inventory-warehouse`, `commerce`, or `accounting` table.
 */
export class CreateInventoryValuationTables1755860000000 implements MigrationInterface {
  name = 'CreateInventoryValuationTables1755860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inventory_valuation_state" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "productId" UUID NOT NULL,
        "warehouseId" UUID NOT NULL,
        "onHandQuantity" INT NOT NULL,
        "totalValueBase" NUMERIC(20,4) NOT NULL,
        "averageCostBase" NUMERIC(20,4),
        "currencyCode" VARCHAR(3) NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_inventory_valuation_state_product_warehouse" ON "inventory_valuation_state" ("productId", "warehouseId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "inventory_valuation_movements" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "productId" UUID NOT NULL,
        "warehouseId" UUID NOT NULL,
        "kind" VARCHAR(32) NOT NULL,
        "stockMovementId" UUID,
        "quantity" INT NOT NULL,
        "quantityBeforeValueBase" NUMERIC(20,4) NOT NULL,
        "valueDeltaBase" NUMERIC(20,4) NOT NULL,
        "quantityAfterValueBase" NUMERIC(20,4) NOT NULL,
        "averageCostAfterBase" NUMERIC(20,4),
        "idempotencyKey" VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_inventory_valuation_movements_kind"
          CHECK ("kind" IN ('receipt','issue','transfer_out','transfer_in','reversal'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_inventory_valuation_movements_product" ON "inventory_valuation_movements" ("productId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inventory_valuation_movements_warehouse" ON "inventory_valuation_movements" ("warehouseId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_inventory_valuation_movements_idempotency" ON "inventory_valuation_movements" ("idempotencyKey")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "inventory_valuation_movements"`);
    await queryRunner.query(`DROP TABLE "inventory_valuation_state"`);
  }
}
