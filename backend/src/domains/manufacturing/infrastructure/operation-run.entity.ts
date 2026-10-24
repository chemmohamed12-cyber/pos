import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type OperationRunStatus = 'running' | 'completed' | 'skipped';

/** Manufacturing Engine S4 — one run of a process operation on a Work Order (repeatable operations have several, runNo 1..maxRuns). */
@Entity('mfg_operation_runs')
@Index(['workOrderId', 'operationId', 'runNo'], { unique: true })
@Index(['workOrderId', 'operationId', 'requestId'], { unique: true })
export class OperationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  workOrderId!: string;

  @Column('uuid')
  operationId!: string;

  @Column({ type: 'varchar', length: 32 })
  operationCode!: string;

  @Column({ type: 'int' })
  runNo!: number;

  @Column({ type: 'varchar', length: 12, default: 'running' })
  status!: OperationRunStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  startedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  completedByUserId!: string | null;

  @Column({ type: 'varchar', length: 128 })
  requestId!: string;
}

/**
 * Manufacturing Engine S4 — the derived production ledger. `in` = material consumed by a run (carries the material value at the order's WIP unit cost); `out` = quantity a
 * run yielded (intermediate or final). Append-only; the per-operation WIP view is computed from these rows, physical WIP remains one sub-warehouse per order (D-ME-3).
 */
@Entity('mfg_operation_flows')
@Index(['runId', 'direction', 'productId', 'requestId'], { unique: true })
export class OperationFlow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  runId!: string;

  @Index()
  @Column('uuid')
  workOrderId!: string;

  @Column('uuid')
  operationId!: string;

  @Column({ type: 'varchar', length: 3 })
  direction!: 'in' | 'out';

  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  valueBase!: string;

  @Column({ type: 'varchar', length: 128 })
  requestId!: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
