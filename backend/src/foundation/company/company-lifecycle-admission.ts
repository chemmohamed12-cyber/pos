import { DataSource } from 'typeorm';
import { CompanyConnectionManagerService } from '../database-registry/company-connection-manager.service';
import { COMPANY_NOT_READY_CODE, isCompanyOperational } from './company-operational-status';
import { CompanyStatus } from './company-status';

/**
 * LA-1 — Lifecycle Admission Boundary, Layer 2 (CTO Executive Order 2026-10-06).
 *
 * Layer 1 (`CompanyContextGuard`) admits Company-scoped HTTP requests. Layer 2
 * is the SAME READY-only rule (DP-9 O-4) for every OTHER path that wants to do
 * Company OPERATIONAL work through a Company DataSource: schedulers, workers,
 * services, platform-admin routes that read a Company database.
 *
 * It is NOT a bare "READY assertion". The only way this module hands out a
 * Company DataSource is `runOperationalAdmitted`, which joins the status
 * check and the DataSource acquisition + the work into ONE unit:
 *
 *   BEGIN (Platform DB)
 *     SELECT status FROM companies WHERE id = $1 FOR SHARE   -- row lock, no cache (DP-9 O-5)
 *     not READY  -> release, nothing opened, nothing executed
 *     READY      -> acquire the Company DataSource, run `work`
 *   COMMIT
 *
 * Race (LA-1 item 4): the `FOR SHARE` lock is held until `work` finishes. A
 * `suspend()` / `decommission()` is an UPDATE of that same row, so it WAITS
 * for in-flight admitted work, and any admission that starts after the UPDATE
 * is queued behind it and then sees the new status. Therefore: (a) no
 * operational work STARTS after a lifecycle change commits; (b) the change
 * only becomes visible once in-flight admitted work has finished. The
 * check is not a cosmetic read that can be overtaken between "read status" and
 * "use the database".
 *
 * Scheduled work (item 5): a job whose Company was READY when the sweep list
 * was built but is SUSPENDED when its turn comes is refused here, per Company,
 * at execution time; other Companies in the same sweep are unaffected.
 *
 * Exceptions (items 3/6): Backup/DR is NOT routed through this function and is
 * NOT given a bypass flag. It keeps its own, separate policy (DP-9 O-1) and its
 * own scheduler; nothing here changes it.
 */
export type AdmissionRefusal = { admitted: false; reason: typeof COMPANY_NOT_READY_CODE; status: CompanyStatus | 'MISSING' };
export type Admitted<T> = { admitted: true; value: T };
export type AdmissionResult<T> = Admitted<T> | AdmissionRefusal;

export async function runOperationalAdmitted<T>(
  platform: DataSource,
  connections: CompanyConnectionManagerService,
  companyId: string,
  work: (companyDataSource: DataSource) => Promise<T>,
): Promise<AdmissionResult<T>> {
  const runner = platform.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const rows: Array<{ status: CompanyStatus }> = await runner.query(`SELECT "status" FROM "companies" WHERE "id" = $1 FOR SHARE`, [companyId]);
    if (rows.length === 0 || !isCompanyOperational(rows[0].status)) {
      await runner.commitTransaction();
      return { admitted: false, reason: COMPANY_NOT_READY_CODE, status: rows.length === 0 ? 'MISSING' : rows[0].status };
    }
    const dataSource = await connections.getDataSource(companyId);
    const value = await work(dataSource);
    await runner.commitTransaction();
    return { admitted: true, value };
  } catch (err) {
    if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
    throw err;
  } finally {
    await runner.release();
  }
}
