/**
 * ADR-065 §0/§5 — ratified `ADR-063 §1: C` (no late/early calculation)
 * and `§7: B` (holiday/weekend calendar deferred) together fix this to
 * exactly four values. `late`/`early_departure`/`holiday` do not exist
 * here by design — adding them back is a policy reopening, not a bug fix.
 */
export type AttendanceDayStatus = 'present' | 'absent' | 'on_leave' | 'missing_punch';

export type AttendancePunchType = 'in' | 'out' | 'unknown';

/**
 * `'biometric'` — added for the confirmed real device Daily Attendance
 * Summary format (CTO directive, 2026-09-20). Purely a new *source*
 * label for `AttendanceRawRecord`/`AttendanceImportBatch` provenance —
 * it carries no new derivation behavior and does not touch
 * `AttendanceDayStatus` above. A biometric-sourced raw record still only
 * ever contributes an 'in'/'out' punch exactly like any other source; the
 * device's own Late/Early/Absent/OT facts are preserved separately on
 * `AttendanceBiometricDailyFact` for audit/display only, never fed into
 * this derivation.
 */
export type AttendanceSourceType = 'manual' | 'excel_import' | 'api' | 'biometric';
