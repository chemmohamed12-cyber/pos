import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Vehicle Driver Workspace, Stage C / C2 (D-1) - an append-only per-line delivery event: how many units of ONE shipment line the driver handed to the customer (`delivered`) or
 * brought back (`returned`). Never updated or deleted; a correction is a new event. It is an operational record only - no shipment state, no stock, no accounting entry.
 */
@Entity('shipment_line_deliveries')
export class ShipmentLineDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  shipmentId!: string;

  @Index()
  @Column('uuid')
  shipmentLineId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'delivered' | 'returned';

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column('uuid')
  recordedByUserId!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientKey!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt!: Date;
}
