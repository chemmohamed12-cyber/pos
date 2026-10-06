import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Multi-Company Phase 3 V7, Area 3 — the "separate store" V7's Required
 * field demands: "Secrets (password/credentials) held in a separate
 * store — never inline on the Company/identity row." Mirrors the
 * existing `IntegrationCredential` pattern (own table, AES-256-GCM
 * ciphertext, never plaintext at rest) rather than inventing a new
 * mechanism — V7 explicitly leaves "which backend" undecided among
 * {env-scoped vault, existing secrets manager, a new mechanism}; reusing
 * this codebase's own already-running encrypted-table mechanism is a
 * conservative application of an already-decided pattern, not a new
 * architectural choice. `encryptedValue` is an opaque blob — its internal
 * shape (e.g. password only, or a JSON payload) is left to the caller;
 * V7 does not specify it.
 */
@Entity('database_credentials')
export class DatabaseCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK to `database_registries.id`. One credential row per registry — no rotation/history modeled here; not requested by V7 Area 3. */
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  databaseRegistryId!: string;

  @Column({ type: 'text' })
  encryptedValue!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
