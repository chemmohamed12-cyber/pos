/**
 * Backup/DR Architecture V1 (2026-09-24, Track D §Step 4 freeze).
 *
 *   PENDING → RUNNING → COMPLETED                      (terminal, success)
 *   RUNNING → FAILED → RETRYING → COMPLETED             (terminal, success)
 *                                → FAILED (loop, if the retry itself fails)
 *
 * `FAILED` is NOT terminal by itself — a row here is picked up by
 * `BackupReconciliationScheduler`, moved to `RETRYING`, and either
 * completes or falls back to `FAILED` again. It becomes terminal only once
 * `attempts >= BACKUP_MAX_ATTEMPTS` (a constant independent of
 * `MembershipOperation`'s own retry cap — same durable/retryable/
 * observable PRINCIPLE, deliberately different mechanism, per the Track D
 * decision not to reuse Membership's ledger for a different domain
 * problem: this models external-process/job reliability, not cross-
 * database consistency).
 */
export type BackupOperationStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
