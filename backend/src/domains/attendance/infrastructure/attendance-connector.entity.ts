import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * ADR-065 §3 — mirrors `IntegrationConnector`'s shape (`ADR-062 §7`) as
 * Attendance's OWN table, not a shared table with `foundation/
 * integrations` (that module's `StoreConnectorAdapter` is e-commerce-
 * specific — publishing products — and is a poor semantic fit for a
 * biometric device). Only `'manual'` is a real connector type in this
 * contract; the shape is ready to receive a future
 * `'attendance_device_<vendor>'` entry without a schema change, exactly
 * as `foundation/integrations`' own `CONNECTOR_TYPES` registry works.
 */
@Entity('attendance_connectors')
export class AttendanceConnector {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 32 })
  connectorType!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'connected' | 'disconnected';

  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  lastConnectedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
