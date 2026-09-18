import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Customer Financial Account / AR (CTO directive) — Customer → Payment → Customer Account → Treasury. Never mutates a balance directly; posts one Treasury `cash_in` and one Customer Ledger `payment` credit entry. */
@Entity('customer_payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  paymentNumber!: string;

  @Index()
  @Column('uuid')
  customerId!: string;

  @Index()
  @Column('uuid')
  invoiceId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 32 })
  method!: string;

  @Column('uuid')
  treasuryAccountId!: string;

  @Column({ type: 'uuid', nullable: true })
  treasuryTransactionId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference!: string | null;

  @Column('uuid')
  recordedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
