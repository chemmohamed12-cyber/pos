import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SyncDirection = 'outbound' | 'inbound';
export type SyncLogStatus = 'success' | 'failed' | 'skipped_duplicate';

/**
 * External Integrations — visibility (CTO directive §20: "Integration
 * status/log visibility") AND idempotency (§16: "An identical QR order
 * must never create multiple Daii Sales Orders"). `externalReference` is
 * the idempotency key for inbound events (e.g. QR's own order id) —
 * `IntegrationsService.receiveOrder` checks for an existing
 * `success`/`skipped_duplicate` row with the same
 * (connectorId, eventType, externalReference) BEFORE doing any writes.
 */
@Entity('integration_sync_logs')
@Index(['connectorId', 'eventType', 'externalReference'])
export class IntegrationSyncLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  connectorId!: string;

  @Column({ type: 'varchar', length: 16 })
  direction!: SyncDirection;

  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  externalReference!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: SyncLogStatus;

  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
