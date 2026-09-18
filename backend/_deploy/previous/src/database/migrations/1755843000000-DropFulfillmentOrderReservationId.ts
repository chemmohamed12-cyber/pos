import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-line Sales Order fix (CTO directive). `fulfillment_orders` used
 * to store a single `reservationId`, which meant only an order's FIRST
 * line was ever actually fulfilled — a real correctness gap for any
 * multi-line order. Inventory already stores one `StockReservation` row
 * per line (keyed by `salesOrderId`); Fulfillment now queries that set
 * directly (`InventoryService.getActiveReservationsForOrder`) instead of
 * caching a single ID on its own row, so the column is no longer needed.
 *
 * Forward-only (ADR-003 §5) — `down()` re-adds the column as nullable
 * since the 1:1 reservation-per-order relationship it modeled no longer
 * holds and cannot be reconstructed from the new data shape.
 */
export class DropFulfillmentOrderReservationId1755843000000 implements MigrationInterface {
  name = 'DropFulfillmentOrderReservationId1755843000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fulfillment_orders" DROP COLUMN "reservationId"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fulfillment_orders" ADD COLUMN "reservationId" VARCHAR(255)`);
  }
}
