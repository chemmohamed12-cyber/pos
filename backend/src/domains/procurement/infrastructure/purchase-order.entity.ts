import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * No `status` column — same discipline as `Shipment` (see
 * `purchase-order-process.ts`'s doc comment): the Process Engine is the
 * single source of truth, read via `ProcessEngineService.getState`.
 * `totalAmountBase` is server-computed and re-saved on every line
 * mutation, mirroring `SalesOrder.totalAmount` (never client-supplied,
 * never allowed to drift).
 */
@Entity('purchase_orders')
export class PurchaseOrder {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  poNumber!: string;

  @Index()
  @Column('uuid')
  supplierId!: string;

  @Index()
  @Column('uuid')
  warehouseId!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  totalAmountBase!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  /** ADR-048 Path B traceability — set only when this PO was created by `RfqService`'s award flow (never client-settable). Null = Path A (Direct Purchase Order). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  sourceRfqId!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
