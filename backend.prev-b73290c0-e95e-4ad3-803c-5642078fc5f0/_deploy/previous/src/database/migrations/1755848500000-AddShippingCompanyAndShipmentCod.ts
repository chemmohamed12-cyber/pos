import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("مرحلة الشحن يجب أن تكون مبنية من البداية لدعم أكثر من
 * شركة شحن") — the `shipping_companies` table + the two new `shipments`
 * columns that attach a shipment to one (COD amount is per-shipment,
 * never per-company — different shipments through the same company can
 * carry different COD amounts).
 */
export class AddShippingCompanyAndShipmentCod1755848500000 implements MigrationInterface {
  name = 'AddShippingCompanyAndShipmentCod1755848500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "shipping_companies" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(32) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "contactPhone" VARCHAR(32),
        "treasuryAccountId" UUID,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_shipping_companies_code" ON "shipping_companies" ("code")`);

    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "shippingCompanyId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_shipments_shippingCompanyId" ON "shipments" ("shippingCompanyId")`);
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "codAmount" NUMERIC(14,2)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "codAmount"`);
    await queryRunner.query(`DROP INDEX "IDX_shipments_shippingCompanyId"`);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "shippingCompanyId"`);
    await queryRunner.query(`DROP TABLE "shipping_companies"`);
  }
}
