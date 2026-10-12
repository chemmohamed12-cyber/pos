import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditRecord, AuditResult } from './audit-record.entity';
import { computeAuditHash, GENESIS_HASH } from './audit-hash';
import { runInTransaction } from '../transaction/run-in-transaction';

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

/** WP-AUD-08 (DEC-01b, Option B — fail closed): raised (and the writer's transaction aborted) when the audit sequence is not ahead of the stored tail; no record is written and the sequence is not changed. */
export class AuditSequenceLagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditSequenceLagError';
  }
}

@Injectable()
export class AuditService {
  constructor(private readonly dataSource: DataSource) {}

  async record(input: RecordAuditInput, manager?: EntityManager): Promise<AuditRecord> {
    const run = async (m: EntityManager): Promise<AuditRecord> => {
      // Serialise every writer on one transaction-scoped advisory lock BEFORE reading the chain head. `SELECT ... FOR UPDATE` alone is not enough: a concurrent writer that
      // waited on the head row is handed that SAME (now stale) row once the first commits, so both chain onto one prevHash and the chain forks. Observed on daii_dev: seq 13
      // and seq 14 share a prevHash, so verifyChain reports the chain broken at 14 although nothing was tampered with.
      await m.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_KEY]);
      const rows = await m.query('SELECT seq, hash FROM audit_records ORDER BY seq DESC LIMIT 1');
      const prevHash: string = rows[0]?.hash ?? GENESIS_HASH;
      const tailSeq: number | null = rows[0] ? Number(rows[0].seq) : null;

      // F-AUD-003: the hash must commit to the seq that is actually STORED. `audit_records.seq` is SERIAL and TypeORM's save() ignores an explicit seq (proved by T-22 case X),
      // so the previous `MAX(seq)+1` was only a prediction of the next sequence value — wrong after any rolled-back insert (a rolled-back transaction still consumes a sequence
      // value). Draw the sequence value here, under the same advisory lock that serialises every writer and is held until this transaction ends, hash with THAT value and
      // insert it explicitly. Gaps in seq are legitimate (verification checks hashes and prevHash links, not contiguity). Hash format and existing records are untouched.
      const seqName: string | null = (await m.query(`SELECT pg_get_serial_sequence('audit_records', 'seq') AS name`))[0]?.name ?? null;
      if (!seqName) throw new Error('audit_records.seq has no serial sequence; refusing to write an audit record whose hash input cannot be tied to the stored seq');
      // WP-AUD-08 (DEC-01b, Option B — fail closed; CTO ruling 2026-10-12): the new row must sit strictly after the stored tail whose hash is `prevHash`, otherwise seq order and chain
      // order disagree (sequence behind the data after a reset/restore/import: a duplicate-key outage or a silently broken chain). Refuse BEFORE drawing a value so a refusal does not
      // consume sequence values and cannot recover by erosion. The sequence is NEVER realigned here (no setval); an authorised operator does it under change control after investigating the cause.
      const state = (await m.query(`SELECT last_value::bigint AS last, is_called AS called FROM ${seqName}`))[0];
      const nextSeq = Number(state.last) + (state.called ? 1 : 0); // audit_records.seq is a plain SERIAL: increment 1, cache 1
      if (tailSeq !== null && nextSeq <= tailSeq) {
        throw new AuditSequenceLagError(`AUDIT_SEQUENCE_LAG: audit sequence is behind the stored tail (headSeq ${tailSeq}, nextSeq ${nextSeq}); no audit record written; realign the sequence under change control`);
      }
      const seq = Number((await m.query('SELECT nextval($1::regclass) AS seq', [seqName]))[0].seq);
      if (tailSeq !== null && !(seq > tailSeq)) {
        throw new AuditSequenceLagError(`AUDIT_SEQUENCE_LAG: audit sequence returned ${seq} at or below the stored tail ${tailSeq}; no audit record written`);
      }
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

      await m.query(
        `INSERT INTO "audit_records" ("seq","timestamp","actorUserId","organizationId","action","resource","resourceId","result","correlationId","before","after","prevHash","hash")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)`,
        [
          seq,
          timestamp,
          input.actorUserId,
          input.organizationId,
          input.action,
          input.resource,
          input.resourceId,
          input.result,
          input.correlationId,
          input.before == null ? null : JSON.stringify(input.before),
          input.after == null ? null : JSON.stringify(input.after),
          prevHash,
          hash,
        ],
      );
      return m.getRepository(AuditRecord).create({
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
    };

    // F-AUD-002: a caller-supplied manager that has NO open transaction (e.g. `req.companyContext.dataSource.manager`) would run the advisory lock in its own implicit
    // transaction, released at once, so concurrent writers fork the chain. Join the caller's transaction only when one is active; otherwise open one on that manager.
    return runInTransaction(this.dataSource, manager, run);
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
