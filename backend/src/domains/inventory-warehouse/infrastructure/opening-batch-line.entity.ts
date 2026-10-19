import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * C4 (ADR-INV-01) - one line of an Opening Balance Batch. `isActive` is true only for the lines of a POSTED `opening` batch that has not been reversed; the partial unique
 * index on (warehouseId, productId) WHERE isActive is the database-level guarantee against a second opening for the same pair. Reversal / correction lines never
 * become active. `quantity` is positive for opening and reversal lines, signed for a correction (positive = stock found, negative = stock overstated).
 */
@Entity('inventory_opening_batch_lines')
@Index('UQ_inv_opening_line_active_pair', ['warehouseId', 'productId'], { unique: true, where: '"isActive"' })
export class OpeningBatchLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_inv_opening_line_batchId')
  @Column({ type: 'uuid' })
  batchId!: string;

  @Column({ type: 'uuid' })
  warehouseId!: string;

  @Column({ type: 'uuid' })
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  /** Required for opening lines and for correction increases; absent on reversal lines and correction decreases (valued at the moving average). */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  unitCostBase!: string | null;

  /** quantity x unit cost for an opening line, stored and re-checked; for a reversal the original line value; for a correction decrease 0 (valued at posting). */
  @Column({ type: 'numeric', precision: 20, scale: 4 })
  lineValueBase!: string;

  @Column({ type: 'uuid', nullable: true })
  stockMovementId!: string | null;

  @Column({ type: 'boolean', default: false })
  isActive!: boolean;
}
