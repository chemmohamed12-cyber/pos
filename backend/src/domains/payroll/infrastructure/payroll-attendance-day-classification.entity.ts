import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PayrollDayPayImpact, PayrollDayType } from '../domain/payroll-run-status';

/**
 * ADR-070 §4/§9/§C — one row per employee per calendar day inside a
 * `PayrollRun`'s period. The concrete, auditable evidence that a
 * deduction decision was never taken from `AttendanceDay.status` alone:
 * `attendanceStatus` is copied at calculation time (never re-derived
 * later), `dayType` is Payroll's own independent determination, and
 * `unclassified` (the fail-safe when no calendar policy resolves a date)
 * MUST NEVER pair with `payImpact = 'deduction'` — enforced in
 * `PayrollService.calculate`, not just documented here.
 */
@Entity('payroll_attendance_day_classifications')
export class PayrollAttendanceDayClassification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  payrollRunLineId!: string;

  @Column({ type: 'date' })
  calendarDate!: string;

  @Column({ type: 'varchar', length: 16 })
  attendanceStatus!: 'present' | 'absent' | 'on_leave' | 'missing_punch';

  @Column({ type: 'varchar', length: 16 })
  dayType!: PayrollDayType;

  @Column({ type: 'varchar', length: 16 })
  payImpact!: PayrollDayPayImpact;
}
