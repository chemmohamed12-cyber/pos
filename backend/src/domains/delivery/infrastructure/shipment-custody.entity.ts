import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Vehicle Driver Workspace, Stage C / C1 - the per-shipment custody record. Holds NO money (the cash lives in the Treasury custody account and the `collections` rows); it gives every
 * cash-carrying shipment a number, an owner (vehicle + driver + the vehicle's free-text branch at that time) and the expected amount, so collections, expenses and handovers hang off one
 * auditable record. Created lazily by the first collection (never for a shipment without cash) and never edited afterwards.
 */
@Entity('shipment_custodies')
export class ShipmentCustody {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  custodyNumber!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  shipmentId!: string;

  @Column({ type: 'uuid', nullable: true })
  vehicleId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  driverUserId!: string | null;

  /** Copied from the vehicle's free-text branch when the record was opened - NOT a validated organisational reference (D-6). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  branch!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  expectedAmount!: string | null;

  @Column('uuid')
  openedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
