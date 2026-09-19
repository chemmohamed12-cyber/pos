import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-065 §3/§8 — only populated on the `ADR-063 §8: C` FA-01 path (the
 * target day's batch is already `approved`). A pre-approval correction
 * needs no row here — it is applied immediately via
 * `AttendanceService.correctDay` and audited (`AuditService`), the same
 * "direct, permission-gated" shape `ADR-059 D3` (termination) already
 * established.
 */
@Entity('attendance_correction_requests')
export class AttendanceCorrectionRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  attendanceDayId!: string;

  @Index()
  @Column('uuid')
  approvalRequestId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  proposedCheckIn!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  proposedCheckOut!: Date | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column('uuid')
  requestedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
