# Daii Finance Integration Boundary

Status: **ACCEPTED (ADR-018).** Stage 1.1 Final Closure item C. Finance remains fully out of scope for V1 implementation (blueprint §30) — this document defines the contract that makes adding it later additive, not a redesign.

---

## 1. The Rule

**No V1 domain may call into Finance. Finance may only subscribe to events V1 domains already emit for their own operational reasons.** This is `DAII_DOMAIN_BOUNDARIES.md` §12's rule, restated as binding. ADR-018 adds the second half: those events must carry enough data for Finance to act on without reaching back into the emitting domain's internals.

## 2. Finance-Sufficient Event Catalog

| Event | Emitted by | Finance-sufficient payload | Future Finance use |
|---|---|---|---|
| `deposit.verified` | Deposit Control | amount, currency, method, reference, customerId, salesOrderId, verifiedByUserId, businessDate | AR receipt / cash entry |
| `inventory.movement.recorded` (specifically `consumption` type tied to a shipment) | Inventory & Warehouse | itemId, quantity, unitCost (already a documented future field per blueprint §17), warehouseId, businessDate, referenceType/referenceId | COGS / inventory valuation entry |
| `shipment.delivered` / `delivery.completed` | Delivery | shipmentId, salesOrderId, customerId, businessDate | Revenue recognition trigger |
| `collection.recorded` | Delivery | amount, currency, method, collectorUserId, customerId, shipmentId, businessDate | Cash/AR entry |
| `return.completed` | Returns | returnId, salesOrderId, customerId, disposition, amount (if a refund is implied), businessDate | Revenue reversal / inventory reversal entry |
| `customer.refund.adjusted` (blueprint §31, not yet a named event elsewhere — formalized here) | Deposit Control or Returns, whichever authorizes it | amount, currency, customerId, reason, authorizedByUserId, businessDate | AR/refund entry |

Every payload above resolves party/reference IDs to the data a journal entry needs (amount, currency, date, counterparty) at emission time — Finance never needs a callback into Orders/Inventory/Customers to enrich an event after the fact.

## 3. Identity/Organization Requirement

Finance will eventually need a Cost Center / Fiscal Period dimension (blueprint §26/§30, and `baseline`'s `business-context-engine.js` — Class C reference per the Stage 1 extraction matrix). V1's Organization Engine (`DAII_PLATFORM_FOUNDATION_CONTRACT.md` §7) already models Company→Branch→Department→Team→Warehouse; this hierarchy is the attachment point for a future Cost Center dimension — no redesign of Organization is anticipated, only an additive Finance-owned table referencing it.

## 4. What Is Explicitly Not Decided Here

- No chart of accounts, no journal engine, no GL, no AR/AP ledger — all remain fully deferred (blueprint §30).
- No decision on which accounting standard/engine Finance Phase 2 will use — out of scope for this boundary contract, which only concerns what V1 must emit, not what Finance will do with it.

## 5. Verification

A domain's event catalog is reviewed against this table whenever a new finance-relevant business event is added — the review question is always "does this payload let Finance act without calling back into us," not "does Finance exist yet" (it doesn't, and that's fine — this is a payload-completeness discipline, not a Finance-readiness feature).
