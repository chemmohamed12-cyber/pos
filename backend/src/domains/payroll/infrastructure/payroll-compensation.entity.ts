import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * ADR-070 §4/§B — the effective-dated compensation record. New row per
 * change, never mutated in place — the same discipline `CustomerAssignment`
 * and `ADR-068 §E`'s Commission Policy already use. A salary change never
 * rewrites a prior period's history: a `PayrollRunLine` for a past period
 * still reflects the compensation that was effective then.
 */
@Entity('payroll_compensations')
export class PayrollCompensation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'timestamptz' })
  effectiveFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  effectiveTo!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'superseded';

  @Column('uuid')
  createdByUserId!: string;

  /** Why the compensation changed (required for every change made after the gap-closure release; null on legacy rows). */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
