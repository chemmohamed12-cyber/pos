# ADR-006 — Domain Boundaries

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_DOMAIN_BOUNDARIES.md`

## Context

Blueprint §41 principle 5 prohibits domain leakage. RMS Step 30 demonstrates a mechanically-enforced version of this rule (ADR-006 in that codebase — no coincidence of numbering, adopted here deliberately as homage): an ESLint rule blocking Business Modules from importing Kernel internals directly.

## Decision

Daii defines 12 Business Domains (Commerce, CRM, Sales, Sales Orders, Deposit Control, Inventory & Warehouse, Fulfillment, Shipment, Waybill/Tracking, Delivery, Returns, Finance-deferred) with explicit ownership, published commands/queries/events, and binding non-leakage rules (e.g., Inventory must not contain Sales UI logic; Sales must not directly manipulate Warehouse persistence; Shipment must not directly modify Customer records). Cross-domain interaction happens only through published contracts, never direct persistence/internal-function access.

## Consequences

- A boundary-enforcement mechanism (lint rule or equivalent, per ADR-002's stack choice) is adopted once the stack is finalized — this is a Stage 2 implementation task, tracked here as a requirement, not yet built.
- Every domain's API surface is enumerated in `DAII_DOMAIN_BOUNDARIES.md` and must be kept current as domains evolve.
- Finance (Phase 2) is bound by the strictest version of this rule: no V1 domain may call into Finance; Finance only consumes events.
