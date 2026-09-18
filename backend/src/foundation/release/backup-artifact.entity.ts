import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BackupArtifactStatus, BackupArtifactType } from './backup-status';

/**
 * Release Center — Phase A (Backup Foundation). One physical backup
 * file (a `pg_dump` archive or a `tar.gz` of `MEDIA_STORAGE_PATH`),
 * belonging to a `BackupRun`. `checksumSha256` + `sizeBytes` are recorded
 * at creation time and re-checked by `BackupManagerService.verifyBackup`
 * — the CTO directive's explicit "a backup must not be considered valid
 * simply because the file was created" requirement.
 */
@Entity('backup_artifacts')
export class BackupArtifact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  backupRunId!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: BackupArtifactType;

  /** Relative to AppConfigService.releaseBackup.storagePath — never an absolute host path, so the storage root can move without rewriting every row. */
  @Column({ type: 'varchar', length: 512 })
  filePath!: string;

  @Column({ type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'varchar', length: 64 })
  checksumSha256!: string;

  @Column({ type: 'varchar', length: 24 })
  status!: BackupArtifactStatus;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
