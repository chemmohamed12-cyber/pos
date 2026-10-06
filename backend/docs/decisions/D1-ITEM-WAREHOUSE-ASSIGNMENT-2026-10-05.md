# D1 — Real Item↔Warehouse assignment (2026-10-05)

**Status: CLOSED (2026-10-05) — CTO policy decision: Default/Origin Warehouse, transferable; no restriction mechanism (§8). Stage 1 implementation aligned and REAL-PG VERIFIED (§6, §8).**
Execution rule in force (CTO, 2026-10-05): start immediately; STOP only at a genuine accounting/architectural decision.

## 1. Approved scope (CTO preliminary D1)
A **real Item↔Warehouse assignment** (master data: scope / eligibility of an item per warehouse). **Stock stays ledger-derived** (`stock_movements`); the assignment **never stores balances**.

## 2. Evidence (INV-01, code read)
- `products` and `warehouses` have **no relation table**. `getWarehouseInventoryPage` (`GET /inventory/warehouses/:id/inventory`) is a deliberate `LEFT JOIN` from `products` ("a product with zero movements in this warehouse still appears as an explicit on-hand-0 row, never silently missing") — so every warehouse screen lists the whole catalogue (the operator's complaint). It is a backend grid, not a frontend filter.
- On-hand = Σ `stock_movements`; reserved = Σ active/preliminary `stock_reservations`; available = on-hand − reserved (INV-02, verified).
- Closed controllers involved: `inventory` (grid + new routes), `warehouse-transactions`, `sales-orders`/`purchase-order`/`goods-receipt` (only if enforcement is enabled — §5).

## 3. Policy (this stage — additive, no behaviour break)
1. **Master data:** table `warehouse_items (id, warehouseId, productId, assignedByUserId, createdAt)`, **UNIQUE(warehouseId, productId)** — many-to-many (an item may be assigned to several warehouses, a warehouse holds many items). No quantity/value columns, ever.
2. **Backfill (deterministic, nothing invented):** every (warehouse, product) pair that already has a `stock_movements` row or an active/preliminary reservation is assigned, so no existing stock becomes "unassigned".
3. **Management:** assign items to a warehouse (bulk, idempotent) and unassign — **unassign is rejected while the pair has on-hand ≠ 0 or active/preliminary reservations** (the assignment can never contradict the ledger).
4. **Grid:** `scope` parameter — `assigned` (**new default**: assigned items **plus** any item that has a non-zero stock/reservation row here, flagged `assigned = false` so stock is never silently hidden), `all` (the old full-catalogue behaviour). Every row reports `assigned`.
5. **UI:** the Inventory screen shows the assigned scope by default with a switch to "all items", an Assigned indicator, and assign / remove actions for users who may edit the warehouse.
6. **Not changed in this stage:** no movement, receipt, order, transfer or adjustment is blocked by assignment (advisory data only).

## 4. Out of scope
Per-warehouse GL accounts (INV-03/D3 Model A stands), stock balances in the assignment, changing any posting policy.

## 5. DECISION POINT — needs the CTO (the only thing this stage does not do)
**Enforcement.** Should assignment be *enforced* (reject a movement/receipt/reservation/transfer/adjustment for an unassigned pair) or stay advisory? Enforcing touches several **closed** flows (Sales Order reservation, Goods Receipt / PO, warehouse transactions, transfers, returns, manual receipt, opening-stock import) and changes operational behaviour — it is a business-policy decision, not an implementation detail. Sub-questions: (a) strict vs advisory vs a per-Company switch; (b) is a **transfer** to a warehouse where the item is unassigned auto-assigning or rejected; (c) does the rule differ for `operational` (custody/WIP/inspection) sub-locations vs `main` warehouses (proposed: operational sub-locations are exempt — they receive items by custody transfer); (d) the 5,291 dev test products need no backfill (none have movements).
**Recommendation (for the CTO gate):** ship advisory (this stage), then enable **strict for `main` warehouses only, with auto-assignment on a first receipt/transfer-in** behind a per-Company setting — decided once, applied through one helper so no flow reimplements it.

## 6. Stage 1 — implementation and verification (2026-10-05)
| Piece | Where |
|---|---|
| Table `warehouse_items` (UNIQUE per pair, no quantity/value) + deterministic backfill from stock movements and active/preliminary reservations | migration `inventory/1789940000000-CreateWarehouseItems`; entity `WarehouseItem` (registered in the Company entity registry and the module) |
| `assignItems` (bulk, idempotent, unknown warehouse/item ⇒ rejected with zero writes), `unassignItem` (rejected while on-hand ≠ 0 or reserved > 0; idempotent) | `InventoryService` |
| Grid scope `assigned` (default: assigned items **plus** any item still holding stock/reservations, flagged `assigned=false`) / `all`; every row reports `assigned` | `getWarehouseInventoryPage`, `GET /inventory/warehouses/:id/inventory?scope=` |
| Routes (permission `inventory.warehouse.edit` editable) | `POST /inventory/warehouses/:id/items`, `DELETE /inventory/warehouses/:id/items/:productId` |
| UI: scope switch, Assigned column, assign (combobox) and remove (zero-stock rows) | `frontend/src/pages/Inventory.tsx`; core terminology migration `1789950000000` |

**Real-PG spec** `inventory-warehouse/interface/warehouse-item-assignment.company-isolation.spec.ts` — **7/7**: (1) the migration's own SQL backfills exactly the pairs with a movement or an active reservation (a `fulfilled` one is not); (2) the table has no quantity/value column and a duplicate pair is rejected; (3) assign is bulk + idempotent, unknown item/warehouse rejected with zero writes, many-to-many across warehouses; (4) grid default = assigned + stock-holding strays flagged `false`, `all` = whole catalogue; (5) unassign rejected while stock exists (nothing deleted), allowed at zero, idempotent — **this test caught a real bug** (a raw `DELETE … RETURNING` returns `[rows, count]` from the driver, so the first version always reported `removed: true`; fixed with a CTE count); (6) nothing is blocked by assignment (a receipt into an unassigned pair still posts); (7) A/B isolation — B untouched, A's ids unknown to B, never requests B's DataSource.
Build, lint (D1 files) and frontend type-check clean.

**Regression (isolated seeded PostgreSQL, stable `dist` snapshot):** one full run — 145 suites / 915 tests — **894 passed, 20 failed, 1 skipped; 894/915 first run (+1 skipped), failures classified, not "clean":** 17 tests in 4 `*.characterization.spec.ts` suites are environment-guarded to the HR instance (not run, unrelated); `wip-reconciliation` (3) timed out under load and **passed 5/5 serially**; one suite (`rfq-award-visibility`) failed to compile in that run because **another session had overwritten my D6 edits** in `rfq.service.ts` / `Rfqs.tsx` / `Approvals.tsx` — re-applied and re-proved (D6 specs 18/18, see the D6 record). No D1-caused failure.

## 7. Known limits
Advisory only — no flow is blocked by assignment. The UI is type-checked, not browser-verified. Closed `inventory` controller write path re-proved by the spec above plus the existing `inventory` isolation spec.

## 8. CTO DECISION (2026-10-05) — D1 CLOSED: Default / Origin Warehouse, transferable
The §5 decision point is resolved. **Warehouse Assignment = the item's Default / Origin warehouse, NOT a permanent restriction** (and not "Advisory only" — it has operational value as the item's starting/default warehouse):
1. At item creation the **initial / default warehouse** is chosen (optional).
2. The assignment does **not** tie the item to that warehouse; items move by a formal **Transfer** and afterwards the **stock movement is the source of truth** for where stock is.
3. The assignment is **never evidence** that the item is in that warehouse now. On-hand / Reserved / Available always come from `stock_movements` / `stock_reservations` per warehouse.
4. A Transfer between warehouses posts **no GL** (D3, central Inventory control account — Model A).
5. **No movement is blocked** because the target warehouse is not the item's assigned one, unless an explicit operational rule appears later. **No restriction mechanism is built on the assignment.**

**Implementation aligned with the decision (this closure):**
- `unassignItem` is **always allowed** (it is metadata); the earlier "rejected while stock exists" guard was removed — it implied the assignment says something about presence. An item that still holds stock simply shows in the grid as "holds stock, not the default".
- `assignItems` documented as default/origin marking; the grid keeps `assigned` + stock-holding strays (never hides stock).
- **Products screen:** optional **Initial / default warehouse** when creating an item (creates the marker after the item is created; a marker failure never loses the item). Terminology reworded to "Default / origin" (core migration `1789950000000`, ar/en).
- Spec test 5 now proves the policy: removing the marker with 5 on hand is **not blocked**, stock is unchanged, the item stays visible as "holds stock / not default", and a transfer moves the stock between warehouses (WH-A 5→0, WH-A2 0→5) with the ledger as the only truth.

**Verification:** `warehouse-item-assignment` spec **7/7**; neighbours re-run (inventory, warehouse-transactions, inventory-valuation, products/bom/price-lists, returns, returns-accounting) — **75/75 tests across 11 suites** (one suite-level "permission denied to terminate process" teardown flag on `inventory.company-isolation` after its 7 tests passed). Build/lint/type-check clean. The stage-1 full regression (§6: 894/915, +1 skipped, no D1-caused failure) covered the same backend; the closure delta (guard removal + UI) was re-proved by the targeted run above.

## Status
**D1 = CLOSED (2026-10-05) — Policy: Default/Origin Warehouse, Transferable.**
