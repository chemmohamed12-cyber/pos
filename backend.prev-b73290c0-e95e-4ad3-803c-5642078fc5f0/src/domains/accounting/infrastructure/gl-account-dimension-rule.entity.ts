import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DimensionRuleMode } from '../domain/control-function';

/**
 * F02 — Chart of Accounts (Blueprint §3.2). The Master Plan's "dimension
 * defaults" for F02 — POLICY ONLY. F02 stores it; **F03 applies it at
 * posting time** (`required` present, `blocked` absent, `defaultValueId`
 * pre-filled). Deleting a rule is legitimate (pure config, no financial
 * history) and rides on the `accounting.account.edit` node, not a
 * separate `delete` node (Blueprint §9).
 */
@Entity('accounting_gl_account_dimension_rules')
@Index(['accountId', 'dimensionTypeId'], { unique: true })
export class GLAccountDimensionRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  accountId!: string;

  @Column({ type: 'uuid' })
  dimensionTypeId!: string;

  @Column({ type: 'varchar', length: 10 })
  mode!: DimensionRuleMode;

  /** Pre-filled value; must belong to `dimensionTypeId` and be active. Ignored when `mode = 'blocked'`. */
  @Column({ type: 'uuid', nullable: true })
  defaultValueId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
