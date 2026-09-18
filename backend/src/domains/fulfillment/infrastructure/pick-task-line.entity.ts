import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type PickTaskLineStatus = 'pending' | 'prepared';

/**
 * CTO directive ("PRIORITY: ITEM PREPARATION") — the per-PRODUCT
 * granularity the Pick Task itself never had. One row per active stock
 * reservation belonging to the fulfillment order's sales order, created
 * alongside the Pick Task in `FulfillmentService.createFulfillmentOrder`
 * (mirrors `StockReservation`: same productId/quantity, snapshotted once
 * at creation time — a later Order Edit's quantity change is a separate,
 * already-handled concern, `InventoryService.
 * adjustReservationQuantityInTransaction`, and is not retroactively
 * reflected onto an already-created pick task line).
 */
@Entity('pick_task_lines')
export class PickTaskLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  pickTaskId!: string;

  @Index()
  @Column('uuid')
  fulfillmentOrderId!: string;

  @Index()
  @Column('uuid')
  productId!: string;

  @Column({ type: 'int' })
  requestedQuantity!: number;

  @Column({ type: 'int', default: 0 })
  preparedQuantity!: number;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: PickTaskLineStatus;

  @Column({ type: 'uuid', nullable: true })
  preparedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  preparedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
