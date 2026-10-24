import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** The eight fixed outcome classes of the Manufacturing Engine (decision D-ME-4); the policy attached to each class is configuration, the set is not. */
export type OutcomeClass = 'good' | 'scrap' | 'recovered' | 'rework' | 'rejected' | 'held' | 'co_product' | 'by_product';
export type OutcomeResolution = 'good' | 'scrap' | 'rework';

/**
 * Manufacturing Engine S1 — one row per recorded production result (append-only, never edited except to stamp a resolution on a tracking row). Quantity is in the
 * item's integer base unit (decision D-ME-2); `valueBase` is the material cost the result carried (scrap: the pooled WIP value written off; recovered: the declared
 * recovery value) — 0 for the non-financial tracking classes.
 */
@Entity('work_order_results')
@Index(['workOrderId', 'outcomeClass', 'requestId'], { unique: true })
export class WorkOrderResult {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  workOrderId!: string;

  /** Set from S4 (operation runs); null for order-level results. */
  @Column({ type: 'uuid', nullable: true })
  operationId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  outcomeClass!: OutcomeClass;

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  valueBase!: string;

  @Column({ type: 'varchar', length: 128 })
  requestId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  /** A recovery points at the scrap result it was salvaged from (caps its value). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  sourceResultId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  resolution!: OutcomeResolution | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
