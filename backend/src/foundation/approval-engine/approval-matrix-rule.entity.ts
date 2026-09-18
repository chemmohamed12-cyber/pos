import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * FA-01 (contract §3). Configuration DATA — how many / which approvers a
 * request type needs.
 *
 * Stored as a dedicated table (not the flat config-key store) because a
 * matrix rule is structured, multi-column, and multi-row-per-type
 * (different amount bands, org-scoped variants) — administered through
 * the platform's standard permission-gated reference-data CRUD pattern
 * (`core.approval.manage`), which is NOT a new configuration *mechanism*
 * (Blueprint §9.1). Rows are snapshotted onto `ApprovalRequest` at submit
 * time, so editing a rule never changes an in-flight request.
 */
@Entity('approval_matrix_rules')
@Index(['requestTypeCode', 'isActive'])
export class ApprovalMatrixRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  requestTypeCode!: string;

  /** How many distinct valid `approved` decisions the request needs. CHECK >= 1. */
  @Column({ type: 'int', default: 1 })
  minApprovers!: number;

  /** A checker must hold this permission node at `'editable'` (live `PermissionService.hasAtLeast`). */
  @Column({ type: 'varchar', length: 255 })
  requiredPermissionNode!: string;

  /** Rule applies only when the request's `payload.amount` >= this. NULL = always applies. */
  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  valueThreshold!: string | null;

  /** Scope (ADR-031). NULL = installation-wide. */
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
