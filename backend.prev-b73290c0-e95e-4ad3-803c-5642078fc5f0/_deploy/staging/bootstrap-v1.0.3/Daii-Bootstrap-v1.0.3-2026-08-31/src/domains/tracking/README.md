# Waybill / Tracking (build-order item 30)

**Status: FOLDED INTO the Shipment domain, disclosed decision, not silent omission.**

Waybill/Tracking (blueprint §26) is implemented inside `../shipment/` rather than as a
separate domain:

- `shipment/infrastructure/tracking-event.entity.ts` — the append-only tracking
  event ledger.
- `shipment/application/shipment.service.ts` — `recordTrackingEvent()` /
  `getTrackingHistory()`.
- Process Engine's own `ProcessTransitionRecord` history (already append-only,
  already tracking every Shipment state change) provides the state-transition
  half of "tracking" for free — this table adds only the free-form detail
  (driver notes, future GPS pings) Process Engine's generic history doesn't
  carry.

**Why folded, not separate**: Tracking's only Foundation dependency (Events,
item 12) and its only real consumer (Shipment) made a standalone domain
boundary add indirection without adding isolation — Shipment already owns the
waybill number and the state machine tracking is *about*. Splitting them would
mean every tracking write crosses a domain boundary back into Shipment
anyway. If a future need (e.g., third-party carrier tracking integration)
requires Tracking to serve a second real consumer, split it out then — not
preemptively now (ADR-016: don't build for a hypothetical second consumer).

This directory exists only so its build-order line item and this note have
somewhere to live — no code lives here.
