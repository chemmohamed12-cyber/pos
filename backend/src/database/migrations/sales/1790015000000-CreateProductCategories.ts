import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master data step 1 (approved 2026-10-15, MASTER-DATA-AUDIT-AND-GAP-MATRIX-2026-10-15.md §8 M1) — item categories, Commerce domain.
 * Optional one-level-or-deeper hierarchy via `parentId`; `code` unique per Company DB; a category is referenced by products
 * (M2) and has no posting effect (company-wide control accounts stay the only GL mapping — decision D-MD4).
 */
export class CreateProductCategories1790015000000 implements MigrationInterface {
  name = 'CreateProductCategories1790015000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_categories" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(120) NOT NULL,
        "parentId" UUID NULL REFERENCES "product_categories"("id"),
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_product_categories_status" CHECK ("status" IN ('active', 'inactive')),
        CONSTRAINT "CHK_product_categories_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_categories_code" ON "product_categories" ("code")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "product_categories"`);
  }
}
