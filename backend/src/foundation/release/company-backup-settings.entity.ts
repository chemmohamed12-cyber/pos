import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 3 freeze, D-Backup-02).
 * Deliberately its own narrow table — not a column on `Company` (keeps
 * backup policy out of Company's core identity fields) and not a column
 * on `DatabaseRegistry` (whose own doc comment already scopes it narrowly
 * to `{host, port, database name, status}`; overloading it with backup
 * policy would repeat exactly the "don't widen a narrow-purpose table"
 * pattern this codebase has consistently avoided elsewhere — e.g. Area 3
 * deliberately keeping credentials out of the registry row itself).
 *
 * One row per Company that has an explicit retention override. A Company
 * with no row here uses the Installation-wide default
 * (`AppConfigService.releaseBackup.retentionDays`) unchanged — this table
 * is additive, not a replacement for that existing config.
 */
@Entity('company_backup_settings')
export class CompanyBackupSettings {
  @PrimaryColumn('uuid')
  companyId!: string;

  /** Null = no override, use the Installation-wide default. */
  @Column({ type: 'int', nullable: true })
  retentionDaysOverride!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
