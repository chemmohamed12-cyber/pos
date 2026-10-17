import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory lifecycle, slice C1 (ADR-INV-08, CTO decision 2026-10-17) - the accounting-facing date of a valuation movement, so the valuation can be reported
 * AS OF a date (the General Ledger is dated by business date; the valuation history was only ever stamped with its processing time `createdAt`).
 * Purely additive: a nullable column, no value of any existing column changes.
 *  - existing rows are backfilled with the UTC date of `createdAt` (documented as the PROCESSING date for history written before this release);
 *  - the column default is the UTC date at insert time, so every writer (including code that does not know the column yet) stamps the same
 *    "business date = today" that the inventory events carry today. A later slice (C2) lets callers pass an explicit business date.
 * Idempotent (`IF NOT EXISTS`, the backfill touches only NULLs). PostgreSQL 10 compatible (no generated columns, no extensions).
 * `down` removes exactly what `up` added.
 */
export class AddValuationMovementBusinessDate1790017000000 implements MigrationInterface {
  name = 'AddValuationMovementBusinessDate1790017000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "inventory_valuation_movements" ADD COLUMN IF NOT EXISTS "businessDate" DATE NULL`);
    await queryRunner.query(`UPDATE "inventory_valuation_movements" SET "businessDate" = ("createdAt" AT TIME ZONE 'UTC')::date WHERE "businessDate" IS NULL`);
    await queryRunner.query(`ALTER TABLE "inventory_valuation_movements" ALTER COLUMN "businessDate" SET DEFAULT ((now() AT TIME ZONE 'UTC')::date)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inventory_valuation_movements_businessDate" ON "inventory_valuation_movements" ("businessDate")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inventory_valuation_movements_businessDate"`);
    await queryRunner.query(`ALTER TABLE "inventory_valuation_movements" DROP COLUMN IF EXISTS "businessDate"`);
  }
}
