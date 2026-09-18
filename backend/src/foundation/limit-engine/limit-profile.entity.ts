import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Limit Engine — ERP Foundation P5. `LIMIT_INTEGRATION_CONTRACT.md` §2/§4.
 *
 * The configured cap for one `limit_key` (e.g. `sales.max_reps`). **A
 * missing row for a key means unlimited** — fail-open, the one link in
 * the enforcement chain that fails open rather than closed (ADR-023 §3):
 * a limit is a commercial/capacity control, not a security boundary.
 * There is deliberately no `maxValue: null` row to represent "unlimited"
 * — absence of the row already means that; storing a null would just be
 * a second way to express the same state.
 *
 * No `installationId` column: this codebase's `Installation` entity
 * (`foundation/entitlement/installation.entity.ts`) is itself a
 * single-row singleton (ADR-023 §1 — "Tenant collapses to this
 * singleton"), so a limit profile is implicitly scoped to "this
 * installation" already; a second column repeating that would be dead
 * weight, not future-proofing (there is no multi-installation-per-
 * database scenario this schema needs to anticipate).
 */
@Entity('limit_profiles')
export class LimitProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `<module_code>.<thing>`, matches a module manifest's `limit_keys[].key`. Unique — one profile per key. */
  @Column({ type: 'varchar', length: 160, unique: true })
  limitKey!: string;

  /** Which module declared this key (denormalized from the manifest for admin-API grouping/display; not used in resolution). */
  @Column({ type: 'varchar', length: 32 })
  moduleCode!: string;

  /** Denormalized from the manifest's `LimitKeyMeta.unit` — determines `LimitUsageCounter` period-bucketing in `LimitService` ('count'/'bytes' => one flat counter; 'per_month'/'per_day' => one counter per calendar period). */
  @Column({ type: 'varchar', length: 16 })
  unit!: 'count' | 'per_month' | 'per_day' | 'bytes';

  /** The cap. Always a real number when a row exists — see the class doc comment for why "unlimited" is row-absence, not a nullable column. */
  @Column({ type: 'int' })
  maxValue!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
