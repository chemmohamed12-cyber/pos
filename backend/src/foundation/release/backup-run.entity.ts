import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BackupTrigger } from './backup-trigger';
import { BackupRunStatus } from './backup-status';

/**
 * Release Center — Phase A (Backup Foundation). One logical backup event
 * — "run the backup now" — which produces up to two `BackupArtifact`
 * rows (database + media, per ADR-020 §1's explicit DB-vs-media split).
 * Kept separate from `BackupArtifact` so a run can be partially
 * successful (e.g. the DB dump succeeds but the media archive fails)
 * without losing the artifact that DID succeed.
 */
@Entity('backup_runs')
export class BackupRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  trigger!: BackupTrigger;

  /** Null for scheduled/system-triggered runs — same nullable-actor convention used throughout this codebase (e.g. `SalesOrder.createdByUserId`). */
  @Column({ type: 'uuid', nullable: true })
  initiatedByUserId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: BackupRunStatus;

  /** The application version this backup was taken FROM — read from package.json at run time, not user-supplied (no version-tracking table exists yet; see Phase A plan notes). */
  @Column({ type: 'varchar', length: 32 })
  sourceAppVersion!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  startedAt!: Date;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
