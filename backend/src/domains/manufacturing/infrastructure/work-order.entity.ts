import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-061 §3 — Work Order aggregate root. No `status` column (matches
 * `FISCAL_YEAR_PROCESS`'s own convention) — live lifecycle state is read
 * via `ProcessEngineService.getState(WORK_ORDER_PROCESS, 'WorkOrder', id)`.
 */
@Entity('work_orders')
export class WorkOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  workOrderNumber!: string;

  @Index()
  @Column('uuid')
  finishedProductId!: string;

  @Column({ type: 'int' })
  quantityPlanned!: number;

  /** Running total, updated at each Finished Goods Output (§7). */
  @Column({ type: 'int', default: 0 })
  quantityProduced!: number;

  /** The real (non-WIP) execution warehouse (§3). */
  @Index()
  @Column('uuid')
  warehouseId!: string;

  /**
   * The dedicated WIP sub-warehouse (§6), auto-created on `release`.
   * Null in `draft` — a Work Order that never releases never gets one.
   */
  @Column({ type: 'uuid', nullable: true })
  wipWarehouseId!: string | null;

  /** Org engine WP-C (decision D-C option A) — the work order's branch = the PRODUCTION warehouse's owning branch at creation (stamped, never rewritten); `null` = unassigned / created before the decision. WIP, material issue/return and finished-goods postings carry it. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  branchOrgUnitId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
