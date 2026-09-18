import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Blueprint §26 — Waybill/Tracking. Append-only, in addition to (not a
 * replacement for) Process Engine's own transition history: this table
 * carries free-form tracking detail (a driver note, a GPS ping, a
 * carrier-provided status string) that isn't itself a state transition.
 */
@Entity('tracking_events')
export class TrackingEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  shipmentId!: string;

  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  detail!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
