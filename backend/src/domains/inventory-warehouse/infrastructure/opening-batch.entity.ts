import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type OpeningBatchKind = 'opening' | 'reversal' | 'correction';

/**
 * C4 (ADR-INV-01) - an Opening Balance Batch: the dated, approved, locked document through which opening stock enters. No status column: the lifecycle
 * (`draft -> submitted -> approved -> posted`, `posted -> reversed` only through a reversal batch) lives in the Process Engine (`inventory_opening_batch`).
 * `reversal` / `correction` batches reference the original one in `reversalOfBatchId`.
 */
@Entity('inventory_opening_batches')
export class OpeningBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_inv_opening_batch_number', { unique: true })
  @Column({ type: 'varchar', length: 32 })
  batchNumber!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: OpeningBatchKind;

  @Index('IDX_inv_opening_batch_warehouseId')
  @Column({ type: 'uuid' })
  warehouseId!: string;

  /** The accounting date of every movement, valuation row and journal of the batch (YYYY-MM-DD). */
  @Column({ type: 'date' })
  cutOffDate!: string;

  /** Maker-entered control totals; submit fails unless they equal what the lines add up to. */
  @Column({ type: 'int', nullable: true })
  declaredLineCount!: number | null;

  @Column({ type: 'int', nullable: true })
  declaredTotalQuantity!: number | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  declaredTotalValueBase!: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  computedTotalValueBase!: string | null;

  @Index('IDX_inv_opening_batch_reversalOf')
  @Column({ type: 'uuid', nullable: true })
  reversalOfBatchId!: string | null;

  /** Required for `reversal` and `correction`. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** Eligibility exception (a pair that already has activity): needs `inventory.opening_batch.override` and a written reason; never the default. */
  @Column({ type: 'boolean', default: false })
  allowExistingActivity!: boolean;

  @Column({ type: 'text', nullable: true })
  overrideReason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
