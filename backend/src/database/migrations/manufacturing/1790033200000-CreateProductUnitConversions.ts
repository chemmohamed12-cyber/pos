import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manufacturing Engine S2 (2026-10-24, decision D-ME-2) — units and pack conversion by integer base-unit scaling. Additive: one new table, nothing existing changes.
 * `stock_movements.quantity` stays an integer; a product's `unit` is its BASE unit and each row here says "1 <unitCode> = <factor> base units" (factor is a whole number
 * >= 2). Fractional quantities are therefore expressed by choosing a small enough base unit (e.g. gram) and larger units as conversions (kg = 1000, carton = 240).
 */
export class CreateProductUnitConversions1790033200000 implements MigrationInterface {
  name = 'CreateProductUnitConversions1790033200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_unit_conversions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "productId" UUID NOT NULL,
        "unitCode" VARCHAR(32) NOT NULL,
        "factor" INT NOT NULL,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_product_unit_conversions_factor" CHECK ("factor" >= 2)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_unit_conversions_product_unit" ON "product_unit_conversions" ("productId", lower("unitCode"))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "product_unit_conversions"`);
  }
}
