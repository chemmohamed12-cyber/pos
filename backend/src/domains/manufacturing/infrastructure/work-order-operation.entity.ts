import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type WorkOrderOperationStatus = 'pending' | 'in_progress' | 'completed';

/**
 * ADR-061 Addendum 1 (A1) — release-time snapshot of the finished product's active routing
 * (authoritative for this Work Order even if the routing is later edited, same rule as
 * `WorkOrderComponent`, ADR-061 §2). Execution state only: no hours, rates or cost.
 */
@Entity('work_order_operations')
@Index(['workOrderId', 'sequence'], { unique: true })
export class WorkOrderOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  workOrderId!: string;

  @Column({ type: 'int' })
  sequence!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Index()
  @Column('uuid')
  workCenterId!: string;

  @Column({ type: 'varchar', length: 32 })
  workCenterCode!: string;

  @Column({ type: 'varchar', length: 255 })
  workCenterName!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: WorkOrderOperationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  startedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  completedByUserId!: string | null;
}
