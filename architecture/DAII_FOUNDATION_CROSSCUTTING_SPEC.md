# Daii Foundation Cross-Cutting Specification

Status: **ACCEPTED (ADR-017).** Stage 1.1 Final Closure item B. One consistent approach for Audit, Events, Observability, Testing, Idempotency, and Error Contract — consumed by every Shared Engine and Business Domain, reinvented by none.

---

## 1. Audit

**Contract:** `AuditRecorder.record({ actorUserId, organizationId, action, resource, resourceId, result, correlationId, before?, after? })` → appends a hash-chained record (ADR-012 algorithm). Domain code calls this at the point of state change; it never writes its own audit table or log line.

**Where it lives:** Foundation, depended on by every domain. Not duplicated per domain (this directly reverses the pattern found in `baseline`, where audit-adjacent logic was scattered per-engine).

**Maturity target:** L3 — the interface never changes shape regardless of persistence backend (Standard §2.14 applied to Audit specifically).

## 2. Events

**Contract:** `EventPublisher.publish(topic, payload, { schemaVersion })`, written to the outbox in the same transaction as the domain state change (ADR-012 §2). `EventSubscriber.on(topic, handler)` — handlers are idempotent by contract (§5 below enforces this structurally, not just by convention).

**Where it lives:** Foundation. Domain code never imports a broker SDK directly (ADR-006/ADR-018 boundary rule extended to this specific dependency).

## 3. Observability

**Contract:** every request carries a `correlationId` (generated at ingress if absent), propagated through every log line, every Audit record, every Event payload, and every API error response's `meta.correlationId` (`DAII_API_ARCHITECTURE.md` §2). One structured-logging call convention (`logger.info(event, { correlationId, ...fields })`), one metrics-emission convention (`metrics.increment(name, tags)`), consumed identically by every domain.

**Health:** every Shared Engine registers a real functional health probe (RMS's "round-trip check, not hardcoded ok" discipline) with the one shared `/health/deep` aggregator (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §17) — it does not stand up its own separate health endpoint.

## 4. Testing

**Shared harness, not shared test cases:**
- One test-database bootstrap/teardown utility (real Postgres, per ADR-003 — never a JSON-fixture standing in for the real persistence model).
- One fixture-factory convention per entity, reused across domain test suites.
- One authorization-test pattern, adopted directly from QR Platform's Phase D-02 methodology: assert the forbidden code path is structurally absent for a given actor (e.g., `typeof engine.forbiddenAction === 'undefined'` for that actor's resolved capability set), not merely that it currently returns a rejection.
- Every Shared Engine ships contract tests verifying its public API/data contract (Standard §2.3–2.4) doesn't silently drift — required before a second consumer (a future Daii module or vertical platform) may depend on it, per the Reusable Platform Capability Contract §2.

## 5. Idempotency

**Contract:** a shared `IdempotencyGuard` — every state-changing endpoint declares an idempotency key extraction rule (usually a client-supplied header or a natural key derived from the request); the guard checks a shared `idempotency_keys` table (key → prior response) inside the same transaction as the operation, returning the cached prior result on replay instead of re-executing. This is the API-layer backstop mandated by `DAII_API_ARCHITECTURE.md` §6 and `DAII_SECURITY_ARCHITECTURE.md` §4, now given one shared implementation instead of "every domain remembers to do this."

## 6. Error Contract

**Canonical taxonomy:** error codes are namespaced by domain (`SALES_ORDER_NOT_FOUND`, `INVENTORY_INSUFFICIENT_STOCK`) but all resolve through the one shared envelope (`DAII_API_ARCHITECTURE.md` §2) and are Terminology-Registry-eligible (`DAII_I18N_TERMINOLOGY_ARCHITECTURE.md` §3) — a domain registers its error codes into the shared registry rather than inventing its own response shape.

## 7. Why This Is One Spec, Not Six

Building these six concerns once and depending on them everywhere is the direct fix for the Stage 1.1 maturity scorecard's cross-cutting finding: every audited source engine scored L0–L1 on exactly these dimensions, independent of how good the engine's own domain logic was. This is a shared Stage 2 build-order item (`planning/stage-2/STAGE_2_BUILD_ORDER.md`, items 11–14), sequenced before any Business Domain implementation begins.
