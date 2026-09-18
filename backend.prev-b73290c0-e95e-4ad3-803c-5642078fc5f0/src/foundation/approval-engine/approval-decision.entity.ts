import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ApprovalDecisionValue } from './approval-process';

/**
 * FA-01 (contract §3, §5). One checker's individual decision — since
 * `minApprovers` may exceed 1, a request can accumulate several.
 *
 * `UNIQUE(approvalRequestId, approverUserId)` — one decision per checker
 * per request (contract §5.2). This index is also the concurrency
 * control: two racing decisions by the same user → one wins, the other
 * is a caught no-op.
 *
 * The maker ≠ checker invariant (`approverUserId` can never equal the
 * owning request's `makerUserId`, contract §5.1) is enforced by
 * `ApprovalEngineService` before the insert — a throw, not a warning.
 */
@Entity('approval_decisions')
@Index(['approvalRequestId', 'approverUserId'], { unique: true })
export class ApprovalDecision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  approvalRequestId!: string;

  @Column({ type: 'uuid' })
  approverUserId!: string;

  @Column({ type: 'varchar', length: 8 })
  decision!: ApprovalDecisionValue;

  @Column({ type: 'varchar', length: 512, nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  decidedAt!: Date;
}
