import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F01 — Financial Foundation (Blueprint §3.6). Defines WHAT KINDS of
 * dimension exist (e.g. `'cost_center'`, `'project'`, `'sales_channel'`).
 * This is F01's dimension "attachment mechanism" — attaching actual
 * dimension values to GL postings needs the Journal Line entity (F03),
 * not built here.
 */
@Entity('accounting_financial_dimension_types')
export class FinancialDimensionType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
