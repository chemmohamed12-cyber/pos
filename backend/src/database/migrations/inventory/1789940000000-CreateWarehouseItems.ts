import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D1 (2026-10-05) — real Item↔Warehouse assignment (master data). `warehouse_items` says WHICH items belong to WHICH warehouse
 * (many-to-many, UNIQUE per pair). It stores NO quantity or value — stock stays `SUM(stock_movements)`.
 *
 * Backfill (deterministic, nothing invented): every (warehouse, product) pair that already has a stock movement or an
 * active/preliminary reservation is assigned, so no existing stock becomes "unassigned".
 */
export class CreateWarehouseItems1789940000000 implements MigrationInterface {
  name = 'CreateWarehouseItems1789940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "warehouse_items" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "warehouseId" uuid NOT NULL,
        "productId" uuid NOT NULL,
        "assignedByUserId" uuid NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_warehouse_items_pair" UNIQUE ("warehouseId", "productId")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_warehouse_items_product" ON "warehouse_items" ("productId")`);
    await queryRunner.query(`INSERT INTO "warehouse_items" ("warehouseId", "productId") SELECT DISTINCT "warehouseId", "productId" FROM "stock_movements" ON CONFLICT DO NOTHING`);
    await queryRunner.query(
      `INSERT INTO "warehouse_items" ("warehouseId", "productId") SELECT DISTINCT "warehouseId", "productId" FROM "stock_reservations" WHERE "status" IN ('active', 'preliminary') ON CONFLICT DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "warehouse_items"`);
  }
}
