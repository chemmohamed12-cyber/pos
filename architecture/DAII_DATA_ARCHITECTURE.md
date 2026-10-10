# Daii Data Architecture

Status: **DRAFT — Stage 1 Planning.** No migrations exist yet; this document defines the strategy that will later be reduced to migrations.
See ADR-003 for the decision record.

---

## 1. Why JSON-File Persistence Is Rejected

All three sources persist to flat JSON files (`fs.readFileSync`/`writeFileSync`, atomic via tmp-file-rename). This is explicitly **not carried forward** — and the Stage 0 audits found concrete evidence it must not be:

- **`baseline`**: `NumberingEngine`'s counter has no cross-check against real entity data — restoring an older backup caused silent ID reassignment/collision across Sales Orders, Assets, Purchase Requests, Warranty and Site Visit Task IDs (confirmed defect, TD-29). Separately, `AssetEngine`'s own documented technical debt (`ASSET-MULTI-WRITE`) notes multi-file writes (movement→asset→reservation) have no transactional guarantee.
- **`xnexus-website`**: the Offer-Accept race-condition atomicity in the Delivery Dispatch domain is **explicitly self-documented as contingent on synchronous file I/O** — the source's own Phase C reports state that if persistence ever becomes async, "this entire file's atomicity claim must be re-audited."

Daii's blueprint (§17, §21) requires transaction-based inventory and true multi-warehouse concurrent writes (multiple sales reps, multiple warehouse workers, concurrent order approvals and stock reservations). JSON-file persistence cannot provide this. **A real ACID database is mandatory from day one** — this is not an optimization to defer.

## 2. Recommended Persistence Stack

| Layer | Recommendation | Rationale |
|---|---|---|
| Primary datastore | **PostgreSQL** | Mature, strong transactional guarantees, row-level locking, `SERIALIZABLE`/`REPEATABLE READ` isolation where needed, JSONB for the rare genuinely-schemaless field, excellent tooling. No source uses a real DB, so this isn't a migration from an existing choice — it's a fresh decision driven by requirements, not legacy. |
| ORM / query strategy | Stack-dependent (see ADR-002) — a type-safe query builder/ORM (e.g., Prisma or TypeORM if NestJS/TS; Knex or a lightweight query builder if Express/JS) with **explicit transaction boundaries never left implicit**. | Every source's implicit "one file = one entity, whole-file rewrite" pattern must be replaced by explicit, reviewed transaction boundaries per use case — not an ORM default. |
| Object storage | S3-compatible object storage for media/attachments (deposit evidence, product images, waybill PDFs), metadata only in Postgres. | `baseline`'s media engine and `xnexus-website`'s image-processing engine both write to local disk; Daii needs this to be infrastructure-agnostic and scalable from the start. |
| Cache | Redis (or equivalent) for response caching and rate-limiting once beyond single-instance scale. | `xnexus-website`'s `response-cache-engine.js` and `rate-limiter.js` are genuinely reusable in-memory implementations (Class A) for an early single-instance deployment; flagged here as the explicit upgrade path once Daii scales past one process. |
| Background job queue | A durable broker (e.g., BullMQ+Redis, or a Postgres-backed queue like `pg-boss`) — never in-memory. | `30/kernel/background-processing`'s retry/backoff/DLQ algorithm is sound (Class B/C) but explicitly self-described as an "honest substitute" for a real broker; Daii must use the real thing from the start. |

## 3. Transaction Boundaries

- **Every domain command that writes more than one entity does so in a single DB transaction.** No "write A, then write B, hope nothing fails between them" — this directly closes `baseline`'s `ASSET-MULTI-WRITE` gap.
- **Numbering is issued inside the same transaction as the entity it numbers** (DB sequence, or an insert with a unique constraint that fails the whole transaction on collision) — this directly closes the TD-29 gap.
- **The Event Engine's outbox write happens in the same transaction as the triggering domain write** — see `DAII_EVENT_ARCHITECTURE.md` §2. Dispatch to subscribers happens after commit, never before.

## 4. Concurrency Strategy

| Scenario | Strategy | Source lesson applied |
|---|---|---|
| Stock reservation (two orders competing for the same limited stock) | Row-level lock (`SELECT ... FOR UPDATE`) on the stock ledger's aggregate row, or an atomic conditional `UPDATE ... WHERE available >= requested` | Replaces `baseline`'s ledger's implicit single-process-JSON-file safety with an explicit DB guarantee. |
| Delivery Offer Accept (two dispatch cycles racing to accept the same offer) | Optimistic concurrency (version column) or a conditional `UPDATE offers SET status='ACCEPTED' WHERE status='PENDING'` — exactly one writer wins, checked via affected-row-count | Directly replaces `xnexus-website`'s synchronous-file-I/O-dependent atomicity with a real DB-transactional equivalent of the same guarantee. |
| Order approval race (two supervisors reviewing the same order) | Optimistic concurrency (version column) on the order record; conflicting writes rejected with a clear "stale state" error, not silently overwritten | New requirement, no direct source (no source's approval workflow was audited for this race explicitly). |
| High-write, low-conflict tables (audit log, tracking events) | Simple `INSERT`, no locking needed — append-only by design | Matches Audit Engine's append-only nature directly. |

**Stage 2 verification note (live Postgres, not a mock):** Stock reservation is implemented via `pg_advisory_xact_lock(hashtext(warehouseId:productId))` (no natural lockable aggregate row exists for a ledger-based model — see `InventoryService.reserveStock`), not the `FOR UPDATE`/conditional-`UPDATE` pattern originally scoped above; functionally equivalent serialization guarantee, verified by firing 30 concurrent reservation requests against 10 seeded units: exactly 10 succeeded, 20 correctly rejected, final available stock = 0, no oversell. This same test run FIRST reproduced a real pool-exhaustion deadlock (Audit Engine nesting its own transaction inside the caller's already-open one — fixed, see `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §5.1 sibling note on `AuditService.record()`) — the fix is in place and this scenario is now confirmed safe under concurrent load.

## 5. Schema Design Principles

- **Unique constraints enforce business invariants at the DB level**, not only in application code (e.g., one active reservation per stock unit, one accepted offer per shipment request).
- **Foreign keys are used, not simulated** — every source's JSON-file repositories simulate referential integrity in application code; Daii uses real FK constraints.
- **Indexes** on every Scope-filtering column (e.g., `customer_assignments(sales_rep_id)`, `stock_reservations(warehouse_id)`) since Scope Engine's row-level filtering is a hot path on nearly every list query.
- **Soft deletion where justified**: entities with downstream references that must survive deletion for audit/history purposes (Orders, Shipments, Customers) use a `deleted_at`/status flag, never a hard `DELETE`, echoing `baseline`'s Deleted-Records restore pattern (Class C reference) but implemented as a proper soft-delete column, not a file-move operation.
- **Immutable ledger records**: `stock_movements`, `audit_records`, `tracking_events`, `order_status_history` are append-only — no UPDATE/DELETE grants at the DB role level for these tables. This directly implements blueprint §18 (Immutable Operational History) and the Audit Engine's tamper-evidence requirement.
- **Corrections are new records, never edits** — a wrong stock movement is reversed by a new correcting movement referencing the original, never by editing the original row (blueprint §18).

## 6. Migration Strategy (for Stage 2, not executed now)

- Schema migrations version-controlled and applied via the chosen framework's migration tool, forward-only in production (no down-migrations relied upon for production rollback — roll forward with a corrective migration instead).
- Each migration reviewed against the domain boundary rules in `DAII_DOMAIN_BOUNDARIES.md` — a migration that lets one domain's table reference another domain's internal (non-published) column is a boundary violation, not just a style issue.

## 7. What This Document Does Not Do

No actual migration files, ORM schema definitions, or connection code are created as part of this document — per the CTO directive's explicit Stage 1 constraint ("DO NOT create database migrations"). This is the strategy Stage 2 will implement.
