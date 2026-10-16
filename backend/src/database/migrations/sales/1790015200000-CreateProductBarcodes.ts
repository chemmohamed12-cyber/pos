import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master data step 1 (approved 2026-10-15, §8 M3; decision D-MD11) — barcodes, many per item, UNIQUE per Company DB across all
 * items. `packLabel` is descriptive only ("carton of 12"): no quantity conversion until a unit-of-measure engine is approved (D-MD3).
 * A barcode equal to an existing SKU is refused by the service (the lookup resolves SKU-or-barcode, so the two must never collide).
 */
export class CreateProductBarcodes1790015200000 implements MigrationInterface {
  name = 'CreateProductBarcodes1790015200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_barcodes" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "barcode" VARCHAR(64) NOT NULL,
        "packLabel" VARCHAR(64) NULL,
        "isPrimary" BOOLEAN NOT NULL DEFAULT false,
        "createdByUserId" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_barcodes_barcode" ON "product_barcodes" ("barcode")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_product_barcodes_productId" ON "product_barcodes" ("productId")`);
    // At most one primary barcode per item.
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_barcodes_one_primary" ON "product_barcodes" ("productId") WHERE "isPrimary"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "product_barcodes"`);
  }
}
