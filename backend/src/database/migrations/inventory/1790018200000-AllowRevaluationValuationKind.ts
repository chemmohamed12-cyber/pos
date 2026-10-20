import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory lifecycle, slice C6 (ADR-INV-05 section 4, finding G-VAL-4) - the valuation history `kind` is guarded by a CHECK constraint
 * (`CHK_inventory_valuation_movements_kind`, migration 1755860000000). A value-only revaluation (an approved F07 write-down / write-up that now moves the valuation) appends a row of
 * kind `revaluation`, so the constraint is dropped and recreated with that one extra value. PostgreSQL 10 compatible (plain DROP / ADD CONSTRAINT); no data changes; idempotent.
 * `down` restores the original list and therefore refuses (the constraint cannot be re-added) while `revaluation` rows exist: history is append-only and is never deleted by a rollback -
 * switch `accounting.inventory_f07_updates_valuation` off first and keep the rows, or leave this migration applied (it is harmless).
 */
export class AllowRevaluationValuationKind1790018200000 implements MigrationInterface {
  name = 'AllowRevaluationValuationKind1790018200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "inventory_valuation_movements" DROP CONSTRAINT IF EXISTS "CHK_inventory_valuation_movements_kind"`);
    await queryRunner.query(
      `ALTER TABLE "inventory_valuation_movements" ADD CONSTRAINT "CHK_inventory_valuation_movements_kind" CHECK ("kind" IN ('receipt','issue','transfer_out','transfer_in','reversal','revaluation'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "inventory_valuation_movements" DROP CONSTRAINT IF EXISTS "CHK_inventory_valuation_movements_kind"`);
    await queryRunner.query(
      `ALTER TABLE "inventory_valuation_movements" ADD CONSTRAINT "CHK_inventory_valuation_movements_kind" CHECK ("kind" IN ('receipt','issue','transfer_out','transfer_in','reversal'))`,
    );
  }
}
