import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * F01 — Financial Foundation (Blueprint §3.6). One actual value of a
 * `FinancialDimensionType` (e.g. Cost Center "Sales-Tanta"). `orgUnitId`
 * nullable: a dimension value can itself be scoped (ADR-031), e.g. a Cost
 * Center that only makes sense under one Branch.
 */
@Entity('accounting_financial_dimension_values')
@Index(['dimensionTypeId', 'code'], { unique: true })
export class FinancialDimensionValue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  dimensionTypeId!: string;

  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'uuid', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
