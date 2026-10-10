import { DataSource, EntityManager } from 'typeorm';

/**
 * The one transaction-handling rule for every primitive that takes a lock and then reads/writes (advisory locks, `SELECT … FOR UPDATE`, check-then-insert).
 * A lock is only held until the end of the TRANSACTION that took it. A caller-supplied `EntityManager` can be either
 *   - a transaction manager (`queryRunner.isTransactionActive`): JOIN it — the caller owns the boundary and the lock lives as long as the caller's transaction; or
 *   - a plain manager such as `req.companyContext.dataSource.manager` (no open transaction): every statement would auto-commit, the lock would be released at once and
 *     concurrent callers would interleave (observed: duplicate document numbers, repeated state transitions, audit-chain forks, treasury overdrafts, over-applied payments).
 *     Open a transaction ON THAT MANAGER'S connection (so the Company routing is preserved) and run the whole unit inside it.
 * With no manager at all the default DataSource opens the transaction (unchanged behaviour of every standalone caller).
 */
export function runInTransaction<T>(dataSource: DataSource, manager: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
  if (manager) return manager.queryRunner?.isTransactionActive ? fn(manager) : manager.transaction(fn);
  return dataSource.transaction(fn);
}
