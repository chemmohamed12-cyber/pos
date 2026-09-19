import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { AttendanceDayStatus } from '../domain/attendance-day-status';

/**
 * ADR-065 §3/§5 — one row per `(employeeId, calendarDate)`. `status` has
 * exactly four values (`ADR-063 §1: C` + `§7: B`) — `late`/
 * `early_departure`/`holiday` do not exist. `hoursWorked` is a bare
 * decimal fact (`ADR-063 §2: B`) — never a rate, never an amount.
 * `checkIn`/`checkOut` are the day's earliest/latest punch (`ADR-063
 * §5: A`, first-in/last-out span) with zero rounding (`§6: A`).
 *
 * A correction mutates this row directly (`correctedByUserId`/
 * `correctedAt`) rather than versioning a new row — `AuditService`'s own
 * before/after record is the historical trail, the same shape
 * `HrService.editEmployee` (ADR-059) already uses for a direct,
 * permission-gated edit. No separate version-chain column is kept.
 */
@Entity('attendance_days')
@Index(['employeeId', 'calendarDate'], { unique: true })
export class AttendanceDay {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  employeeId!: string;

  @Column({ type: 'date' })
  calendarDate!: string;

  @Column({ type: 'timestamptz', nullable: true })
  checkIn!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkOut!: Date | null;

  @Column({ type: 'numeric', precision: 8, scale: 4, nullable: true })
  hoursWorked!: string | null;

  @Column({ type: 'varchar', length: 16 })
  status!: AttendanceDayStatus;

  @Index()
  @Column('uuid', { nullable: true })
  batchId!: string | null;

  @Column('uuid', { nullable: true })
  correctedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  correctedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
