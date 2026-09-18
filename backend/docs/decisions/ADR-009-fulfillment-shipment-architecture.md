# ADR-009 — Fulfillment / Shipment Architecture

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_DOMAIN_BOUNDARIES.md` §7–9, extraction matrix (QR Platform: Delivery Dispatch cluster)

## Context

QR Platform's Delivery Dispatch domain (Request→Eligibility→Availability→Capacity→Offer→Assignment→Execution→Tracking) is the single highest-value asset in the entire discovery — architecturally near-identical to blueprint §23, §25–26, and built deliberately independent of the QR/menu domain (verified "zero QR dependency" in the source's own reports). Its Offer-Accept atomicity, however, is explicitly self-documented as contingent on synchronous JSON-file I/O.

## Decision

Daii adopts the domain model and state machines directly: **Fulfillment Request ≠ Offer ≠ Assignment ≠ Shipment ≠ Tracking Event**, each a separate entity with its own lifecycle, exactly as the CTO directive specifies. The concurrency mechanism is NOT ported — it is rebuilt on PostgreSQL transactions:

- **Race conditions** (two dispatch cycles targeting the same resource): resolved via row-level locks or conditional UPDATE at the eligibility/capacity-check step.
- **Duplicate assignment**: prevented by a unique constraint (one active assignment per shipment request).
- **Idempotent accept**: `UPDATE offers SET status='ACCEPTED' WHERE status='PENDING'`, exactly one writer wins by affected-row-count, replayed requests return the original result (idempotency key).
- **Capacity re-check**: re-verified at accept-time inside the same transaction as the accept, not just at offer-creation time (adopted directly from source's own documented design rationale).
- **Ownership checks**: every assignment-scoped action (e.g., GPS ping) re-verifies ownership server-side from the authenticated actor, never a client-supplied ID.
- **Status transitions**: append-only `statusHistory`, mirrored into Waybill/Tracking's event log.
- **Event ordering**: per-aggregate ordering guaranteed via the Event Engine's outbox (see `DAII_EVENT_ARCHITECTURE.md` §6); cross-aggregate ordering not assumed.

## Consequences

- Every "atomicity proof" in the source's phase reports must be re-derived against Postgres transactions before Daii can claim the same guarantee — this is explicit Stage 2 work, not inherited automatically.
- Geography Engine (ADR-010) is a direct dependency for Eligibility resolution.
- This is Priority 1 in the extraction matrix.
