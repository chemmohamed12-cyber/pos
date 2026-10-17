import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F08 — Inventory Valuation (ADR-041 D4/D14/D15). Append-only valuation
 * history — one row per costed event, mirroring `StockMovement`'s own
 * append-only shape (never UPDATEd/DELETEd once written, except by
 * `applyReversal`, which appends a NEW offsetting row, exactly like
 * `WarehouseTransactionsService.reverseTransaction` does operationally —
 * reversal-not-edit, not a new invention).
 *
 * `idempotencyKey` is UNIQUE — the redelivery backstop (ADR-041 D15),
 * mirroring `FinancialEvent.idempotencyKey`'s own role.
 */
@Entity('inventory_valuation_movements')
export class InventoryValuationMovement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Index()
  @Column('uuid')
  warehouseId!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: 'receipt' | 'issue' | 'transfer_out' | 'transfer_in' | 'reversal';

  /** The `inventory-warehouse` `StockMovement` row this costed, when one exists (not every kind has one — e.g. a pure reversal). */
  @Column({ type: 'uuid', nullable: true })
  stockMovementId!: string | null;

  /** Signed, mirrors `StockMovement.quantity`. */
  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  quantityBeforeValueBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  valueDeltaBase!: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  quantityAfterValueBase!: string;

  /** NULL when the resulting on-hand quantity is 0. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  averageCostAfterBase!: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * Slice C1 (ADR-INV-08) - the accounting-facing (business) date of this valuation movement, so the valuation can be rebuilt AS OF a date.
   * Defaults in the database to the UTC date at insert time (the date the inventory events carry today); rows written before the column existed
   * were backfilled with the UTC date of `createdAt` (their PROCESSING date).
   */
  @Index('IDX_inventory_valuation_movements_businessDate')
  @Column({ type: 'date', nullable: true, default: () => `((now() AT TIME ZONE 'UTC')::date)` })
  businessDate!: string | null;
}
