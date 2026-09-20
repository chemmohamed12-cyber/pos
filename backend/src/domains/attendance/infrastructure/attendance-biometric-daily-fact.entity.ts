import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * CTO directive (2026-09-20) — "Update Biometric Import Contract to Match
 * Actual Device Daily Report." The confirmed real biometric export is a
 * Daily Attendance Summary (one row per employee per day: AC-No., Name,
 * Date, On duty, Off duty, Clock In, Clock Out, Late, Early, Absent, OT
 * Time), not a raw punch-log. This is a NEW entity rather than an
 * extension of `AttendanceRawRecord` for one specific reason: a day with
 * `Absent = True` and blank Clock In/Clock Out must derive zero punch
 * records (so the existing, ratified `deriveDay` first-in/last-out rule
 * naturally yields `status = 'absent'`, unchanged) — but the directive
 * also requires that exact day's source facts (Late/Early/Absent/OT Time,
 * On duty/Off duty) to remain queryable for audit ("expose the reconciled
 * attendance result and its source/audit trail"). A raw record can't hold
 * that without corrupting the punch-count-based derivation; this table
 * can, because `deriveDay` never reads it.
 *
 * `On duty`/`Off duty` are the device's *scheduled* duty window — stored
 * as plain HH:mm strings, deliberately never combined into a `Date`
 * timestamp, so nothing downstream can mistake them for actual attendance
 * (directive §3: "must NOT be treated as actual attendance timestamps").
 * `Late`/`Early`/`otTime` are opaque source facts (directive §7) — never
 * parsed into a payable amount or a deduction anywhere in this module.
 *
 * Unique on `(deviceUserRef, calendarDate)` — the "same Employee/AC-No. +
 * Date" idempotency key the directive names (§9): a re-import upserts
 * this one row in place rather than creating a duplicate.
 */
@Entity('attendance_biometric_daily_facts')
@Index(['deviceUserRef', 'calendarDate'], { unique: true })
export class AttendanceBiometricDailyFact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid', { nullable: true })
  importBatchId!: string | null;

  /** The biometric AC-No. — authoritative identity for this import (directive §2). Never the employee name. */
  @Column({ type: 'varchar', length: 128 })
  deviceUserRef!: string;

  /** The device's "Name" column — informational/source data only, never used for matching (directive §2). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceName!: string | null;

  @Column({ type: 'date' })
  calendarDate!: string;

  @Index()
  @Column('uuid', { nullable: true })
  resolvedEmployeeId!: string | null;

  /** Optional connector this row resolved through, if any — informational only; resolution itself matches by `deviceUserRef` alone (mirrors how Excel-sourced raw records already resolve connector-agnostically). */
  @Column('uuid', { nullable: true })
  sourceConnectorId!: string | null;

  /** Scheduled duty window (HH:mm strings) — never a real timestamp (directive §3). */
  @Column({ type: 'varchar', length: 8, nullable: true })
  onDuty!: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  offDuty!: string | null;

  /** The device's own reported Clock In/Out (HH:mm) — kept here as the original source string; the actual punch timestamp derived from it lives on `AttendanceRawRecord`, per `deriveDay`. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  clockIn!: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  clockOut!: string | null;

  /** Opaque device-computed facts (directive §7) — never converted into a deduction/payable amount anywhere in this module. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  lateValue!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  earlyValue!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  otTimeValue!: string | null;

  /** Normalized True/False/blank from the source "Absent" column (directive §4) — a fact only; never consumed as a payroll deduction signal (directive §5). */
  @Column({ type: 'boolean', nullable: true })
  sourceAbsent!: boolean | null;

  /** The full original row, exactly as `AttendanceRawRecord.rawPayload` already preserves for excel_import — the audit/source trail (directive §4/§6). */
  @Column({ type: 'jsonb' })
  rawPayload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  ingestedAt!: Date;

  @Column('uuid', { nullable: true })
  ingestedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;
}
