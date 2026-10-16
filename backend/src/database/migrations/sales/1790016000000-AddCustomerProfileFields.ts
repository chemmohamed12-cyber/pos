import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer profile (master-data gap matrix §5.3, M4) — nine NULLABLE descriptive columns on `customers`. Purely additive: no existing row
 * is rewritten, every existing read and write is unchanged, and the legacy `phone` / `address` / `governorate` columns keep their meaning
 * (D-MD6: no backfill). `partyType` and `language` are CHECK-constrained when present so the database itself refuses a bad value.
 * `down` drops exactly these columns (and their constraints with them).
 */
export class AddCustomerProfileFields1790016000000 implements MigrationInterface {
  name = 'AddCustomerProfileFields1790016000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "partyType" VARCHAR(16) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "legalName" VARCHAR(255) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "taxRegistrationNumber" VARCHAR(64) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "vatRegistrationNumber" VARCHAR(64) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "commercialRegistrationNumber" VARCHAR(64) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "email" VARCHAR(255) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "website" VARCHAR(255) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "language" VARCHAR(8) NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "internalNotes" TEXT NULL`);
    await queryRunner.query(`ALTER TABLE "customers" ADD CONSTRAINT "CHK_customers_party_type" CHECK ("partyType" IS NULL OR "partyType" IN ('company', 'individual'))`);
    await queryRunner.query(`ALTER TABLE "customers" ADD CONSTRAINT "CHK_customers_language" CHECK ("language" IS NULL OR "language" IN ('ar', 'en'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "CHK_customers_language"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "CHK_customers_party_type"`);
    for (const column of ['internalNotes', 'language', 'website', 'email', 'commercialRegistrationNumber', 'vatRegistrationNumber', 'taxRegistrationNumber', 'legalName', 'partyType']) {
      await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
