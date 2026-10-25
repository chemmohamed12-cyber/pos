import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type PayrollStage = 'prepare' | 'review' | 'acknowledge_exception' | 'submit' | 'approve' | 'disburse' | 'reconcile' | 'close_period';

/**
 * Addendum A-6 — the actor of every material workflow stage, append-only and written in the same transaction as the stage's own effect. The server-side
 * separation-of-duties checks compare against THESE rows, never against anything the client sent. Automated steps use the all-zero service identity.
 */
@Entity('payroll_run_stage_actors')
export class PayrollRunStageActor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  payrollRunId!: string;

  @Column({ type: 'varchar', length: 24 })
  stage!: PayrollStage;

  @Column('uuid')
  userId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at!: Date;
}
