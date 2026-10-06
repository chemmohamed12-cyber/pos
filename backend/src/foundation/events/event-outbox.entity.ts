import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** `processing` = a Company-outbox row currently leased by a dispatcher; `skipped` = Company-outbox row whose topic has only ambient-scope subscribers (ADR-075). */
export type OutboxStatus = 'pending' | 'processing' | 'dispatched' | 'failed' | 'skipped';

/**
 * Events — Stage 2 build-order item 12.
 * Daii/architecture/DAII_EVENT_ARCHITECTURE.md §2, ADR-012.
 *
 * The outbox row is written in the SAME transaction as the domain state
 * change that produced it (caller passes its own EntityManager to
 * EventBusService.publish) — this is what makes "never advertise a fact
 * the database didn't durably commit first" true, closing the gap
 * RMS's in-memory-only event bus and xnexus-website's file-I/O-dependent
 * atomicity both left open (Daii/_source-audits/).
 */
@Entity('event_outbox')
@Index(['status'])
export class EventOutbox {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 128 })
  topic!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  schemaVersion!: number;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  dispatchedAt!: Date | null;
}
