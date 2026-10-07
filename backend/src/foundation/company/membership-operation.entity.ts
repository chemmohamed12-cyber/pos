import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type MembershipOperationType = 'grant' | 'revoke' | 'role_change' | 'role_set';
export type MembershipOperationStatus = 'PENDING' | 'APPLYING' | 'COMPLETED' | 'FAILED' | 'RETRYING';

/**
 * Multi-Company Membership HTTP Management (2026-09-24, D5 — CTO decision:
 * no distributed transaction across the Platform DB / Company DB
 * boundary; local transactions per database + a durable, retryable
 * operation-state record + reconciliation instead). One row per
 * grant/revoke/role-change attempt, in the PLATFORM database (this is
 * cross-Company bookkeeping, not a Company's own operational data).
 *
 * `status` lifecycle, exactly as decided:
 *   PENDING → APPLYING → COMPLETED
 *   PENDING → APPLYING → FAILED → RETRYING → COMPLETED
 *
 * A row stuck at `FAILED`/`RETRYING` — never `COMPLETED` and never
 * silently dropped — is precisely what lets `MembershipReconciliationScheduler`
 * find and heal a Company-DB write that didn't land, instead of that
 * becoming an invisible orphan.
 */
@Entity('membership_operations')
export class MembershipOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Index()
  @Column({ type: 'uuid' })
  companyId!: string;

  @Column({ type: 'varchar', length: 16 })
  operationType!: MembershipOperationType;

  @Column({ type: 'varchar', length: 64, nullable: true })
  previousRoleKey!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetRoleKey!: string | null;

  /** F2 `role_set`: the full role sets before/after. The Company DB (`user_roles`) is already updated when this is recorded; the ledger row tracks the platform MIRROR sync, which the reconciler can always recompute from the authority. */
  @Column({ type: 'jsonb', nullable: true })
  previousRoleKeys!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  targetRoleKeys!: string[] | null;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  status!: MembershipOperationStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  correlationId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
