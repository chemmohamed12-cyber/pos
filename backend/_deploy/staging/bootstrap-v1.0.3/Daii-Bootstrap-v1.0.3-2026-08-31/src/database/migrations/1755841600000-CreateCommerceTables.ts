import { MigrationInterface, QueryRunner } from 'typeorm';

/** Commerce — Stage 2 build-order item 21. */
export class CreateCommerceTables1755841600000 implements MigrationInterface {
  name = 'CreateCommerceTables1755841600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "products" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sku" VARCHAR(64) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "unitPrice" NUMERIC(12,2) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_products_sku" ON "products" ("sku")`);
    await queryRunner.query(`CREATE INDEX "IDX_products_status" ON "products" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "products"`);
  }
}
