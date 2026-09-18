import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-5 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) —
 * the real customer-analysis master sheet's own fields, adopted directly
 * as Daii's Customer data model per CTO instruction. All nullable — no
 * existing customer row changes.
 */
export class AddCustomerCrmFields1755846400000 implements MigrationInterface {
  name = 'AddCustomerCrmFields1755846400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD COLUMN "managerName" VARCHAR(255),
        ADD COLUMN "address" VARCHAR(500),
        ADD COLUMN "governorate" VARCHAR(128),
        ADD COLUMN "whatsappPhone" VARCHAR(32),
        ADD COLUMN "contactMethod" VARCHAR(128),
        ADD COLUMN "responsivenessLevel" VARCHAR(255),
        ADD COLUMN "disinterestNotes" TEXT,
        ADD COLUMN "priceSatisfactionLevel" VARCHAR(255),
        ADD COLUMN "topBrand" VARCHAR(255),
        ADD COLUMN "midBrand" VARCHAR(255),
        ADD COLUMN "lowBrand" VARCHAR(255),
        ADD COLUMN "shippingMethodPreference" VARCHAR(128),
        ADD COLUMN "locationUrl" VARCHAR(500)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
        DROP COLUMN "managerName",
        DROP COLUMN "address",
        DROP COLUMN "governorate",
        DROP COLUMN "whatsappPhone",
        DROP COLUMN "contactMethod",
        DROP COLUMN "responsivenessLevel",
        DROP COLUMN "disinterestNotes",
        DROP COLUMN "priceSatisfactionLevel",
        DROP COLUMN "topBrand",
        DROP COLUMN "midBrand",
        DROP COLUMN "lowBrand",
        DROP COLUMN "shippingMethodPreference",
        DROP COLUMN "locationUrl"
    `);
  }
}
