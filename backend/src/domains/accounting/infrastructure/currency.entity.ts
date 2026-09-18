import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CurrencyRoundingMode } from '../domain/currency-rounding-mode';

/**
 * F01 — Financial Foundation (Blueprint §3.1). `code` (ISO 4217) is the
 * primary key — a currency has no separate surrogate id, it IS its code.
 * Exactly one row may have `isBaseCurrency = true` — enforced at the
 * service layer (`CurrencyService.setBaseCurrency`), not by a DB
 * constraint alone (Postgres has no native "exactly one true" check).
 * The base-currency row is also referred to as the Functional Currency
 * throughout this module — same row, two names in common use.
 */
@Entity('accounting_currencies')
export class Currency {
  @PrimaryColumn({ type: 'varchar', length: 3 })
  code!: string;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'varchar', length: 8 })
  symbol!: string;

  @Column({ type: 'int', default: 2 })
  decimalPlaces!: number;

  @Column({ type: 'varchar', length: 16, default: 'half_up' })
  roundingMode!: CurrencyRoundingMode;

  /** `null` = round to `decimalPlaces` only, no extra increment rounding (e.g. cash rounding to 0.05). */
  @Column({ type: 'numeric', precision: 18, scale: 8, nullable: true })
  roundingIncrement!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false })
  isBaseCurrency!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
