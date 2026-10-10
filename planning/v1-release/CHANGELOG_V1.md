# Changelog — V1 Release

Not a project is-not-a-git-repo commit log (this workspace has no `.git`); this lists the concrete changes made across this release-preparation session, most recent first.

## Security fixes (this round)

- `backend/src/foundation/authentication/auth.controller.ts`, `auth.service.ts` — BLOCKER fix: `/auth/register` is bootstrap-only-when-empty, admin-authenticated afterward.
- `backend/src/domains/crm/interface/customers.controller.ts` — HIGH fix: `:id/assign` now requires admin/sales_manager.
- `backend/src/domains/commerce/interface/products.controller.ts` — HIGH fix: `create`/`updateUnit`/`setStatus`/`updatePrice` now require admin.
- `backend/src/domains/inventory-warehouse/application/warehouse-transactions.service.ts` — HIGH fix: default-deny for actions outside the role map (closes the `auto_post` bypass).
- `backend/src/domains/sales-orders/application/sales-orders.service.ts` — MEDIUM fix: default-deny for `transitionOrder` (closes `start_review`/`auto_release` bypass).
- `backend/src/domains/shipment/application/shipment.service.ts`, `interface/shipment.controller.ts` — MEDIUM fixes: default-deny for `transitionShipment` (closes `return_to_sender`/`retry` bypass); added `assertDriverOrAdmin` (shared helper); IDOR fix on `getShipment`/`getTrackingHistory`.
- `backend/src/domains/delivery/application/delivery.service.ts`, `interface/delivery.controller.ts` — MEDIUM fixes: `recordCollection` now authorization-checked; IDOR fix on `getOutcomeForShipment`/`getCollectionForShipment`.
- `backend/src/domains/deposit-control/application/deposits.service.ts`, `interface/deposits.controller.ts` — MEDIUM fixes: `submitDeposit`/`getDeposit`/`getLatestDepositForOrder` now scope-checked via `SalesOrdersService.getOrder`.
- `backend/src/domains/reports/application/reports.service.ts` — updated call site for the `getLatestDepositForOrder` signature change.
- `backend/src/foundation/integrations/interface/integration-auth.guard.ts` — LOW fix: constant-time credential comparison.
- Spec files updated for the above: `delivery.service.spec.ts`, `shipment.service.spec.ts` (plus one new test), `deposits.service.spec.ts`.

## UI fixes (this session)

- `frontend/src/components/Layout.tsx` — sidebar accordion (single-open-group state, replacing independent per-group booleans).
- `frontend/src/pages/Reports.tsx` — Sales Orders report rows are now clickable, navigating to the order's detail page.

## Warehouse ERP Phase 1 (this session)

- Backend: `inventory-warehouse` domain — `WarehouseStatus` (new), Warehouse Master fields (`location`, `responsibleUserId`, `status`), `assertWarehouseActive`, whole-document atomic `postTransaction` rewrite, `movementDate`, `getWarehouseInventoryPage` (server-side paginated inventory grid query), manager-scoped transactional reads (`getAvailableInTransaction`, `reserveStockInTransaction`).
- Backend: `commerce` domain — `Product.unit` field, `updateUnit` endpoint.
- 4 new migrations: warehouse master fields, warehouse-transaction `movementDate` (with backfill), product `unit`, warehouse-master terminology seed.
- Frontend: `Inventory.tsx` rebuilt as a real ERP-style grid (search/sort/pagination/Excel export); `Warehouses.tsx` extended (location/responsible-user/status); `MovementCenter.tsx` (Assemble panel); `WarehouseTransactionForm.tsx`/`Detail.tsx` (`movementDate`, active-warehouse filtering); `Products.tsx` (`unit` field).
- Unit test coverage added for all of the above (`inventory.service.spec.ts`, `warehouse-transactions.service.spec.ts`).

## Sales Order / Customer pricing and reservation (earlier this session, carried into this release)

- Three-tier pricing (Manager > Rep > Price List), `priceListPrice`/`unitPrice` snapshot persistence, order-creation-time stock reservation inside the order's own transaction, per-rep sequence numbering, customer-visibility-by-rep scoping — all verified fresh in this release round (see `SALES_ORDER_COMPLETION_REPORT.md` / `LIVE_E2E_VERIFICATION_REPORT.md`).
