# PRC-01 — Stock visibility in Purchase Request / RFQ / Purchase Order (2026-10-05)

**Status: CLOSED (2026-10-05) — IMPLEMENTED / INTEGRATED / REAL-PG VERIFIED.**
Execution rule in force (CTO): started immediately after D1 closed; no blocker, no pending architectural decision.

## 1. Approved scope (CTO preliminary decision)
Show **on-hand / reserved / available** in PR / RFQ / PO using the **existing** `GET /inventory/stock?warehouseId&productId`. No new stock model.

## 2. Evidence
Finding PRC-01: zero stock lookups in the procurement backend or in `PurchaseRequests` / `Rfqs` / `PurchaseOrders`; the official source already exists (`{onHand, reserved, available}` from `stock_movements` / `stock_reservations`, verified in INV-02). Per the D1 policy the **movements** are the only truth of where stock is — the figures are always per warehouse.

## 3. Implementation (read-only, informational — never a gate)
| Piece | Where |
|---|---|
| Shared hook + cell: one official call per distinct item for the screen's warehouse; a failed lookup (e.g. no inventory entitlement) shows "—", never an error banner; shows `on hand / reserved / available` (available red when negative) | `frontend/src/components/StockAvailability.tsx` |
| **Purchase Request**: draft lines + detail lines (request's warehouse) | `PurchaseRequests.tsx` |
| **Purchase Order**: draft lines (selected warehouse) + detail lines (order's warehouse); total-row `colSpan` adjusted | `PurchaseOrders.tsx` |
| **RFQ**: the quotation-entry table; the originating request's `warehouseId` is now part of `GET /procurement/rfqs/:id` (additive) | `Rfqs.tsx`, `RfqService.getById` |
Labels reuse existing terminology (`field.on_hand` / `field.reserved` / `field.available`) — no new migration.

## 4. Decision recorded — "On Order"
The register asked whether **On Order** (open PO quantity not yet received) is in scope. **Deferred (not built):** there is no On-Order model; it would be derivable later from approved/partially-received PO lines (`quantity − quantityReceived`) but that is a new definition (which PO states count, per warehouse?) — a business-definition decision, not part of "use the existing endpoint". Recorded as a follow-up.

## 5. Verification
- **Real-PG** (`rfq-award-visibility.company-isolation.spec.ts`, new test 7, now **7/7**): the RFQ detail carries the request's warehouse; the official figures come **per warehouse** from the movements — warehouse A: on-hand 40, reserved 15, available 25; warehouse B's 9 units of the same item are **not** mixed in (on-hand 9 there). Company B cannot see A's RFQ (existing isolation test). The stock endpoint itself stays covered by `inventory.company-isolation` (A/B) and the D1 spec.
- **Blast radius:** procurement interface specs, approval-engine, inventory-warehouse interface specs — **93/93 across 13 suites** (incl. D5 16/16, D6, D1 7/7). Build / `tsc` clean (backend + frontend); backend lint clean.
- **Regression:** targeted (the change is frontend + one additive field on a closed read route); the last full regression on the isolated seeded PostgreSQL (D1 stage 1: 894/915, +1 skipped, no stage-caused failure) covers the same backend, and every closed stage's markers were re-grepped present after the run.
- **Not browser-verified** (shared dev server runs older code).

## 6. Known limits
Informational only: nothing is blocked by stock. One lookup per distinct item (≈ the number of lines on the screen). No "On Order". Users without the inventory module see "—".

## Status
**PRC-01 = CLOSED (2026-10-05).** Next in the CTO order: D8 (fixed-asset manual JE visibility), D9, D7, COA.
