import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CommissionBasis, CommissionPolicyScope, CommissionRateModel } from '../domain/commission-status';

/**
 * ADR-068 §1/§2/§3/§A — effective-dated, new row per change, never
 * mutated in place — the same discipline `CustomerAssignment` already
 * uses. `scopeRefId`'s meaning depends on `scope`: an `Employee.id` for
 * `sales_rep` (never a `User.id` — ADR-068 §G), a `Customer.id` for
 * `customer`, or a Customer Group id for `customer_group` (architecturally
 * supported; functionally inert until CRM provides a structured Customer
 * Group concept — ADR-071 §3/§21, not solved here).
 */
@Entity('commission_policies')
export class CommissionPolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  scope!: CommissionPolicyScope;

  @Index()
  @Column('uuid')
  scopeRefId!: string;

  @Column({ type: 'varchar', length: 20 })
  basis!: CommissionBasis;

  @Column({ type: 'varchar', length: 16 })
  rateModel!: CommissionRateModel;

  /** Used only when `rateModel = 'flat'`. */
  @Column({ type: 'numeric', precision: 8, scale: 4, nullable: true })
  flatRate!: string | null;

  @Column({ type: 'timestamptz' })
  effectiveFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'superseded';

  @Column('uuid')
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
