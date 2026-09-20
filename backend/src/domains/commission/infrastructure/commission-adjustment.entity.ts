import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CommissionAdjustmentKind } from '../domain/commission-status';

/** ADR-068 §H, mirrors `PayrollAdjustment` exactly — the same cross-context immutability rule, `ADR-072 §18`. */
@Entity('commission_adjustments')
export class CommissionAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  originalCommissionResultId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: CommissionAdjustmentKind;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amountDelta!: string;

  @Column('uuid')
  createdByUserId!: string;

  @Column('uuid', { nullable: true })
  approvalRequestId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
