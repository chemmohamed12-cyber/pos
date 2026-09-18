import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F01 — Financial Foundation (Blueprint §3.2). One row per currency/date —
 * a later rate for the same currency/date is a NEW row, never an update
 * (never-edit-financial-history principle, applied here even though this
 * table has no posting semantics yet). `rate` is always "1 unit of
 * `currencyCode` = `rate` units of the base/functional currency," fixed
 * direction — there is no row for the base currency against itself.
 */
@Entity('accounting_exchange_rates')
@Index(['currencyCode', 'rateDate'])
export class ExchangeRate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 3 })
  currencyCode!: string;

  @Column({ type: 'date' })
  rateDate!: string;

  @Column({ type: 'numeric', precision: 18, scale: 8 })
  rate!: string;

  @Column({ type: 'varchar', length: 16, default: 'manual' })
  rateSource!: 'manual' | 'api';

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
