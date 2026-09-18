import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Cash collection at delivery is a first-class record (blueprint §28), never just a boolean on the order. */
@Entity('collections')
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  shipmentId!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 32 })
  method!: string;

  @Column('uuid')
  collectorUserId!: string;

  /**
   * CTO directive ("يجب أن يكون لدينا أساس واضح لتسجيل أن المبلغ
   * مستحق/تم تحصيله/تم توريده" — clear basis to record due/collected/
   * remitted): the missing "has this cash actually reached Treasury yet"
   * signal. Simple two-state, not the Process Engine — same judgment
   * call already made for Deposit/Treasury statuses (binary, no
   * multi-actor task workflow to model).
   */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  remittanceStatus!: 'pending' | 'remitted';

  @Column({ type: 'timestamptz', nullable: true })
  remittedAt!: Date | null;

  /**
   * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §6/§7) — the custody
   * flow is now TWO Treasury legs, not one: money is posted into the
   * custodian's Custody account THE MOMENT it's collected (this field —
   * the shipment's vehicle custody account if assigned, else its
   * shipping company's), then later moved out via `transfer` at
   * remittance time (`treasuryTransactionId` below). `null` only when
   * the shipment had no vehicle/company custodian at all (a plain
   * in-house driver delivery) — that case has no custody leg, only the
   * later settlement leg.
   */
  @Column({ type: 'uuid', nullable: true })
  custodyAccountId!: string | null;

  /** The `cash_in` Treasury transaction posted into `custodyAccountId` at collection time. */
  @Column({ type: 'uuid', nullable: true })
  custodyTransactionId!: string | null;

  /**
   * The settlement-leg Treasury transaction (the `transfer_out` row moving
   * money OUT of custody into the custodian's real settlement account) —
   * or, for a custodian-less collection, the plain `cash_in` transaction
   * straight into the account the caller supplied. The concrete
   * Collection→Treasury link, never re-derived, never guessed.
   */
  @Column({ type: 'uuid', nullable: true })
  treasuryTransactionId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
