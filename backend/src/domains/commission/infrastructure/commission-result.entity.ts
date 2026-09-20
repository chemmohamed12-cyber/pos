import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-068 §F — the immutable snapshot, closing its field list verbatim.
 * Once written, no field is ever updated — only a `CommissionAdjustment`
 * row may reference it (`ADR-068 §H`). `triggerEventKey` is the concrete
 * mechanism behind `ADR-071 §12`'s dedup invariant: deterministic per
 * (trigger kind, source entity), distinguishing an Invoice event from a
 * Collection event from a Correction/Adjustment from a Recalculation —
 * enforced as a real unique index (see the migration), never left as an
 * unenforced convention.
 */
@Entity('commission_results')
export class CommissionResult {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The resolved Sales Rep — an `Employee.id`, never a `User.id` (ADR-068 §G). */
  @Index()
  @Column('uuid')
  employeeId!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Column('uuid', { nullable: true })
  customerGroupId!: string | null;

  /** Invoice/Collection ids this result traces back to — the audit/traceability chain (ADR-068 §F). */
  @Column({ type: 'jsonb' })
  sourceTransactionRefs!: Record<string, unknown>;

  /** Historical reference only — never re-read live once written (ADR-068 §F's own "snapshot, not a live reference" rule). */
  @Column('uuid')
  resolvedPolicyId!: string;

  @Column({ type: 'varchar', length: 16 })
  policyScope!: string;

  @Column({ type: 'varchar', length: 20 })
  calculationBasis!: string;

  @Column('uuid', { nullable: true })
  targetPeriodId!: string | null;

  /** A copy of the Target's value/achievement at calculation time — never a live reference. */
  @Column({ type: 'jsonb', nullable: true })
  targetSnapshot!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  applicableTier!: Record<string, unknown> | null;

  @Column({ type: 'numeric', precision: 8, scale: 4 })
  rate!: string;

  @Column({ type: 'jsonb' })
  calculationInputs!: Record<string, unknown>;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  calculatedAmount!: string;

  @Column({ type: 'timestamptz' })
  calculationTimestamp!: Date;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  batchId!: string | null;

  /** ADR-071 §12's dedup invariant, concretely enforced — see the migration's unique index. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  triggerEventKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
