import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { BackupOperationStatus } from './backup-operation-status';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 4 freeze, D-Backup-03).
 * The durable ledger for ONE `BackupRun`'s retry state — 1:1 with
 * `BackupRun`, matching that entity's own existing granularity (a run's
 * `status` is already `completed`/`partially_failed`/`failed` as one
 * combined outcome; this ledger tracks retry progress for that same unit,
 * not a finer per-artifact granularity nothing else in this system uses).
 *
 * `companyId` mirrors `BackupRun.companyId`'s own nullability — null for a
 * platform-level backup. No `installationId` column: redundant, always
 * reachable via `Company.installationId` when `companyId` is set, matching
 * how `Membership` also avoids duplicating it.
 */
@Entity('backup_operations')
export class BackupOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  companyId!: string | null;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  backupRunId!: string;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  status!: BackupOperationStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /** Null once terminal (`COMPLETED`, or `FAILED` past the retry cap). */
  @Column({ type: 'timestamptz', nullable: true })
  nextRetryAt!: Date | null;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  correlationId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
