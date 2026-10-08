# Warehouse reference integrity on create paths — fix + FK decision record (2026-10-08)

Status: **application fix IMPLEMENTED and verified (real-PG); DB foreign key = RECOMMENDED, NOT implemented — CTO decision required.**
Environment: isolated PG `127.0.0.1:5544` (specs, `daii_test_*`), read-only counts on the isolated bv env `127.0.0.1:5656`. `daii_dev` and Production untouched. No push.

## 1. Defect
Found during the Authorization Foundation closure: `POST /api/procurement/purchase-requests` with a `warehouseId` that does not exist in the caller's Company database returned **201** and persisted a `purchase_requests` row pointing at a nonexistent warehouse. Same on the pre-F1 build and the current build. Not cross-company leakage (the other Company's DB is never read or written) and not an authorization regression: F6's `WarehouseScopeGuard` deliberately treats an unknown warehouse as "not a scope matter — the handler reports it", and the handler did not.

Root cause: `purchase_requests.warehouseId` has **no FK** and `PurchaseRequestService.create` never resolved the warehouse.

## 2. Sweep of the other create paths

| Create path | Warehouse checked before? | FK on `warehouseId`? | Outcome for an unknown id before this fix | Change |
|---|---|---|---|---|
| Purchase Request | no | no | **201, orphan row persisted** | **fixed → 404** |
| Purchase Order (direct + RFQ award) | no | no | **201, orphan row persisted** (same gap) | **fixed → 404** |
| Goods Receipt | n/a (takes the PO's warehouse) | no on `goods_receipts`; **yes** on `stock_movements` | a GR on an orphan PO would fail at the `stock_movements` FK (500) — closed upstream by the PO fix | none |
| Warehouse transaction (incl. transfer destination, count) | **yes** (`assertWarehouseActive` → `getWarehouse`, 404; inactive → 409) | no | already correct | none |
| Sales Order | no | no (nullable column) | rolled back, but surfaced as a misleading **409 "Insufficient available stock"** from the reservation step, *after* the order number and per-rep number were consumed | **fixed → 404 up front** |
| Work Order (manufacturing) | no | no | **orphan row persisted** (same gap) | **not changed** — Manufacturing is closed/handed off; flagged here (§6) |
| RFQ | n/a (inherits the PR's warehouse) | — | — | none |

## 3. The fix
- `PurchaseRequestService.create` and `PurchaseOrderService.create` resolve the warehouse through the published inventory contract (`INVENTORY_RESERVATION_CONTRACT.getWarehouse`, bound to `InventoryService`), on the caller's Company manager, **before any numbering or mutation**. Unknown → `NotFoundException` `Warehouse "<id>" not found.` (**404**). That matches the domain's existing contract: unknown supplier / PR / PO are all 404, and warehouse transactions already 404 an unknown warehouse through the same call.
- `SalesOrdersService.createOrder` makes the same call up front (it already held the contract).
- Existence only. An **inactive** warehouse is still accepted on PR/PO/SO, unchanged from before. Warehouse transactions reject inactive (409). Whether procurement/sales should too is a product decision (§6), not part of this defect.
- Another Company's real warehouse id is "unknown" by construction: the lookup runs only in the caller's Company database.

## 4. Verification (isolated PG 5544)
- New spec `src/domains/procurement/interface/warehouse-reference.company-isolation.spec.ts` (two real Company DBs, 5/5): PR unknown id → 404 and no PR/line/process instance/number consumed; PR with Company B's real warehouse id via Company A → 404, both Companies untouched; PR with own warehouse → created; PO unknown and foreign id → 404 with no mutation, valid → created; SO unknown id → 404 with no order and no number consumed.
- **Red proof:** with the three checks disabled, 4/5 fail. PR/PO creates *resolve* (row persisted), which reproduces the defect.
- Affected suites green: purchase-request, purchase-order, new-item-request, rfq-award-visibility, rfq-supplier, sales-orders isolation suites (44 passed total with the new spec).
- DI wiring: `grni-posting.spec.ts` boots the full `AppModule` on a freshly provisioned `daii_test_ambient` → 2/2 (ProcurementModule resolves the contract; it already imports `InventoryWarehouseModule`, which exports it).
- `t0-clean-company-baseline.spec.ts` (gated by `T0_BASELINE=1`) fails **before** the new check, at the D7 draft-product gate (`purchase-order.service.ts:77`: its seeded products are `draft`). Pre-existing, unrelated to this change; the spec's fixture needs updating for D7.

## 5. FK decision (for the CTO)

**Recommendation: YES, add `FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id")` (default NO ACTION/RESTRICT) as a separate, CTO-authorized migration, in two phases. Do not ship it bundled with this fix.**

Why an FK is appropriate:
- Precedent already in the schema: `stock_movements`, `stock_reservations`, fulfillment and returns reference `warehouses(id)`. Same-database FKs are possible because every table here lives in the Company DB, and procurement's manifest `depends_on: ['inventory', …]` guarantees `warehouses` exists wherever `purchase_requests` does.
- Warehouses are never deleted (only `active`/`inactive`), so RESTRICT costs nothing operationally.
- The application check covers today's paths; an FK also covers imports, scripts, future paths, and a manager mix-up.

Why not just add it now:
- **Existing data.** The isolated bv env (read-only count): `bv_co.purchase_requests` has **4/14 orphan rows**, all closure test data: PR-2026-000011 → `…3606`, PR-2026-000012 → `…3605`, and **two** rows (PR-2026-000010, PR-2026-000014, two closure runs) pointing at warehouses that exist only in `company_3c7b4f5c…` (code `SMWB-…`). `purchase_orders`, `goods_receipts`, `sales_orders`, `warehouse_transactions` and `work_orders` there: 0 orphans. **`daii_dev` and Production were not inspected** (rule). Neither was any customer Company DB, so their orphan counts are unknown. A plain `ADD CONSTRAINT` fails the whole migration on the first orphan, mid-release, per Company.
- Migrations run per Company DB through the release orchestrator. A failing one blocks that Company's release.

Proposed shape (if authorized):
1. **Phase 1 migration:** `ADD CONSTRAINT … NOT VALID` on `purchase_requests`, `purchase_orders`, `goods_receipts`, `sales_orders` (nullable, so NULLs pass), `warehouse_transactions` (`warehouseId` + `destinationWarehouseId`), `work_orders`. NOT VALID enforces every new/updated row immediately, skips the full-table scan, and cannot fail on legacy orphans.
2. **Pre-flight report** (read-only, per Company): orphan count per table/column, using the LEFT JOIN query used above. Orphans are triaged by the CTO (re-point to a real warehouse, or cancel the document), never auto-deleted. Documents carry process state and audit history.
3. **Phase 2 migration:** `VALIDATE CONSTRAINT` once each Company reports zero orphans. Takes only a SHARE UPDATE EXCLUSIVE lock.

## 6. Open items for the CTO
1. Authorize (or decline) the FK plan in §5. If authorized, decide what happens to legacy orphan documents.
2. **Work Order create has the same gap** (`WorkOrderService.createWorkOrder`, `work_orders.warehouseId`, no FK). It needs a Manufacturing-owned one-line fix plus a spec. Not changed here because Manufacturing is closed and handed off.
3. Should PR/PO/SO also refuse an **inactive** warehouse (409), as warehouse transactions do?
4. bv_co test rows (4 PRs above) are closure test data. Leave them, or discard them with the bv env.
5. Related, not changed: `purchase_request_lines.productId` *does* have an FK to `products`, so an unknown product on a PR currently surfaces as a DB FK violation (likely 500), not a 404. Same check pattern applies if wanted.
