import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ReleasePackageType, ReleaseStatus } from './release-status';
import { ReleaseManifest } from './release-manifest';

/**
 * Release Center — Phase C (foundation slice). One release/deployment
 * event — the "what version, what's in it, is it safe to deploy yet"
 * record. `backupRunId` is the CTO directive's central safety rule made
 * literal: "No Verified Backup -> No Deployment", and the backup must be
 * "مرتبطًا بالـRelease نفسه، وليس مجرد Backup قديم" (tied to THIS
 * release specifically, not just some old backup sitting on the server)
 * — `ReleaseManagerService.checkDeploymentGate` is the one place that
 * rule is enforced, checked against exactly this column, not "any
 * verified backup exists somewhere."
 */
@Entity('releases')
export class Release {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  version!: string;

  @Column({ type: 'varchar', length: 8 })
  packageType!: ReleasePackageType;

  @Column({ type: 'varchar', length: 32, nullable: true })
  baseVersion!: string | null;

  @Column({ type: 'jsonb' })
  manifest!: ReleaseManifest;

  @Column({ type: 'varchar', length: 64 })
  manifestChecksum!: string;

  @Column({ type: 'varchar', length: 24 })
  status!: ReleaseStatus;

  @Column('uuid')
  uploadedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  uploadedAt!: Date;

  /** The verified backup this specific release is gated on — CTO directive's "backup tied to the release itself" requirement. Null until `linkVerifiedBackup` succeeds. */
  @Column({ type: 'uuid', nullable: true })
  backupRunId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
