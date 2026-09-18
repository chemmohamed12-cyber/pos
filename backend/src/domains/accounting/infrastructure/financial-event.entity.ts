import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { FinancialEventStatus } from '../domain/journal';

/**
 * F03 — Financial Event Engine (Blueprint §3.3, ADR-035 D2/D5/D6/D7). The
 * accounting-owned landing record for a business event consumed from the
 * Transactional Outbox — idempotency anchor + full traceability to the
 * source domain/entity. A NEW entity, not an extension of F01's
 * `ProcessedEvent` (ADR-035 D5): it carries payload version, lifecycle
 * status, the resulting journal entry, and a rejection reason that
 * `ProcessedEvent` deliberately does not.
 *
 * `UNIQUE(idempotencyKey)` IS the concurrency control (ADR-035 D6) — a
 * redelivered event's INSERT fails, is caught, and the existing
 * `journalEntryId` is returned; never a second posting.
 */
@Entity('accounting_financial_events')
export class FinancialEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'varchar', length: 32 })
  sourceDomain!: string;

  @Column({ type: 'varchar', length: 64 })
  sourceEntityType!: string;

  @Column({ type: 'varchar', length: 64 })
  sourceEntityId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'date' })
  businessDate!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'varchar', length: 3 })
  transactionCurrencyCode!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  payloadVersion!: number;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'RECEIVED' })
  status!: FinancialEventStatus;

  @Column({ type: 'uuid', nullable: true })
  journalEntryId!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;
}
