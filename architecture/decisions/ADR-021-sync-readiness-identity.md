# ADR-021 — Sync-Readiness: Identity & Change-Tracking Foundations

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_SYNC_READINESS_NOTE.md`

## Context

CTO directive: Daii must remain architecturally capable of evolving into Daii Local + Daii Cloud + bidirectional Sync + a packaged Daii.exe, **without building any of that now**. The directive is explicit that this is a constraint on today's implementation choices (identity, change-tracking hooks), not a request to design or build the sync engine, conflict resolution, or the desktop package itself.

## Decision

Audited every entity's primary-key strategy (33 entities across Stage 2). **31 of 33 already use a globally-unique UUID primary key** (`@PrimaryGeneratedColumn('uuid')`), generated client-of-the-database-side (Postgres `gen_random_uuid()`/`uuid-ossp`), not a per-node auto-increment sequence — the correct foundation for a future multi-node (Local + Cloud) identity space, since two independent nodes generating UUIDs never collide.

Two deliberate, disclosed exceptions, both non-business-identity, local-node-scoped by design:
- `AuditRecord.seq` — an auto-increment integer, because it IS the hash-chain's total-order key (ADR-012/ADR-017); a tamper-evident append-only chain fundamentally requires a single monotonic order, which a UUID cannot provide. Future sync implication: each node's audit chain is its own tamper-evident ledger; a future Local↔Cloud model reads/aggregates chains, it does not attempt to merge them into one sequence (see full note).
- `EventOutbox.id` — a local dispatch-queue row identity, never referenced cross-domain or exposed via any API; purely an in-process delivery-tracking concern, not business data.

Numbering-issued business codes (`SO-2026-000001`, waybill numbers, customer codes — ADR-007) are human-facing sequential codes, NOT primary keys — they remain per-node-sequential today (correct for single-node V1) but are flagged in the full note as the one area a future multi-node deployment must revisit (e.g., a node-prefixed numbering scheme), since two nodes issuing the same business code independently is a real future conflict, unlike UUID PKs.

## Consequences

- No code changes made under this ADR — this is a verification-and-documentation pass, not an implementation.
- Every future domain/entity must default to a UUID primary key; a new bare `@PrimaryGeneratedColumn()` should be treated as a flagged exception requiring the same justification test applied above (does this need a single monotonic node-local order, or is it an accident of habit).
- `createdAt`/`updatedAt` timestamps already exist on every entity read this session — a future sync engine's "change tracking" and "cursor" needs a real column addition (e.g., `updatedAt` + a monotonic per-row version), which is NOT added now (no sync engine exists to consume it yet) — tracked as future work in the full note, not built speculatively.
