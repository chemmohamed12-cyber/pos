import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { WarehouseTransactionType } from '../domain/warehouse-transaction-type';

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive) — the header of
 * a multi-line warehouse document (Receipt/Issue/Transfer/Adjustment/
 * Count). This is a NEW layer ABOVE the existing append-only
 * `stock_movements` ledger, not a replacement for it: the ledger remains
 * the sole source of truth for balances (§16 of the directive);
 * `WarehouseTransaction` is the business document a storekeeper actually
 * works with (one printable, numbered, lifecycle-tracked thing per
 * operation), which POSTS into the ledger via the existing
 * `InventoryService.recordMovement` once approved — never writes
 * `stock_movements` directly, same discipline as every other caller of
 * that method (Excel import, reservation fulfillment, assembly).
 *
 * No status column, same pattern as `SalesOrder`/`Shipment`/etc. —
 * lifecycle lives entirely in the Process Engine, keyed by
 * `(definitionKey:'warehouse_transaction', entityType:'warehouse_transaction', entityId: this.id)`.
 */
@Entity('warehouse_transactions')
export class WarehouseTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  transactionNumber!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: WarehouseTransactionType;

  /** Source warehouse for issue/transfer/adjustment/count; destination for receipt. */
  @Index()
  @Column({ type: 'uuid' })
  warehouseId!: string;

  /** Only populated for `transfer` — the receiving warehouse. */
  @Column({ type: 'uuid', nullable: true })
  destinationWarehouseId!: string | null;

  /**
   * Warehouse ERP V1 / Phase 1 Integration (CTO directive §13) — the
   * BUSINESS date this movement actually happened (e.g. the day goods
   * physically arrived), distinct from `createdAt` (the immutable audit
   * timestamp of when the record was entered into the system — never
   * itself editable). Defaults to "now" at creation; settable to a past
   * date for backdated entry. Deliberately NOT enforced against an
   * open/closed accounting period here — no Period entity exists yet
   * (directive: "don't build a full GL/period-closing engine now, but
   * don't design in a way that blocks it later") — this column is the
   * non-blocking hook a future Period check would read.
   */
  @Column({ type: 'timestamptz' })
  movementDate!: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  /**
   * D3-B (2026-10-04) — the CONTROLLED reason code of a manual receipt (a key of
   * `accounting.inventory_manual_receipt_reason_accounts`); it — never the free-text `reason` above — selects the
   * offset GL account. Null on every non-receipt document and on legacy receipts.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /** Set only on a reversal transaction — points back at the transaction it reverses (§17: reversal, never delete, once posted). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  reversalOfTransactionId!: string | null;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
