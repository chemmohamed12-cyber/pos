import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * FA-01 (contract §3). One instance of "actor wants to do X to resource Y".
 *
 * No `status` column — live state via
 * `ProcessEngineService.getState(APPROVAL_PROCESS, 'ApprovalRequest', id)`
 * (F01/F02 convention). `resolvedMinApprovers` / `resolvedRequiredNode`
 * are snapshotted from the matched `ApprovalMatrixRule` at submit time
 * for historical accuracy — a later rule edit must not change an
 * in-flight request.
 */
@Entity('approval_requests')
@Index(['requestTypeCode'])
@Index(['makerUserId'])
@Index(['resourceType', 'resourceId'])
export class ApprovalRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  requestTypeCode!: string;

  @Column({ type: 'varchar', length: 64 })
  resourceType!: string;

  @Column({ type: 'varchar', length: 64 })
  resourceId!: string;

  @Column({ type: 'varchar', length: 64 })
  requestedAction!: string;

  /** Snapshot of the proposed change; may carry `amount` for value-threshold resolution. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** The authenticated actor who called `submit` — never client-supplied (contract §6). */
  @Column({ type: 'uuid' })
  makerUserId!: string;

  /** FK-by-value → `process_instances.id` (the `generic_approval_request` instance). */
  @Column({ type: 'uuid', nullable: true })
  processInstanceId!: string | null;

  @Column({ type: 'int' })
  resolvedMinApprovers!: number;

  @Column({ type: 'varchar', length: 255 })
  resolvedRequiredNode!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Set when the request leaves `pending`. */
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;
}
