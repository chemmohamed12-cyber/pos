# ADR-018 — Finance Integration Boundary

**Status:** ACCEPTED
**Date:** 2026-08-22
**Full detail:** `architecture/DAII_FINANCE_INTEGRATION_BOUNDARY.md`

## Context

`DAII_DOMAIN_BOUNDARIES.md` §12 already established that Finance is a pure event *consumer* in V1, never a dependency of any domain. This directive requires finalizing the exact operational events/data Orders, Inventory, Customers, and Identity must emit so a future Accounting domain (AR/AP, Treasury, Banks, Cash, GL, Financial Reporting) can attach without redesigning any of them.

## Decision

Every domain emits the blueprint §31–32 business events (already specified in `DAII_EVENT_ARCHITECTURE.md`) with a **finance-sufficient payload** — enough data for a future Accounting domain to derive a journal entry without querying back into Orders/Inventory/Customers' internal tables. This is the one new rule ADR-018 adds: **finance-relevant events are self-contained**, not thin pointers requiring Finance to reach across the domain boundary to enrich them.

## Consequences

- `deposit.verified`, `stock.delivered`/`inventory.movement.recorded`, `shipment.delivered`, `collection.recorded`, `return.completed`, `customer.refund.adjusted` (blueprint §31) each carry amount, currency, party references (by ID, resolved at emission time), and a business-date — not just an entity ID Finance would need to look up separately.
- No V1 domain schema needs to change when Finance Phase 2 is built — Finance is purely additive, subscribing to already-emitted events.
- No accounting entries, chart-of-accounts, or ledger logic exists anywhere in V1 (blueprint §30, unchanged) — ADR-018 defines the boundary contract, not the Finance domain itself.
