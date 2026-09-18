import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type LeaveRequestStatus = 'submitted' | 'approved';

/**
 * ADR-059 (HR Phase 1) — HR's first FA-01 (`ApprovalEngineService`)
 * consumer. `status` carries only the values HR itself sets directly
 * (`submitted` on creation, `approved` once the linked
 * `approvalRequestId` is approved) — a rejection is never mirrored here;
 * the linked `ApprovalRequest`'s own `state` is authoritative for
 * "rejected," matching this codebase's existing convention (no domain
 * anywhere subscribes to `approval.request.rejected`).
 */
@Entity('hr_leave_requests')
export class LeaveRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  employeeId!: string;

  @Column({ type: 'varchar', length: 32 })
  leaveType!: string;

  @Column({ type: 'date' })
  startDate!: string;

  @Column({ type: 'date' })
  endDate!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'submitted' })
  status!: LeaveRequestStatus;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;
}
