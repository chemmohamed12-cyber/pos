import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-2 — 'assembly_consumption' (21 chars) doesn't fit the original
 * VARCHAR(16) `movementType` column (found live: a real INSERT failure
 * during smoke-testing `assembleProduct`, not a theoretical gap). Widened
 * to 32 for headroom against any future movement type.
 */
export class WidenStockMovementType1755846100000 implements MigrationInterface {
  name = 'WidenStockMovementType1755846100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stock_movements" ALTER COLUMN "movementType" TYPE VARCHAR(32)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "stock_movements" ALTER COLUMN "movementType" TYPE VARCHAR(16)`);
  }
}
