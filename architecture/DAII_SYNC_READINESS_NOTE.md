# Daii Sync-Readiness Note

**Status:** Reference document, not a build plan. Companion to ADR-021.
**Scope:** What today's architecture must preserve so a FUTURE Daii Local + Daii Cloud + Sync + Daii.exe model remains buildable — nothing here is implemented now, and nothing here should be implemented until a real second deployment actually needs it (CTO directive: "preserve tomorrow's options, do not build tomorrow's complexity today").

---

## 1. Why this exists

A future customer may run **Daii Local** (on-prem/LAN, its own Postgres) that periodically synchronizes with **Daii Cloud** (the central environment). This is explicitly **not** a V1 requirement — Daii V1 is single-node. This note exists so that V1 decisions don't accidentally foreclose that future without anyone deciding to.

## 2. Identity — audited, see ADR-021

31 of 33 entities use UUID primary keys, generated independently of any central authority. This means two nodes can each create records without ever colliding on primary key — the single hardest constraint to retrofit later, so it was verified now. The two exceptions (`AuditRecord.seq`, `EventOutbox.id`) are local-node-scoped by design, not business identity, and are documented in ADR-021.

**One real future gap, correctly left unfixed for now:** Numbering's business codes (`SO-2026-000001` etc., ADR-007) are sequential per-node. Two Daii Local nodes would each independently produce `SO-2026-000001`. This is fine for V1 (one node). A future sync design has two honest options, neither implemented now:
- Prefix codes with a node/tenant identifier once multi-node exists (`LOC1-SO-2026-000001`).
- Treat Numbering's codes as node-local display codes and let the UUID remain the actual cross-node identity (the code becomes "how this node refers to it," not "the global key").

## 3. Change tracking — not yet added, and that's correct for now

Every audited entity has `createdAt` (and most have `updatedAt`). A future sync engine needs more than that: a way to ask "what changed since I last synced" (a cursor) and "did I already apply this change" (idempotency/operation identity). None of that exists today, and it should **not** be spot-welded onto entities now — a change-tracking column with no consumer is speculative complexity (CTO directive §18). When Sync is actually scheped, it will need, at minimum:
- A monotonic per-row version or a `updatedAt` + tie-breaker.
- An operation/idempotency key per write, distinct from the `idempotency_records` table that already exists for API-level retry safety (`DAII_FOUNDATION_CROSSCUTTING_SPEC.md` §5) — that table solves "don't double-process one HTTP retry," not "don't double-apply one sync operation replayed from another node." Related, not the same problem; the existing Idempotency Engine is a reasonable pattern to extend, not something to bypass.

## 4. Conflict detection/resolution — domain-level, not generic

The CTO directive is explicit and worth restating verbatim in spirit: future sync is **not** "copy the database" or "merge JSON blindly." It must operate on domain operations (Sales Order created, Stock reserved, Deposit approved), each with identity and version, resolved by domain rules — because only the domain knows what a legitimate conflict resolution looks like. Nothing about today's service layer (`SalesOrdersService`, `InventoryService`, etc.) needs to change to keep this option open — every write already goes through a domain service method with a clear operation shape (this is what Stage 2's "no direct table access, only published contracts" rule already gives us, for a different reason). That existing discipline is exactly what a future domain-level sync would need to hook into.

## 5. Inventory — the named high-risk domain

The directive calls out inventory specifically: two nodes each selling from a nominal shared stock offline, then syncing, must not be resolved by naive arithmetic (`10 - 7 - 6`). Today's `InventoryService` already models stock as an append-only ledger (`stock_movements`) plus reservations (`stock_reservations`), never a single mutable "quantity" field (ADR-007) — this ledger shape is precisely what a future reconciliation process needs (it can replay/merge ledger entries by their own timestamps and origin, rather than trying to merge a single collapsed number). No change made now; the ledger design already happens to be sync-friendly, which is why it was chosen for the concurrency guarantees it gives today (`pg_advisory_xact_lock`), not for sync — the two concerns turned out to reinforce each other.

## 6. Deployment independence — already true, verified again here

Stage 1.1 already established (ADR-015, ADR-019) that business modules must never branch on `if local / if cloud / if exe`. Nothing built in Stage 2 introduces such a branch — every domain service takes its dependencies through Nest DI (DataSource, other services), never reaches for an environment check. A future Daii.exe is a **composition/packaging** concern (bundle the same Nest app + a local Postgres + a sync agent process), not a different code path inside any domain.

## 7. What this note deliberately does NOT do

- No sync engine, no conflict-resolution code, no cursor/version columns, no client/device-identity table, no Daii.exe packaging script. All of that is real future work, scoped only when a second real deployment target exists to build it against.
- No change to Numbering (still single-node-correct for V1; the future prefixing option above is recorded, not applied).
