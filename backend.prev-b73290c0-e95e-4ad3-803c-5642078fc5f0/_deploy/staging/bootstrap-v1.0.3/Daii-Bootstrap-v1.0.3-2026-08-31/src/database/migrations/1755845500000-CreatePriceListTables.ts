import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-3 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md) — Price List master + items, Commerce domain (DAII_DOMAIN_BOUNDARIES.md §1). */
export class CreatePriceListTables1755845500000 implements MigrationInterface {
  name = 'CreatePriceListTables1755845500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "price_lists" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_price_lists_code" ON "price_lists" ("code")`);

    await queryRunner.query(`
      CREATE TABLE "price_list_items" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "priceListId" UUID NOT NULL REFERENCES "price_lists"("id") ON DELETE CASCADE,
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "price" NUMERIC(12,2) NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_price_list_items_priceListId" ON "price_list_items" ("priceListId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_price_list_items_priceListId_productId" ON "price_list_items" ("priceListId", "productId")`,
    );

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('price_list', 'PL', false)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'price_list'`);
    await queryRunner.query(`DROP TABLE "price_list_items"`);
    await queryRunner.query(`DROP TABLE "price_lists"`);
  }
}
