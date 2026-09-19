import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-065 §5/§7 — the FA-01 gate between Processing and (eventually)
 * Payroll, per `ADR-062 §4`. An `AttendanceDay` only becomes
 * payroll-visible once the batch containing it is `approved`. This is
 * also the trigger `ADR-063 §8: C` uses to decide whether a correction
 * needs FA-01 or can be applied directly.
 */
@Entity('attendance_approval_batches')
export class AttendanceApprovalBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'date' })
  periodStart!: string;

  @Column({ type: 'date' })
  periodEnd!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: 'draft' | 'submitted' | 'approved' | 'rejected';

  @Index()
  @Column('uuid', { nullable: true })
  approvalRequestId!: string | null;

  @Column('uuid')
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;
}
