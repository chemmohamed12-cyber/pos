# ADR-013 — Mobile Architecture

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_MOBILE_ARCHITECTURE.md`

## Context

Both `baseline` (mobile API as a thin adapter over shared admin Engines) and `xnexus-website` (thin Capacitor shells, zero client business logic) independently converge on the same architecture: thin client, server as sole source of truth. `xnexus-website`'s one documented incident (silent "Send Order" failure — no `.catch()`, no duplicate-submission guard, `fetch()` not rejecting on 4xx/5xx) is directly relevant risk knowledge.

## Decision

Daii's Sales Rep Mobile App is a thin client consuming the same domain commands/queries as web through a mobile-optimized API envelope (`/api/v1/mobile/*`, following `baseline`'s existing convention). No client-side computation of permissions, scope, or totals is trusted — server re-validates everything. Every state-changing action implements: duplicate-submission guard, explicit pending/success/error states, retry via API-layer idempotency keys.

## Consequences

- Mobile authentication uses the same centralized Authentication Foundation (ADR-004) — not a parallel mobile auth engine.
- Offline-first is NOT committed to in V1; `baseline/kernel/sync-engine.js`'s idempotent-push/optimistic-concurrency design (Class B) is flagged as the strongest starting point if that commitment is made later.
- Scope-filtered views ("my customers," "my tasks") are always server-derived, never client-side-hidden from an unfiltered dataset.
