import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Release Center — Execution Layer. One row per migration TypeORM
 * actually ran (or attempted) as part of a specific release deployment —
 * queryable per-migration traceability (name, version window, success),
 * not just a text blob on `Release.errorMessage`. `rollbackRelease`
 * reads these rows, in reverse order, to know exactly which migrations
 * to attempt `undoLastMigration()` against for THIS release only.
 */
@Entity('release_migration_runs')
export class ReleaseMigrationRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  releaseId!: string;

  @Column({ type: 'varchar', length: 255 })
  migrationName!: string;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  success!: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;
}
