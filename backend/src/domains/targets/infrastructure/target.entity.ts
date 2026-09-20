import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TargetStatus } from '../domain/target-status';

/**
 * ADR-068 §D/§E, ADR-071 §4 — Target Management is its own independent
 * bounded context; Commission never owns Target data (ADR-071 §3). Phase
 * 1 dimensions are closed: `employeeId` + period are mandatory; `teamId`
 * is contextual metadata only (an `OrgUnit` reference, never a
 * standalone team-target engine) — Region/Customer-Group/Product-
 * Category/Campaign/Territory Targets are explicitly deferred, not built.
 * Non-overlap for the same employee is enforced at the DB level via a
 * Postgres exclusion constraint (see the migration) — a genuinely new
 * pattern for this codebase, the correct native mechanism for "no two
 * approved ranges for the same key may overlap."
 */
@Entity('targets')
export class Target {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'date' })
  periodStart!: string;

  @Column({ type: 'date' })
  periodEnd!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  targetValue!: string;

  /** Contextual metadata only (ADR-068 §D) — never a standalone team-target engine. */
  @Column({ type: 'uuid', nullable: true })
  teamId!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: TargetStatus;

  @Column('uuid', { nullable: true })
  approvalRequestId!: string | null;

  @Column('uuid')
  createdByUserId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
