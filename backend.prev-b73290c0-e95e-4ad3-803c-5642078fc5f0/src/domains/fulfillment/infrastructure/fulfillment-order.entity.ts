import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One per Sales Order for V1 (no multi-warehouse split yet — blueprint
 * §20 future scope, ADR-016 additive later).
 *
 * MULTI-LINE FIX (CTO directive, closes the disclosed V1 gap): this used
 * to store a single `reservationId`, which meant only a sales order's
 * FIRST line was ever actually fulfilled/picked/packed/dispatched — a
 * real correctness gap for any multi-line order, not just a cosmetic
 * one. There is no single reservation to store any more: Inventory owns
 * one `StockReservation` row per order LINE (already true — see
 * `InventoryService.reserveStock`, called once per line), and
 * `InventoryService.getActiveReservationsForOrder(salesOrderId)` is now
 * the single source of truth Fulfillment queries whenever it needs
 * "every reservation for this order" (creation-time warehouse
 * derivation, and pack-verification-time dispatch of every line). See
 * migration `1755843000000-DropFulfillmentOrderReservationId.ts`.
 */
@Entity('fulfillment_orders')
export class FulfillmentOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  salesOrderId!: string;

  @Column('uuid')
  warehouseId!: string;

  /**
   * CTO directive (Fulfillment screen rework) — its own document number,
   * same format as the Sales Order's (`FO-2026-000001` vs `SO-2026-000001`),
   * issued through the same Numbering Engine. Nullable because rows
   * created before this column existed have none — never backfilled with
   * a fabricated number.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  orderNumber!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
