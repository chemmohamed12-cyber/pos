/**
 * ADR-065 §0/§5 — ratified `ADR-063 §1: C` (no late/early calculation)
 * and `§7: B` (holiday/weekend calendar deferred) together fix this to
 * exactly four values. `late`/`early_departure`/`holiday` do not exist
 * here by design — adding them back is a policy reopening, not a bug fix.
 */
export type AttendanceDayStatus = 'present' | 'absent' | 'on_leave' | 'missing_punch';

export type AttendancePunchType = 'in' | 'out' | 'unknown';

export type AttendanceSourceType = 'manual' | 'excel_import' | 'api';
