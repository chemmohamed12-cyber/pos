import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { ConnectorStatus } from '../domain/connector-status';

/**
 * External Integrations (Control Center) — CTO directive §9.
 * `connectorType` is a plain validated string (`CONNECTOR_TYPES` in
 * `connector-types.ts`), never a Postgres enum or a QR-specific column
 * set — adding a future connector type (shipping provider, payment
 * gateway) is a code-level registry change, not a migration.
 *
 * `config` holds connector-specific, NON-secret settings only (e.g. the
 * QR Store's `apiUrl`, `externalStoreId`, `systemUserId` — the Daii user
 * whose Scope new QR-sourced customers/orders are assigned under). The
 * pairing credential itself never lives here — see
 * `integration-credential.entity.ts`.
 */
@Entity('integration_connectors')
export class IntegrationConnector {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 32 })
  connectorType!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: ConnectorStatus;

  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  lastConnectedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
