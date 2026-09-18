import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** ADR-048 — Path B origin document. No `status` column — same discipline as `PurchaseOrder`/`Shipment`. */
@Entity('purchase_requests')
export class PurchaseRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  prNumber!: string;

  @Index()
  @Column('uuid')
  warehouseId!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @Column('uuid')
  requestedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
