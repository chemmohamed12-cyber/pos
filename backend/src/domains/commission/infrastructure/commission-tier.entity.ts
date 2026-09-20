import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** ADR-068 §5/§C — populated only when the owning policy's `rateModel = 'target_tiered'`. Marginal application (ratified): each tier's rate applies only to the portion of the eligible amount within that tier's own band. */
@Entity('commission_tiers')
export class CommissionTier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  policyId!: string;

  @Column({ type: 'int' })
  tierOrder!: number;

  @Column({ type: 'numeric', precision: 5, scale: 2 })
  fromPercent!: string;

  /** Nullable — the open-ended top tier. */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  toPercent!: string | null;

  @Column({ type: 'numeric', precision: 8, scale: 4 })
  rate!: string;
}
