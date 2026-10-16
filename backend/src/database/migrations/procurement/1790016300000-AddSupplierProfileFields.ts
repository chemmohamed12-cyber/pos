import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supplier profile (master-data gap matrix §5.3, M6) — four NULLABLE descriptive columns on `suppliers`. Purely additive: no existing row is
 * rewritten and every existing read/write contract is unchanged. `language` is CHECK-constrained when present. `down` drops exactly these
 * columns (and the constraint with them). Supplier contacts and addresses already exist (migration 1789700000000) and are not changed.
 */
export class AddSupplierProfileFields1790016300000 implements MigrationInterface {
  name = 'AddSupplierProfileFields1790016300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "suppliers" ADD COLUMN "email" VARCHAR(255) NULL`);
    await queryRunner.query(`ALTER TABLE "suppliers" ADD COLUMN "website" VARCHAR(255) NULL`);
    await queryRunner.query(`ALTER TABLE "suppliers" ADD COLUMN "language" VARCHAR(8) NULL`);
    await queryRunner.query(`ALTER TABLE "suppliers" ADD COLUMN "internalNotes" TEXT NULL`);
    await queryRunner.query(`ALTER TABLE "suppliers" ADD CONSTRAINT "CHK_suppliers_language" CHECK ("language" IS NULL OR "language" IN ('ar', 'en'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "suppliers" DROP CONSTRAINT IF EXISTS "CHK_suppliers_language"`);
    for (const column of ['internalNotes', 'language', 'website', 'email']) {
      await queryRunner.query(`ALTER TABLE "suppliers" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
