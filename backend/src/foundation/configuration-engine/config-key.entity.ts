import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Runtime Configuration Engine — ERP Foundation P2.
 * Contract: architecture/CUSTOMER_CONFIGURATION_ARCHITECTURE.md,
 *           planning/erp-foundation/P2_BLUEPRINT.md §2.1, ADR-023 C5.
 *
 * SEPARATE from the boot `foundation/configuration/` module (which validates
 * `process.env` for the *deployment*). This registers the *installation's
 * business behaviour* keys. The whole table is rebuilt idempotently from
 * code (CORE_CONFIG_KEYS ∪ module manifests) on every boot — a row with no
 * code source is deleted and its values archived (never a secret here).
 */
export type ConfigValueType = 'bool' | 'int' | 'decimal' | 'enum' | 'string' | 'json';
export type ConfigScopeLevel = 'platform' | 'edition' | 'installation' | 'org' | 'user';

@Entity('config_keys')
export class ConfigKey {
  /** '<module_code>.<setting>' or 'core.<area>.<setting>'. */
  @PrimaryColumn({ type: 'varchar', length: 160 })
  key!: string;

  /** A ModuleCode: 'core' | 'sales' | 'inventory' | 'logistics' | 'finance' | 'reporting'. */
  @Column({ type: 'varchar', length: 32 })
  ownerModule!: string;

  @Column({ type: 'varchar', length: 16 })
  valueType!: ConfigValueType;

  /** enum -> ["a","b"]; int/decimal -> {"min":n,"max":n}; else null. */
  @Column({ type: 'jsonb', nullable: true })
  allowed!: readonly unknown[] | { min: number; max: number } | null;

  /** The PLATFORM default, stored as text; coerced on read. */
  @Column({ type: 'text' })
  defaultValue!: string;

  /** Subset of the 5 levels this key MAY be set at. 'platform' is always present. */
  @Column({ type: 'jsonb' })
  scopeLevels!: ConfigScopeLevel[];

  /** Cannot be overridden below 'edition' — user/org/installation levels are skipped by the resolver. */
  @Column({ type: 'boolean', default: false })
  platformLocked!: boolean;

  /** Surfaced in audit + security review. security_sensitive ⟹ platform_locked (unless // JUSTIFIED). */
  @Column({ type: 'boolean', default: false })
  securitySensitive!: boolean;

  /** valueType MUST be 'bool' when true. */
  @Column({ type: 'boolean', default: false })
  isFeatureFlag!: boolean;

  @Column({ type: 'varchar', length: 128 })
  titleCode!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Required when isFeatureFlag. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  flagOwner!: string | null;

  /** Required when isFeatureFlag. A flag past this date still referenced in code is a Finding. */
  @Column({ type: 'date', nullable: true })
  flagRemoveBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
