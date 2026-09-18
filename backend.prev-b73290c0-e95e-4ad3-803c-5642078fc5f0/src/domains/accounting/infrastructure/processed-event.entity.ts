import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F01 — Financial Foundation (Blueprint §16). Idempotency infrastructure
 * for the future Financial Event Engine (F03 onward) — a redelivered
 * event (e.g. `deposit.verified`) must never double-post. Any future
 * consumer checks-and-inserts here, inside the SAME transaction as its
 * own write, before acting. Zero business logic; touches no existing
 * domain. F01 has no event consumer of its own yet — this table has no
 * caller in F01 itself, only the shared mechanism every future F0n
 * consumer will use rather than each inventing its own.
 */
@Entity('accounting_processed_events')
@Index(['eventType', 'eventIdempotencyKey'], { unique: true })
export class ProcessedEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  eventType!: string;

  @Column({ type: 'varchar', length: 255 })
  eventIdempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  processedAt!: Date;

  @Column({ type: 'jsonb', nullable: true })
  resultSummary!: Record<string, unknown> | null;
}
