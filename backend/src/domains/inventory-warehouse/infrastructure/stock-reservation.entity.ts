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

/**
 * ADR-061 (Manufacturing) — the generic reference addressing scheme a
 * non-Sales-Order reservation uses instead of `salesOrderId`. `WORK_ORDER`
 * is the only value in use today; new callers add their own value here
 * rather than repurposing `salesOrderId` or building a second reservation
 * mechanism (see the `1789720000000-AddGenericReferenceToStockReservations`
 * migration for the full rationale).
 */
export type ReservationReferenceType = 'WORK_ORDER';

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

  /**
   * Nullable since ADR-061 (Manufacturing) — mutually exclusive with
   * `referenceType`/`referenceId` below (DB-enforced by
   * `CHK_stock_reservations_reference_xor`). Every Sales Order reservation
   * still populates this exactly as before; nothing about existing
   * Sales-Order-keyed methods changes.
   */
  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  salesOrderId!: string | null;

  /** ADR-061 (Manufacturing) — generic reservation addressing, populated together, never with `salesOrderId`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  referenceType!: ReservationReferenceType | null;

  /** ADR-061 (Manufacturing) — e.g. a `WorkOrder.id`, when `referenceType` is set. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  referenceId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: ReservationStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
