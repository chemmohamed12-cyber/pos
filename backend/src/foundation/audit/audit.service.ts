import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditRecord, AuditResult } from './audit-record.entity';
import { computeAuditHash, GENESIS_HASH } from './audit-hash';

export interface RecordAuditInput {
  actorUserId: string | null;
  organizationId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: AuditResult;
  correlationId: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Audit Engine — Stage 2 build-order item 11.
 * Daii/architecture/DAII_FOUNDATION_CROSSCUTTING_SPEC.md §1, ADR-012.
 *
 * The one shared implementation every domain calls at the point of
 * state change (CTO Execution Policy §7: build once, don't let every
 * module reinvent this). The read-then-append sequence is wrapped in a
 * transaction with a row lock on the latest record so concurrent writers
 * cannot both read the same prevHash and corrupt the chain.
 *
 * REAL BUG FOUND & FIXED via required Inventory concurrency verification
 * (CTO directive item 7): `record()` always opened its OWN new
 * `dataSource.transaction()` — a caller that invokes it from INSIDE an
 * already-open transaction (e.g. Inventory's `reserveStock`, itself
 * serialized behind a `pg_advisory_xact_lock`) forces that call to grab a
 * SECOND connection from the pool while still holding the first. Under a
 * burst of concurrent requests targeting the same locked resource, every
 * connection in the pool ends up checked out and blocked waiting on the
 * advisory lock, and the one request that IS allowed to proceed can no
 * longer obtain the second connection its nested audit write needs —
 * total pool-exhaustion deadlock, verified by reproducing it live (the
 * whole backend stopped responding, confirmed by a hung /health/deep,
 * requiring a process restart to recover). Fix: `record()` now accepts
 * an optional caller-supplied `manager` (same pattern already used by
 * `EventBusService.publish()`) and joins the caller's own transaction
 * instead of opening a nested one — the ONE call site that actually
 * nests (`InventoryService.reserveStock`) was updated to pass its
 * manager through; every other domain calls `record()` standalone, after
 * its own transaction has already committed, so this change is
 * backward-compatible for them.
 */
/** Arbitrary constant, unique to the audit chain; the lock is released automatically at the end of the writer's transaction. */
const AUDIT_CHAIN_LOCK_KEY = 7_419_203_511;

@Injectable()
export class AuditService {
  constructor(private readonly dataSource: DataSource) {}

  async record(input: RecordAuditInput, manager?: EntityManager): Promise<AuditRecord> {
    const run = async (m: EntityManager): Promise<AuditRecord> => {
      // Serialise every writer on one transaction-scoped advisory lock BEFORE reading the chain head. `SELECT ... FOR UPDATE` alone is not enough: a concurrent writer that
      // waited on the head row is handed that SAME (now stale) row once the first commits, so both chain onto one prevHash and the chain forks. Observed on daii_dev: seq 13
      // and seq 14 share a prevHash, so verifyChain reports the chain broken at 14 although nothing was tampered with.
      await m.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_KEY]);
      const rows = await m.query('SELECT hash FROM audit_records ORDER BY seq DESC LIMIT 1');
      const prevHash: string = rows[0]?.hash ?? GENESIS_HASH;

      // seq is DB-assigned on insert; we need it for the hash, so insert
      // first with a placeholder, then update the hash — OR select the
      // next sequence value up front. Simpler and still correct: use the
      // table's own auto-increment via a dry insert-then-hash-update pass.
      const nextSeqRows = await m.query(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM audit_records`);
      const seq: number = Number(nextSeqRows[0].next);
      const timestamp = new Date();

      const hash = computeAuditHash({
        seq,
        timestamp: timestamp.toISOString(),
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId,
        result: input.result,
        correlationId: input.correlationId,
        before: input.before ?? null,
        after: input.after ?? null,
        prevHash,
      });

      const repo = m.getRepository(AuditRecord);
      const record = repo.create({
        seq,
        timestamp,
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId,
        result: input.result,
        correlationId: input.correlationId,
        before: input.before ?? null,
        after: input.after ?? null,
        prevHash,
        hash,
      });
      return repo.save(record);
    };

    if (manager) return run(manager);
    return this.dataSource.transaction(run);
  }

  /** Walks the whole chain and verifies every record's hash — the backup/restore integrity check (ADR-020 §3). */
  async verifyChain(): Promise<{ valid: boolean; brokenAtSeq: number | null }> {
    return verifyChainOn(this.dataSource.getRepository(AuditRecord));
  }

  /**
   * Area 14 (2026-09-25, CTO Implementation Gate). The Company-scoped
   * equivalent of `verifyChain()` — same integrity semantics, but never
   * resolves a Company connection itself: it operates ONLY on whatever
   * `manager` the caller supplies, already validated by that caller's own
   * `CompanyContextGuard`/Installation-Admin path. No `companyId`
   * parameter exists here by design — accepting one and using it to pick
   * a connection would be exactly the client-supplied-identifier bypass
   * this codebase's dual-path pattern (Track A/D) always refuses. Each
   * Company DB's chain is fully independent (its own `audit_records`
   * table, its own `seq`/`prevHash` sequence) — never cross-linked to the
   * Platform's or another Company's.
   */
  async verifyCompanyChain(manager: EntityManager): Promise<{ valid: boolean; brokenAtSeq: number | null }> {
    return verifyChainOn(manager.getRepository(AuditRecord));
  }
}

async function verifyChainOn(repo: Repository<AuditRecord>): Promise<{ valid: boolean; brokenAtSeq: number | null }> {
  const records = await repo.find({ order: { seq: 'ASC' } });
  let expectedPrevHash = GENESIS_HASH;
  for (const record of records) {
    const recomputed = computeAuditHash({
      seq: record.seq,
      timestamp: record.timestamp.toISOString(),
      actorUserId: record.actorUserId,
      organizationId: record.organizationId,
      action: record.action,
      resource: record.resource,
      resourceId: record.resourceId,
      result: record.result,
      correlationId: record.correlationId,
      before: record.before,
      after: record.after,
      prevHash: expectedPrevHash,
    });
    if (recomputed !== record.hash || record.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAtSeq: record.seq };
    }
    expectedPrevHash = record.hash;
  }
  return { valid: true, brokenAtSeq: null };
}
