/**
 * TEST-INFRASTRUCTURE ONLY — bounded retry for the disposable-database teardown (CTO closeout directive 2026-10-13, phase 2.2).
 *
 * Observed: `DROP DATABASE IF EXISTS "<db>" WITH (FORCE)` issued by the non-superuser test role sometimes fails with
 * `permission denied to terminate process` (SQLSTATE 42501) in global teardown, after every test of the suite has already passed
 * (6 of 91 isolation suites on 2026-10-12, 1 of 2 T-29 attempts). The cause is NOT proven (autovacuum attached to the database is the
 * suspected one; it could not be reproduced in 34 controlled attempts on 2026-10-13). This helper does not depend on the cause.
 *
 * Why a retry is safe: the statement is idempotent (`IF EXISTS`); the permission error is raised before anything is dropped; the helper
 * is only handed the three database names the current run created; and it grants nothing (no terminate rights, no server setting changed).
 *
 * Rules (all enforced here): at most MAX_ATTEMPTS attempts; escalating, capped waits; only the two known transient error classes are
 * retried — anything else is re-thrown at once; the first (original) error, the attempt count and the final outcome are always recorded
 * and logged; when the attempts are exhausted the failure is raised as a TEST-INFRASTRUCTURE error (never swallowed) and the caller must
 * not delete anything else on the strength of it.
 */
export const TEARDOWN_DELAYS_MS: readonly number[] = Object.freeze([250, 500, 1000, 2000]); // 4 waits => at most 5 attempts, <= 3.75 s of waiting
export const TEARDOWN_MAX_ATTEMPTS = TEARDOWN_DELAYS_MS.length + 1;

export interface TeardownDropRecord {
  database: string;
  attempts: number;
  outcome: 'dropped' | 'dropped-after-retry' | 'failed-after-retries' | 'failed-non-transient';
  originalError: string | null;
  finalError: string | null;
  waitedMs: number;
}

const records: TeardownDropRecord[] = [];

/** Records of every teardown drop in this process (for the evidence writer); a copy. */
export function teardownDropRecords(): TeardownDropRecord[] {
  return records.map((r) => ({ ...r }));
}

export function resetTeardownDropRecords(): void {
  records.length = 0;
}

/** The two PostgreSQL conditions that are transient while a background worker or a closing session is still attached to the database. */
export function isTransientDropFailure(err: unknown): boolean {
  const e = err as { code?: string; message?: string; driverError?: { code?: string; message?: string } } | null;
  if (!e) return false;
  const code = e.code ?? e.driverError?.code;
  const message = String(e.message ?? e.driverError?.message ?? '');
  if (code === '55006') return true; // object_in_use: "database is being accessed by other users"
  return code === '42501' && /permission denied to terminate process/i.test(message);
}

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function dropWithBoundedRetry(
  database: string,
  attemptDrop: () => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<TeardownDropRecord> {
  let originalError: string | null = null;
  let waitedMs = 0;
  for (let attempt = 1; attempt <= TEARDOWN_MAX_ATTEMPTS; attempt += 1) {
    try {
      await attemptDrop();
      const rec: TeardownDropRecord = { database, attempts: attempt, outcome: attempt === 1 ? 'dropped' : 'dropped-after-retry', originalError, finalError: null, waitedMs };
      records.push(rec);
      if (attempt > 1) console.warn(`[test-teardown] ${JSON.stringify(rec)}`);
      return rec;
    } catch (err) {
      originalError ??= text(err);
      const transient = isTransientDropFailure(err);
      if (!transient || attempt === TEARDOWN_MAX_ATTEMPTS) {
        const rec: TeardownDropRecord = { database, attempts: attempt, outcome: transient ? 'failed-after-retries' : 'failed-non-transient', originalError, finalError: text(err), waitedMs };
        records.push(rec);
        console.warn(`[test-teardown] ${JSON.stringify(rec)}`);
        if (!transient) throw err;
        throw new Error(
          `TEST-INFRASTRUCTURE: could not drop disposable database "${database}" after ${attempt} attempts (${waitedMs} ms waited). ` +
            `Original error: ${originalError}. Final error: ${rec.finalError}. No product assertion failed; nothing else was deleted on the strength of this failure.`,
        );
      }
      const wait = TEARDOWN_DELAYS_MS[attempt - 1];
      waitedMs += wait;
      await sleep(wait);
    }
  }
  /* unreachable: the loop always returns or throws */
  throw new Error('TEST-INFRASTRUCTURE: teardown retry loop ended unexpectedly');
}
