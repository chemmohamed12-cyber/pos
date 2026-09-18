import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DepositStatus } from '../domain/deposit-status';

/** Owned by Deposit Control only — no other domain writes this table (Cross-Domain Rule). */
@Entity('deposits')
export class Deposit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  salesOrderId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 32 })
  method!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'uuid', nullable: true })
  evidenceMediaAssetId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'submitted' })
  status!: DepositStatus;

  @Column('uuid')
  submittedByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  reviewedByUserId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
