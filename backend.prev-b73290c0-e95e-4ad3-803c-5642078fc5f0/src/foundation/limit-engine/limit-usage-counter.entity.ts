import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Limit Engine — ERP Foundation P5. `LIMIT_INTEGRATION_CONTRACT.md` §2.
 *
 * Live usage against a `limit_key`. `periodStart` is `NULL` for a flat
 * (`unit: 'count'` / `'bytes'`) limit — one counter row for the key's
 * entire lifetime. For a time-windowed limit (`unit: 'per_month'` /
 * `'per_day'`), `periodStart` is the start of the current calendar
 * period (UTC) and a NEW row is created at each period boundary — prior
 * periods' rows are kept (never reset/overwritten), giving a free usage
 * history read-back with no separate reporting table. Postgres treats
 * each NULL as distinct for uniqueness purposes, which is exactly the
 * behavior wanted here: at most one "current" counter row per
 * (key, periodStart) pair, `periodStart IS NULL` included.
 */
@Entity('limit_usage_counters')
@Index('UQ_limit_usage_counters_key_period', ['limitKey', 'periodStart'], { unique: true })
export class LimitUsageCounter {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  limitKey!: string;

  @Column({ type: 'timestamptz', nullable: true })
  periodStart!: Date | null;

  @Column({ type: 'int', default: 0 })
  currentValue!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
