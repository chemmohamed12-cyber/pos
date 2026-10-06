import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-061 Addendum 1 (A2, 2026-10-06) — BOM lifecycle status. Additive and backward compatible:
 * every existing BOM becomes `active`, so no existing recipe changes behaviour. No versioning,
 * no effective-date ranges (ADR-061 §2/§21 invariant preserved).
 */
export class AddBomStatus1790000000000 implements MigrationInterface {
  name = 'AddBomStatus1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bill_of_materials" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'active'`);
    await queryRunner.query(`ALTER TABLE "bill_of_materials" DROP CONSTRAINT IF EXISTS "CHK_bill_of_materials_status"`);
    await queryRunner.query(`ALTER TABLE "bill_of_materials" ADD CONSTRAINT "CHK_bill_of_materials_status" CHECK ("status" IN ('active', 'inactive'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bill_of_materials" DROP CONSTRAINT IF EXISTS "CHK_bill_of_materials_status"`);
    await queryRunner.query(`ALTER TABLE "bill_of_materials" DROP COLUMN IF EXISTS "status"`);
  }
}
