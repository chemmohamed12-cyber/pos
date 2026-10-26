import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CustodyHandoverStatus = 'declared' | 'confirmed' | 'rejected';

/**
 * Vehicle Driver Workspace, Stage C / C4 - the driver declares he handed `amount` of cash to the cashier; someone else confirms (or rejects) it. Operational record only: it moves no
 * money and posts nothing (remittance of each collection stays the only settlement + GL trigger).
 */
@Entity('custody_handovers')
export class CustodyHandover {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  handoverNumber!: string;

  @Index()
  @Column('uuid')
  vehicleId!: string;

  @Column('uuid')
  driverUserId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'declared' })
  status!: CustodyHandoverStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientKey!: string | null;

  @Column({ type: 'uuid', nullable: true })
  confirmedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
