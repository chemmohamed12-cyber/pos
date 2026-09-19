import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AttendancePunchType, AttendanceSourceType } from '../domain/attendance-day-status';

/**
 * ADR-065 §3 — write-once. Never updated after insert, exactly like
 * `IntegrationSyncLog` (`ADR-062 §0`) — evidence, not a working copy. A
 * correction never touches this table; it only ever adds a new
 * `AttendanceDay`-level correction (see `AttendanceCorrectionRequest`
 * and `AttendanceDay.correctionOf`).
 *
 * `resolvedEmployeeId: null` is a real, expected, non-error state — an
 * unmapped device reference is preserved and surfaced, never dropped
 * (`ADR-062 §5`).
 */
@Entity('attendance_raw_records')
@Index(['resolvedEmployeeId', 'punchTimestamp'])
export class AttendanceRawRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  sourceType!: AttendanceSourceType;

  @Column('uuid', { nullable: true })
  sourceConnectorId!: string | null;

  @Index()
  @Column('uuid', { nullable: true })
  importBatchId!: string | null;

  @Column({ type: 'varchar', length: 128 })
  deviceEmployeeRef!: string;

  @Index()
  @Column('uuid', { nullable: true })
  resolvedEmployeeId!: string | null;

  @Column({ type: 'timestamptz' })
  punchTimestamp!: Date;

  @Column({ type: 'varchar', length: 16 })
  punchType!: AttendancePunchType;

  @Column({ type: 'jsonb', nullable: true })
  rawPayload!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  ingestedAt!: Date;

  @Column('uuid', { nullable: true })
  ingestedByUserId!: string | null;
}
