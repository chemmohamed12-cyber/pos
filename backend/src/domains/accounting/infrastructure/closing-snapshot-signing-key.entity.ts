import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * ADR-051 §9/§10 (Month-End Closing / Black Box, Phase 1). Append-only
 * registry of every Ed25519 public key ever used to sign a Closing
 * Snapshot manifest — never a single "current key." A snapshot's manifest
 * names the exact `kid` that signed it (ADR-051 §8); verification always
 * looks that `kid` up here, never "whichever key is active today," so
 * rotating the key never invalidates anything already written (ADR-051
 * §10). No delete path is exposed anywhere in the application for this
 * entity — the same append-only discipline `audit_records` already
 * follows.
 *
 * The PRIVATE key is never stored here or anywhere in the database — it
 * lives only in `CLOSING_SNAPSHOT_SIGNING_PRIVATE_KEY` (ADR-051 §9),
 * exactly like `JWT_ACCESS_SECRET`.
 */
@Entity('accounting_closing_snapshot_signing_keys')
export class ClosingSnapshotSigningKey {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  kid!: string;

  /** SPKI, DER, base64. */
  @Column({ type: 'varchar', length: 256 })
  publicKey!: string;

  @Column({ type: 'timestamptz' })
  validFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  validUntil!: Date | null;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @Column({ type: 'varchar', length: 256 })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
