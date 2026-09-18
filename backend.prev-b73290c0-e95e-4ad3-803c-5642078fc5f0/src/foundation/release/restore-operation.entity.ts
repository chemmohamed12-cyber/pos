import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { RestoreOperationStatus } from './restore-status';

/**
 * Release Center — Phase B (Restore). One restore request, from the
 * moment it's preflighted to the moment it's confirmed and executed (or
 * expires unconfirmed). `preflightResult` is a frozen JSON snapshot of
 * what `RestoreManagerService.preflight()` found (backup metadata,
 * checks passed) at preflight time — re-validated again at confirm time
 * rather than blindly trusted, since real time passes between the two
 * steps and the backup file could theoretically change or disappear.
 */
@Entity('restore_operations')
export class RestoreOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  backupRunId!: string;

  @Column({ type: 'varchar', length: 24 })
  status!: RestoreOperationStatus;

  @Column('uuid')
  requestedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'jsonb', nullable: true })
  preflightResult!: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  confirmedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  /** The safety backup taken automatically at confirm time, right before the destructive restore itself — the recovery path if the restore goes wrong. */
  @Column({ type: 'uuid', nullable: true })
  safetyBackupRunId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
