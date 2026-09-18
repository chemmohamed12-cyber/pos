import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ConfigScopeLevel } from './config-key.entity';

/**
 * Runtime Configuration Engine — ERP Foundation P2. The ONLY user-writable
 * table. planning/erp-foundation/P2_BLUEPRINT.md §2.2.
 *
 * A value is stored as text and validated (type + range/enum + scope) on
 * write AND coerced on read. `scope_id` is NULL for the singleton scopes
 * ('platform', 'installation'); it is the edition_code / org_unit_id /
 * user_id for the others.
 */
@Entity('config_values')
@Index('IDX_config_values_key_active', ['key'], { where: '"archivedAt" IS NULL' })
@Index('IDX_config_values_scope', ['scopeType', 'scopeId'])
@Index('UQ_config_values_key_scope', ['key', 'scopeType', 'scopeId'], { unique: true, where: '"archivedAt" IS NULL' })
export class ConfigValue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  key!: string;

  @Column({ type: 'varchar', length: 16 })
  scopeType!: ConfigScopeLevel;

  @Column({ type: 'varchar', length: 128, nullable: true })
  scopeId!: string | null;

  @Column({ type: 'text' })
  value!: string;

  @Column({ type: 'uuid', nullable: true })
  setByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  setAt!: Date;

  /** Set (never hard-deleted) when the key leaves the code registry. Excluded from resolution. */
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;
}
