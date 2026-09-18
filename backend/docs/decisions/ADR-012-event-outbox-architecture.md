# ADR-012 — Event / Outbox Architecture

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_EVENT_ARCHITECTURE.md`

## Context

RMS's Event Bus interface (`publish/subscribe`, "never import a broker SDK directly from domain code") is a sound contract, but its implementation is an explicit in-memory placeholder. RMS's Audit hash-chain is the strongest audit primitive found in any source but is also in-memory only.

## Decision

Daii adopts RMS's event-bus **interface contract** and Audit's **hash-chain algorithm**, both rebuilt on durable infrastructure: an **outbox pattern** (event write in the same DB transaction as the triggering domain write; a separate dispatcher publishes after commit, at-least-once delivery) and a **Postgres-backed, append-only audit table** (no UPDATE/DELETE grants).

## Consequences

- No domain writes state and "hopes" an event fires — the outbox guarantees at-least-once delivery tied to the actual committed transaction.
- Every consumer must be idempotent (at-least-once, not exactly-once, delivery).
- Background Processing (RMS's retry/backoff/DLQ algorithm, Class B/C) backs the dispatcher and any async job processing — on durable storage (BullMQ/Redis or Postgres-backed queue), never in-memory.
- Every auditable event carries a `correlationId` threading through Observability, API responses, and the Audit record.
