# Daii Mobile Architecture

Status: **DRAFT — Stage 1 Planning.** No mobile application is implemented in Stage 1. See ADR-013.

---

## 1. Core Principle (validated from two independent sources)

Both `baseline` (`server-mobile-api.js`, `server-mobile-execution-api.js`, `server-mobile-planning-api.js` — a thin `/api/v1/mobile/*` adapter over the same admin Engines, uniform envelope, JWT-based) and `xnexus-website` (`driver-apk/`, `consumer-apk/`, `business-delivery-apk/` — thin Capacitor shells wrapping one `www/index.html` each, zero client-side business logic) independently converge on the same correct architecture:

> **Thin Client + Server as Source of Truth + Server-Side Authorization + API-Driven Business Logic.**

Adopted directly as Daii's Sales Rep Mobile App (blueprint §12) architecture — the pattern, not the specific screens or endpoints, which are domain-specific to their respective source platforms and not reusable as code.

## 2. What the Mobile Client Does and Does Not Do

| Does | Does Not |
|---|---|
| Render server-provided data and canonical codes resolved via the Terminology Registry | Compute permissions, scope, totals, or status transitions locally and submit them as fact |
| Collect input, validate format client-side (UX only) | Treat client-side validation as the enforcement boundary — server re-validates everything |
| Cache the last-fetched permission set for UI gating (`permission-gate.js` pattern) | Treat that cache as authoritative — every write re-checked server-side |
| Queue actions locally if offline-tolerant (see §3) | Silently drop a failed action or retry indefinitely without user visibility |

## 3. Authentication

- Same token mechanism as web (`DAII_SECURITY_ARCHITECTURE.md` §2) — **not** a parallel mobile-specific auth engine, directly reversing `xnexus-website`'s four-times-duplicated auth-engine anti-pattern.
- Mobile-number + OTP as an additional login path for field roles (Sales Rep, Driver, Warehouse Worker) issuing the same token type.
- Token refresh handled transparently by the client; a refresh failure surfaces an explicit re-login prompt, never a silent stuck state.

## 4. Offline Readiness

Blueprint §12 requires the Sales Rep Mobile App to function for field sales, which implies tolerance for spotty connectivity. Daii does **not** commit to true offline-first in V1 (no source's offline-sync engine is adopted wholesale for this reason), but the architecture must not preclude it:

- `baseline/kernel/sync-engine.js` + `sync-entity-registry.js` (Class B) is flagged as a **real, non-trivial, genuinely reusable offline-sync engine** — idempotent push via `syncId`, optimistic-concurrency version-conflict detection, a registry pattern keeping the sync engine itself entity-agnostic, deterministic incremental pull with pagination. If/when Daii commits to true offline-first mobile, this is the strongest starting point found across all three audits.
- Until that commitment is made, V1 mobile assumes connectivity with graceful retry (§5), not full offline queuing.

## 5. Reliability Requirements (binding, from `DAII_SECURITY_ARCHITECTURE.md` §4)

Every state-changing mobile action (create order, accept pick task, record delivery outcome, submit deposit evidence) implements:

1. **Duplicate-submission guard** — a button disables itself immediately on tap, before the network round-trip completes.
2. **Pending/loading state** — explicit, visible to the user, not a frozen UI with no feedback.
3. **Success state** — explicit confirmation, not just a screen transition that might also happen on failure.
4. **Error state** — a `.catch()`/error path on every promise chain, with visible, actionable user feedback. `fetch()` (or equivalent) does not reject on 4xx/5xx by default — status codes must be checked explicitly.
5. **Retry behavior** — safe to retry because of API-layer idempotency keys (`DAII_API_ARCHITECTURE.md` §6), not just a client-side "try again" that might double-submit.
6. **Idempotency** — the server-side backstop for #1, since #1 alone was exactly what failed in `xnexus-website`'s one documented incident (`HOTFIX-ENGINEERING-INCIDENT-REPORT.md`).

This list is carried forward verbatim from the CTO directive §2.14 and is treated as an architecture requirement enforced in code review, not a UI-polish checklist deferred to later.

## 6. Scope Enforcement on Mobile

A mobile client's "my customers," "my tasks," "my assigned warehouse" views are always server-filtered via the Scope Engine (`DAII_SECURITY_ARCHITECTURE.md` §3) — the mobile app never receives an unfiltered dataset and hides rows client-side. This closes the same class of gap blueprint §22 explicitly warns about (Stock Visibility ≠ Stock Ownership/Custody; visibility itself must still be permission/scope-gated, not just UI-omitted).

## 7. Mobile API Versioning

Follows `DAII_API_ARCHITECTURE.md` §4 — URL-path versioned, `baseline`'s existing `/api/v1/mobile/*` convention adopted as the starting shape.

## 8. What This Document Does Not Do

No mobile application, screen, or client-side code is implemented here — per the CTO directive's explicit Stage 1 constraint ("DO NOT implement the mobile application in Stage 1").
