import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * F08 — Inventory Valuation (ADR-041 D2/D4/D5). The running Moving-Average
 * (Weighted Average Cost) state, ONE row per `(productId, warehouseId)` —
 * the operational ledger's own natural grain (D5), deliberately decoupled
 * from F07's GLOBAL `inventory` GL control account (ADR-040 D4/D11):
 * valuation granularity and GL-account granularity are separate concerns.
 *
 * `onHandQuantity`/`totalValueBase` are NOT derived from a scan of
 * `stock_movements` on every read — they are maintained incrementally by
 * `CostEngine.applyReceipt`/`.applyIssue`/`.applyTransfer`/`.applyReversal`
 * (ADR-041 D23 — O(1) per movement, no historical scan). No cost-layer
 * concept exists here (D4) — a future FIFO/Standard-Cost engine would need
 * its own, separate schema; this table is Moving-Average-specific.
 */
@Entity('inventory_valuation_state')
@Index(['productId', 'warehouseId'], { unique: true })
export class InventoryValuationState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  productId!: string;

  @Column('uuid')
  warehouseId!: string;

  /** Mirrors `StockMovement.quantity`'s own precision — whole units only, no fractional support today. */
  @Column({ type: 'int' })
  onHandQuantity!: number;

  /** D16 — same NUMERIC(20,4) convention F01/F03 already use for GL base amounts. */
  @Column({ type: 'numeric', precision: 20, scale: 4 })
  totalValueBase!: string;

  /** NULL when `onHandQuantity` is 0 — there is no meaningful average cost for zero stock. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  averageCostBase!: string | null;

  /** D17 — reserved for a future FX-aware costing phase; always the base/functional currency today. */
  @Column({ type: 'varchar', length: 3 })
  currencyCode!: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
