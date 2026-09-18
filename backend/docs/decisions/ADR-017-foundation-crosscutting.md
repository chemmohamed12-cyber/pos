# ADR-017 — Foundation Cross-Cutting Concerns

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_FOUNDATION_CROSSCUTTING_SPEC.md`

## Context

Audit, Events, Observability, Testing, Idempotency, and Error Contract were each specified individually across Stage 1 documents (`DAII_EVENT_ARCHITECTURE.md`, `DAII_API_ARCHITECTURE.md`, `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §9/§19/§20). The Stage 1.1 maturity scorecard found every candidate independently scoring low on these six dimensions — confirming the risk named in this directive: every Engine reinventing Audit/Events/Observability/Testing/Idempotency/Error-handling independently, at different quality levels, rather than consuming one shared implementation.

## Decision

Daii implements each of these six concerns exactly once, as a shared Foundation library/module every Shared Engine and Business Domain consumes — never reimplements:

1. **Audit** — one `AuditRecorder` interface (hash-chain algorithm per ADR-012), called by domain code at the point of state change, never a separate per-domain logging convention.
2. **Events** — one Event Engine (outbox pattern, ADR-012), one publish/subscribe contract, one schema-versioning convention.
3. **Observability** — one structured-logging/metrics/correlation-ID library, imported everywhere, never a per-module `console.log` convention.
4. **Testing** — one shared test-harness convention (test-database bootstrap, fixture factories, the QR-Platform-derived "prove the forbidden code path doesn't exist" authorization-test pattern) — every domain's test suite follows the same shape.
5. **Idempotency** — one idempotency-key middleware/decorator, applied declaratively to state-changing endpoints, not hand-rolled per endpoint.
6. **Error Contract** — one canonical error-code taxonomy and response envelope (`DAII_API_ARCHITECTURE.md` §2), extended by domains (each domain registers its own error codes into the shared taxonomy) rather than each domain inventing its own error shape.

## Consequences

- A new Business Domain gets Audit, Events, Observability, Idempotency, and Error Contract "for free" by depending on the shared Foundation libraries — it does not write any of these six concerns itself.
- This is a Stage 2 build-order item (see `planning/stage-2/STAGE_2_BUILD_ORDER.md`, items 11–14) that must exist *before* the first Business Domain (Sales Orders) is implemented — sequencing dependency, not a nice-to-have.
- No Shared Engine's or Business Domain's PR is approved if it hand-rolls any of these six concerns instead of consuming the shared implementation (governance rule, `docs/DAII_ENGINEERING_GOVERNANCE.md`).
