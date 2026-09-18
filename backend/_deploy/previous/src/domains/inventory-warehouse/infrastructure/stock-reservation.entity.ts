import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Soft-hold on available stock (blueprint §19-20) — does NOT itself
 * change on-hand quantity; only narrows "available" until released or
 * fulfilled (converted into a dispatch movement).
 *
 * `preliminary` (CTO directive — Warehouse/Sales Order Ownership Flow,
 * "PRELIMINARY HOLD"): the state a reservation is created in at Sales
 * Order creation time, before Finance approves the deposit. It counts
 * against availability exactly like `active` (nothing new can consume
 * it), but is distinguished for reporting (Free/Preliminary Hold/
 * Reserved) and is the only status subject to the 24-hour expiry job.
 * Deposit approval promotes it to `active` (`InventoryService.
 * confirmReservationsForOrder`); expiry demotes it to `released`
 * (`releasePreliminaryHoldsForOrder`) — same terminal statuses as
 * always, no new lifecycle branch beyond this one extra starting state.
 */
export type ReservationStatus = 'preliminary' | 'active' | 'released' | 'fulfilled';

@Entity('stock_reservations')
export class StockReservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  warehouseId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  salesOrderId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: ReservationStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
