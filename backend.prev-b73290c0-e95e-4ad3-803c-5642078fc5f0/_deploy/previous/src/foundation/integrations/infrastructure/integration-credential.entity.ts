import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * External Integrations — the pairing credential, kept in its own table
 * (never on `IntegrationConnector` itself) so a plain `GET` on the
 * connector can never accidentally leak it (CTO directive §11: "never
 * returned in plaintext after initial setup"). `encryptedValue` is
 * AES-256-GCM ciphertext (`CredentialCipherService`) — the plaintext
 * pairing token/API key is held in memory only for the duration of the
 * pairing/rotation call and never persisted or logged. Only the active
 * (non-revoked) row for a connector is ever used for outbound calls;
 * revoked rows are kept for audit history, never deleted.
 */
@Entity('integration_credentials')
export class IntegrationCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  connectorId!: string;

  @Column({ type: 'text' })
  encryptedValue!: string;

  @Column({ type: 'boolean', default: false })
  revoked!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
