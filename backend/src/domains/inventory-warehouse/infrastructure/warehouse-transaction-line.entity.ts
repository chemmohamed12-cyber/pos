import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One product line on a `WarehouseTransaction` (directive §9: multi-line
 * entry — a storekeeper builds one Receipt/Issue with 1 to 100+ lines,
 * not one document per SKU).
 *
 * `quantity` is the signed delta that will be applied to the ledger at
 * posting time: always positive for receipt/issue/transfer (direction is
 * implied by the transaction `type`, resolved in
 * `WarehouseTransactionsService.postTransaction`), but signed for
 * adjustment/count (positive = found extra stock, negative = shortage).
 *
 * `systemQuantity`/`physicalQuantity` are count-only (directive §15):
 * captured at count-submission time so the variance
 * (`physicalQuantity - systemQuantity`) — not a raw stock edit — is what
 * eventually posts, and only after review/approval.
 */
@Entity('warehouse_transaction_lines')
export class WarehouseTransactionLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  warehouseTransactionId!: string;

  @Column({ type: 'uuid' })
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'int', nullable: true })
  systemQuantity!: number | null;

  @Column({ type: 'int', nullable: true })
  physicalQuantity!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  notes!: string | null;

  /** D3-B (2026-10-04) — the explicit unit cost (base currency) of a manual-receipt line; mandatory for receipts, null otherwise. */
  @Column({ type: 'numeric', precision: 18, scale: 4, nullable: true })
  unitCostBase!: string | null;
}
