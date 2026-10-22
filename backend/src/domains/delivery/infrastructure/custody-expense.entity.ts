import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CustodyExpenseStatus = 'pending_approval' | 'approved' | 'rejected' | 'posted' | 'cancelled';

/**
 * Vehicle Driver Workspace, Stage C / C3 (D-4, D-5) - a claim for money spent out of the cash a driver carries. Prepare (the claimant) is separate from approve (a different person,
 * through the FA-01 approval engine) and from post (an explicit Treasury cash-out). Holds no GL account: the category is a reason code of the company's disbursement posting profile.
 */
@Entity('custody_expenses')
export class CustodyExpense {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  expenseNumber!: string;

  @Index()
  @Column('uuid')
  custodyId!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  shipmentId!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  vehicleId!: string | null;

  /** The custody Treasury account the money is paid out of (the vehicle's), fixed when the claim is made. */
  @Column('uuid')
  custodyAccountId!: string;

  /** A reason code of `accounting.treasury_disbursement_reason_accounts` (prefix `custody_`). */
  @Column({ type: 'varchar', length: 64 })
  category!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column({ type: 'date' })
  incurredOn!: string;

  @Column({ type: 'uuid', nullable: true })
  evidenceAssetId!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'pending_approval' })
  status!: CustodyExpenseStatus;

  @Column('uuid')
  claimedByUserId!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientKey!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  approvalRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  decisionNote!: string | null;

  @Column({ type: 'uuid', nullable: true })
  postedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  treasuryTransactionId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  cancelReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
