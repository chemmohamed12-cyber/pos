import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CommissionApprovalBatchStatus } from '../domain/commission-status';

/** ADR-071 §5 — mirrors `AttendanceApprovalBatch` exactly (`ADR-069 §1`'s own proven shape). */
@Entity('commission_approval_batches')
export class CommissionApprovalBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'date' })
  periodStart!: string;

  @Column({ type: 'date' })
  periodEnd!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: CommissionApprovalBatchStatus;

  @Column('uuid', { nullable: true })
  approvalRequestId!: string | null;

  @Column('uuid')
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;
}
