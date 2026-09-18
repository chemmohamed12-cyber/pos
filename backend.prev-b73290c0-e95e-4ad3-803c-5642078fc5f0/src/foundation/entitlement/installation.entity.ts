import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { EntitlementManifest } from './manifest.type';

/**
 * Entitlement Engine — ERP Foundation P3. THE SINGLE ROW that identifies this
 * installation + its current Edition (ADR-023 §1 — "Tenant" collapses to this
 * singleton). P3_BLUEPRINT.md §1.1.
 *
 * Written by the operator `POST /admin/entitlement/apply` endpoint (which
 * P6's deploy step calls). Absent + ENTITLEMENT_MODE=unlicensed-full => an
 * implicit DAII_STANDARD edition, so the current product runs unchanged.
 */
export type InstallationStatus = 'active' | 'suspended' | 'expired';
export type VerificationState = 'verified' | 'unlicensed' | 'invalid';

/** The one allowed primary-key value — enforced app-side + by a partial unique index. */
export const INSTALLATION_SINGLETON_ID = 'installation';

@Entity('installation')
export class Installation {
  @PrimaryColumn({ type: 'varchar', length: 32, default: INSTALLATION_SINGLETON_ID })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  installationId!: string;

  @Column({ type: 'varchar', length: 255 })
  customerName!: string;

  @Column({ type: 'varchar', length: 32 })
  editionCode!: string;

  @Column({ type: 'varchar', length: 32 })
  editionVersion!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: InstallationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  termStart!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  termEnd!: Date | null;

  @Column({ type: 'int', default: 0 })
  graceDays!: number;

  @Column({ type: 'jsonb' })
  entitlementManifest!: EntitlementManifest;

  @Column({ type: 'varchar', length: 128, nullable: true })
  manifestSignature!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  manifestKid!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  appliedAt!: Date;

  /** Monotonic — moved forward on every successful verification (D3C-4 clock-rollback guard). */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastTrustedAt!: Date;

  @Column({ type: 'varchar', length: 16, default: 'unlicensed' })
  verificationState!: VerificationState;
}
