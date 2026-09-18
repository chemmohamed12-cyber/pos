import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F01 — Financial Foundation (Blueprint §3.4). No `status` column — same
 * live-state-via-ProcessEngine convention as `FiscalYear`. Periods are
 * generated in a batch when a `FiscalYear` is created (monthly by
 * default — `accounting.default_fiscal_year_period_length`), never
 * created one at a time by a user.
 */
@Entity('accounting_fiscal_periods')
export class FiscalPeriod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  fiscalYearId!: string;

  @Column({ type: 'varchar', length: 16 })
  code!: string;

  @Column({ type: 'date' })
  startDate!: string;

  @Column({ type: 'date' })
  endDate!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
