import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master data step 1 (approved 2026-10-15, §8 M2; decisions D-MD2, D-MD3) — additive Product master fields:
 *   - `itemType`         finished_good | semi_finished | raw_material | consumable | service, existing rows default `finished_good`
 *   - `categoryId`       → product_categories (M1)
 *   - `defaultWarehouseId` no FK (same convention as PR/PO `warehouseId`): set ONLY through the Inventory domain, which validates
 *                        the warehouse exists, is active and is assigned to the item (D1) before writing it via the Sales contract
 *   - `reorderLevel`     ≥ 0, in the item's base unit (no unit conversion — D-MD3)
 *   - `description`      free text
 * No existing column, index or contract changes; every existing endpoint keeps its shape.
 */
export class AddProductMasterFields1790015100000 implements MigrationInterface {
  name = 'AddProductMasterFields1790015100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "itemType" VARCHAR(24) NOT NULL DEFAULT 'finished_good'`);
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "categoryId" UUID NULL REFERENCES "product_categories"("id")`);
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "defaultWarehouseId" UUID NULL`);
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "reorderLevel" NUMERIC(18,3) NULL`);
    await queryRunner.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "description" TEXT NULL`);
    await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "CHK_products_itemType"`);
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "CHK_products_itemType" CHECK ("itemType" IN ('finished_good', 'semi_finished', 'raw_material', 'consumable', 'service'))`,
    );
    await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "CHK_products_reorderLevel"`);
    await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "CHK_products_reorderLevel" CHECK ("reorderLevel" IS NULL OR "reorderLevel" >= 0)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_products_categoryId" ON "products" ("categoryId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_categoryId"`);
    await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "CHK_products_reorderLevel"`);
    await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "CHK_products_itemType"`);
    for (const column of ['description', 'reorderLevel', 'defaultWarehouseId', 'categoryId', 'itemType']) {
      await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
