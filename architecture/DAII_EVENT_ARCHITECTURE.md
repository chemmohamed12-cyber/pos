# Daii Event Architecture

Status: **DRAFT — Stage 1 Planning.**
Covers Domain Events, Integration Events, Audit Events, and Background Processing. See ADR-012.

---

## 1. Event Taxonomy

| Type | Purpose | Example |
|---|---|---|
| **Domain Events** | Fact that something happened inside a domain, consumed by other domains within Daii | `sales.order.approved`, `inventory.stock.reserved`, `shipment.dispatched` |
| **Integration Events** | Cross-boundary events intended for external systems or future Finance Phase 2 | `deposit.verified`, `stock.delivered`, `collection.recorded`, `return.completed` (blueprint §31 Finance-ready events, exhaustively listed in blueprint §32) |
| **Audit Events** | A record of an actor performing an action, feeding the Audit Engine | Not a pub/sub topic in the same sense — every domain command that mutates state emits a corresponding audit record synchronously with the write, not asynchronously via the bus |

## 2. Outbox Pattern (Mandatory)

The single most important event-architecture decision, directly closing the gap found in both `xnexus-website`'s synchronous-file-I/O-dependent atomicity and RMS's in-memory-only event bus:

1. A domain command's DB transaction writes both the domain state change **and** a row in the `event_outbox` table, atomically, in the same transaction.
2. A separate dispatcher process polls (or uses `LISTEN/NOTIFY`, or CDC) the outbox and publishes to subscribers **after** the transaction commits.
3. If the dispatcher crashes mid-publish, the outbox row remains until successfully dispatched — **at-least-once delivery**, never "the write succeeded but the event was lost."

This is the production implementation that `30/kernel/event-bus`'s "durably records to local-event-store before dispatch" concept was reaching for but never completed (that implementation is offline-terminal-specific and explicitly a placeholder) — Daii's outbox is the hosted-platform equivalent of the same underlying principle: **never let an event advertise a fact that the database transaction didn't durably commit first.**

## 3. Audit Engine Integration

Every domain event tagged `auditable: true` is consumed by the Audit Engine, which appends a hash-chained record:

```
AuditRecord {
  seq, timestamp,
  actorUserId, organizationId,
  action, resource, resourceId,
  result,               // success | failure | denied
  correlationId,
  prevHash, hash         // SHA-256, each record commits to its own content + prevHash
}
```

Directly adopts `30/kernel/audit`'s hash-chain algorithm (Class B — the strongest single asset found in the RMS audit) with two hardening changes it never had: (1) a real persistence backend, replacing the in-memory-only implementation; (2) `actorUserId`/`organizationId` sourced from Daii's real Authentication Foundation, not RMS's unsigned-header stub.

## 4. Background Processing

`30/kernel/background-processing`'s retry/backoff/dead-letter-queue/priority-scheduling **algorithm** is sound and portable (Class B/C) — but its storage layer is explicitly, self-describedly an "honest substitute" for a real broker (BullMQ/Redis named as the intended target, never implemented). Daii's production recommendation:

- A durable, DB-or-Redis-backed job queue (see `DAII_DATA_ARCHITECTURE.md` §2) — never in-memory.
- Retry with exponential backoff, capped attempts, dead-letter queue for exhausted jobs (an operator-visible list, not silent data loss).
- Priority levels for time-sensitive jobs (e.g., SLA escalation scans, mirroring `baseline`'s `escalation-engine.js` concept — Class C, the pattern is good, the current implementation reads 5 raw JSON files bypassing repositories and must be rebuilt against the real DB).

## 5. Event Schema Versioning

- Every event payload carries a `schemaVersion` field.
- Consumers tolerate unknown additional fields (forward compatibility); breaking payload changes bump `schemaVersion` and old consumers are updated before the old version is retired — never a silent in-place breaking change to a live event schema.

## 6. Ordering & Idempotency

- Events within a single aggregate (e.g., one Sales Order's lifecycle) are ordered by the outbox's insertion sequence and dispatched in order for that aggregate.
- Cross-aggregate ordering is not guaranteed and consumers must not assume it.
- Every consumer is idempotent — reprocessing the same event (possible under at-least-once delivery) must not double-apply an effect. Adopted directly from `xnexus-website`'s Delivery Offer engine's idempotent-replay discipline (Class C pattern).

## 7. Failure Handling

- A consumer that fails processing an event retries per Background Processing's backoff policy, then dead-letters with the full event payload preserved for operator inspection/replay — never silently drops a failed event.

## 8. What This Document Does Not Do

No message broker is provisioned, no queue library is installed, and no event schema registry is implemented here — per the CTO directive's Stage 1 constraint. The broker/infrastructure choice is finalized alongside the stack decision (ADR-002, `planning/stage-1/STAGE_1_STACK_DECISION.md`).
