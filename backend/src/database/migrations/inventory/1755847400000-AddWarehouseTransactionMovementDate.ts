import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warehouse ERP V1 / Phase 1 Integration (CTO directive §13) — the
 * backdatable business date, distinct from the immutable `createdAt`
 * audit timestamp. Every EXISTING transaction backfills to its own
 * `createdAt` (the only honest value available — it was never
 * backdated, so entry time IS the business date for historical rows).
 */
export class AddWarehouseTransactionMovementDate1755847400000 implements MigrationInterface {
  name = 'AddWarehouseTransactionMovementDate1755847400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" ADD COLUMN "movementDate" TIMESTAMPTZ`);
    await queryRunner.query(`UPDATE "warehouse_transactions" SET "movementDate" = "createdAt"`);
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" ALTER COLUMN "movementDate" SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" DROP COLUMN "movementDate"`);
  }
}
