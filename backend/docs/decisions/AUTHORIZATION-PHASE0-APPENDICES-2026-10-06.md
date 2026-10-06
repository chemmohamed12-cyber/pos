# Authorization Phase 0 — evidence appendices (2026-10-06)

Generated read-only from the source (`backend/src`, `frontend/src`) and from SELECT-only queries on the **isolated** environment (`bv_cp` + Company DBs on 127.0.0.1:5656). **No code, schema, migration or data was changed. `daii_dev` was not touched.** Companion to `AUTHORIZATION-PHASE0-REPORT-2026-10-06.md`.

## A. Hard-coded role call-site inventory (backend)

Read-only scan of `backend/src` (excluding specs, migrations, test helpers, template/entitlement catalogs). A "call-site" is a source line that tests or declares a legacy/template role key (`@RequireRole`, `roles.includes(...)`, action→roles maps, navigation `roles:[…]`). Lines where `finance`/`sales_rep` are *module codes, node names or enum values* were filtered out. **89 true role call-sites in 22 files.**

| Legacy key | Call-sites | Files |
|---|---|---|
| `admin` | 67 | customers.service.ts, fulfillment.service.ts, warehouse-transactions.service.ts, returns.service.ts, sales-orders.service.ts, shipment.service.ts, admin.controller.ts, installation-audit.controller.ts, auth.controller.ts, auth.service.ts, company-registry.controller.ts, installation-membership.controller.ts, integrations.controller.ts, media.controller.ts, navigation-registry.ts, organization.controller.ts, release.controller.ts, scope-resolver.service.ts, scope.service.ts |
| `driver` | 1 | navigation-registry.ts |
| `finance` | 5 | customers.service.ts, sales-orders.service.ts, shipment.service.ts, navigation-registry.ts |
| `inventory_controller` | 9 | warehouse-transaction-action-roles.ts, navigation-registry.ts |
| `sales_manager` | 10 | customers.service.ts, sales-orders.service.ts, order-action-roles.ts, admin.controller.ts, navigation-registry.ts |
| `sales_rep` | 4 | sales.service.ts, order-action-roles.ts, admin.controller.ts |
| `sales_supervisor` | 12 | customers.service.ts, returns.service.ts, sales-orders.service.ts, order-action-roles.ts, shipment.service.ts, navigation-registry.ts |
| `warehouse_supervisor` | 9 | warehouse-transaction-action-roles.ts, navigation-registry.ts |
| `warehouse_worker` | 20 | fulfillment.service.ts, warehouse-transaction-action-roles.ts, returns.service.ts, sales-orders.service.ts, shipment.service.ts, navigation-registry.ts |

| File | Sites | Kinds | Keys | Lines |
|---|---|---|---|---|
| `foundation/navigation/navigation-registry.ts` | 16 | navigation/registry roles[] | admin, inventory_controller, warehouse_supervisor, warehouse_worker, driver, sales_supervisor, finance, sales_manager | 92, 99, 100, 101, 102, 112, 121, 122, 123, 124, 160, 161, 447, 448, 449, 450 |
| `foundation/integrations/interface/integrations.controller.ts` | 15 | @RequireRole decorator | admin | 106, 112, 118, 124, 130, 137, 143, 149, 155, 161, 167, 173, 179, 185, 192 |
| `domains/sales-orders/application/sales-orders.service.ts` | 11 | constant map; literal; service check | admin, sales_manager, sales_supervisor, finance, warehouse_worker | 70, 76, 77, 78, 405, 426, 463, 643, 898, 1030, 1134 |
| `domains/shipment/application/shipment.service.ts` | 8 | service check; literal | admin, finance, warehouse_worker, sales_supervisor | 274, 314, 441, 467, 492, 556, 633, 1375 |
| `domains/returns/application/returns.service.ts` | 7 | literal; service check | sales_supervisor, warehouse_worker, admin | 155, 273, 280, 286, 301, 321, 393 |
| `domains/sales-orders/domain/order-action-roles.ts` | 6 | constant map | sales_rep, sales_supervisor, sales_manager | 13, 14, 15, 16, 17, 18 |
| `domains/inventory-warehouse/domain/warehouse-transaction-action-roles.ts` | 5 | constant map | inventory_controller, warehouse_worker, warehouse_supervisor | 11, 12, 13, 14, 15 |
| `foundation/admin/admin.controller.ts` | 4 | literal; @RequireRole decorator; service check | admin, sales_manager, sales_rep | 47, 49, 81, 84 |
| `foundation/organization/organization.controller.ts` | 3 | @RequireRole decorator | admin | 44, 56, 64 |
| `domains/fulfillment/application/fulfillment.service.ts` | 2 | constant map; service check | warehouse_worker, admin | 16, 205 |
| `domains/crm/application/customers.service.ts` | 1 | constant map | admin, finance, sales_manager, sales_supervisor | 42 |
| `domains/inventory-warehouse/application/warehouse-transactions.service.ts` | 1 | service check | admin | 349 |
| `domains/sales/application/sales.service.ts` | 1 | constant map | sales_rep | 8 |
| `foundation/audit/installation-audit.controller.ts` | 1 | @RequireRole decorator | admin | 24 |
| `foundation/authentication/auth.controller.ts` | 1 | service check | admin | 146 |
| `foundation/authentication/auth.service.ts` | 1 | service check | admin | 75 |
| `foundation/company/company-registry.controller.ts` | 1 | @RequireRole decorator | admin | 88 |
| `foundation/company/installation-membership.controller.ts` | 1 | @RequireRole decorator | admin | 39 |
| `foundation/media/media.controller.ts` | 1 | service check | admin | 86 |
| `foundation/release/release.controller.ts` | 1 | @RequireRole decorator | admin | 112 |
| `foundation/scope/scope-resolver.service.ts` | 1 | constant map | admin | 8 |
| `foundation/scope/scope.service.ts` | 1 | constant map | admin | 31 |

Also present (role *API* use with a dynamic key, e.g. `getRoleKeysForUser` in `RolesGuard`, `PermissionService`, `NavigationService`, `ScopeService`, `ScopeResolver`, `AuthorizationService`, `auth.controller`) — these are the engine itself, not call-sites to migrate.

## B. `hasRole()` / `user.roles` frontend migration inventory

Read-only scan of `frontend/src`. **107 usages in 43 files** — by context: derived flag 19, render gate 61, roles list display 9, other 13, logic branch 5. By role literal: `admin` 79, `sales_manager` 13, `sales_rep` 8, `warehouse_worker` 8, `finance` 7, `inventory_controller` 4, `warehouse_supervisor` 4, `sales_supervisor` 1.

Migration rule (Blueprint §13): `render gate` / `derived flag` → `can(capability)`; `logic branch` → `can()` or a backend-provided flag; `roles list display` → show Company membership roles. The legacy `/auth/me.roles` field stays until every row below is migrated.

| File | Usages | Arguments / context |
|---|---|---|
| `pages/Customers.tsx` | 11 | 'admin' (logic branch); 'admin', 'sales_manager' (logic branch); 'admin' (render gate); 'admin', 'sales_manager' (render gate) |
| `pages/sales-orders/SalesOrdersDetail.tsx` | 7 | 'sales_supervisor', 'admin' (other); 'sales_manager', 'admin' (other); 'admin', 'finance' (other); 'admin' (other); 'sales_manager', 'admin' (render gate); ...a.roles (other) |
| `pages/Shipments.tsx` | 5 | 'admin' (render gate); 'admin' (other); 'admin' (logic branch) |
| `components/ReserveStockPanel.tsx` | 4 | 'sales_rep' (render gate) |
| `pages/Organization.tsx` | 4 | 'admin' (logic branch); 'admin' (render gate) |
| `pages/procurement/PurchaseOrders.tsx` | 4 | 'admin' (render gate) |
| `pages/procurement/PurchaseRequests.tsx` | 4 | 'admin' (render gate) |
| `pages/procurement/Rfqs.tsx` | 4 | 'admin' (render gate) |
| `pages/procurement/Suppliers.tsx` | 4 | 'admin' (render gate) |
| `pages/Products.tsx` | 4 | 'admin' (render gate) |
| `pages/Warehouses.tsx` | 4 | 'admin' (logic branch); 'admin' (render gate) |
| `components/DepositPanel.tsx` | 3 | 'admin', 'finance' (derived flag); 'sales_rep' (render gate) |
| `pages/Inventory.tsx` | 3 | 'admin' (render gate); 'warehouse_worker', 'admin' (render gate) |
| `pages/procurement/SupplierInvoices.tsx` | 3 | 'admin' (render gate) |
| `pages/Returns.tsx` | 3 | 'sales_rep' (render gate); ...a.roles (other); 'warehouse_worker' (render gate) |
| `pages/warehouse/WarehouseTransactionDetail.tsx` | 3 | 'warehouse_supervisor', 'inventory_controller' (other); 'warehouse_supervisor' (other) |
| `pages/covers/ShippingCover.tsx` | 2 | 'admin', 'finance' (derived flag); 'admin' (render gate) |
| `pages/SalesReturns.tsx` | 2 | 'sales_rep' (render gate); 'warehouse_worker' (render gate) |
| `pages/ShipmentReturns.tsx` | 2 | 'warehouse_worker' (render gate) |
| `components/Layout.tsx` | 1 | 'admin' (render gate) |
| `context/AuthContext.tsx` | 1 | ...roles: string[] (other) |
| `pages/CollectionSettlements.tsx` | 1 | 'admin', 'finance' (derived flag) |
| `pages/covers/AccountingCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/AdminCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/AttendanceCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/CommissionCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/HrCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/PayrollCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/ReportsCover.tsx` | 1 | 'admin', 'finance' (derived flag) |
| `pages/covers/TargetsCover.tsx` | 1 | 'admin' (derived flag) |
| `pages/covers/TreasuryCover.tsx` | 1 | 'admin', 'finance' (derived flag) |
| `pages/CustodianDetail.tsx` | 1 | 'warehouse_worker', 'inventory_controller', 'admin' (derived flag) |
| `pages/Fulfillment.tsx` | 1 | 'warehouse_worker', 'admin' (derived flag) |
| `pages/PriceLists.tsx` | 1 | 'admin', 'sales_manager' (derived flag) |
| `pages/ReleaseCenter.tsx` | 1 | 'admin' (derived flag) |
| `pages/Reports.tsx` | 1 | 'admin', 'finance' (other) |
| `pages/sales-orders/SalesOrdersCreate.tsx` | 1 | 'sales_manager', 'admin' (derived flag) |
| `pages/sales-orders/SalesOrdersEdit.tsx` | 1 | 'sales_manager', 'admin' (derived flag) |
| `pages/ShippingMethods.tsx` | 1 | 'admin' (derived flag) |
| `pages/warehouse/MovementCenter.tsx` | 1 | 'warehouse_worker', 'admin' (render gate) |
| `pages/warehouse/StockCountEntry.tsx` | 1 | 'warehouse_supervisor', 'inventory_controller' (render gate) |

## C. Platform authorization inventory

Every route that does **not** run `CompanyContextGuard` (77 of 584 routes in 12 controllers + the installation controllers), its **current** guard and the **proposed** `platform.*` node (Blueprint §11). Verified by reading each controller; the generic scan under-reported route-level decorators on the config/limit/entitlement controllers, completed by hand.

| Controller → route(s) | Current guard | Proposed platform node |
|---|---|---|
| installation/companies — GET, GET :id | @RequireRole(admin) | platform.company.view |
| installation/companies — POST | @RequireRole(admin) | platform.company.create |
| installation/companies/:id — suspend / reactivate / decommission | @RequireRole(admin) | platform.company.suspend / .reactivate / .decommission |
| installation/companies/:id/memberships — GET | @RequireRole(admin) | platform.membership.view |
| installation/companies/:id/memberships — POST / DELETE / PATCH | @RequireRole(admin) | platform.membership.grant / .revoke / .update |
| installation/companies/:id/audit — GET | @RequireRole(admin) | platform.audit.view |
| installation — module-catalog, plans (GET) | @RequireRole(admin) | platform.plan.view |
| installation — plans (POST create/update) | @RequireRole(admin) | platform.plan.manage |
| installation/companies/:id/package — GET / POST | @RequireRole(admin) | platform.entitlement.view / .manage |
| entitlement — GET admin/entitlement, POST admin/entitlement/apply | node core.entitlement.view / .apply (ambient) | platform.entitlement.view / .manage (alias core.entitlement.*) |
| entitlement — GET me/entitlements | JWT only | unchanged (any authenticated user; Company-aware) |
| release — backups, restores, releases, data-repairs (≈30 routes) | @RequireRole(admin) + node system.release.view/backup/restore/deploy/rollback | platform.release.view / .backup / .restore / .deploy / .rollback (alias system.release.*) |
| config — GET keys, PUT/DELETE values | node core.config.view / .edit (ambient) | platform.config.view / .edit (alias core.config.*) |
| limits — keys, usage, profiles | node core.limit.view / .edit (ambient) | platform.limit.view / .edit (new namespace member) |
| admin — GET users | @RequireRole(admin) | platform.user.view (Platform Users screen); the Company screen moves to the Company directory (F2) |
| admin — POST users/:id/status, reset-password, profile | @RequireRole(admin) | platform.user.disable / .reset_password / .update |
| admin — POST roles/assign, roles/revoke | @RequireRole(admin) — writes the AMBIENT catalog | platform.role.assign (platform roles only); Company role assignment moves to Company authority (F2) |
| admin — GET sales-reps | @RequireRole(admin, sales_manager) — ambient | NOT platform: Company-plane (F2/F5); duplicate of the Company-scoped sales/reps |
| auth — register, login, refresh, select-company, change-password, me | JWT / public / throttled | unchanged (identity plane); register → platform.user.create (+ Company invitation, §3) |
| health, terminology, navigation | public / JWT | unchanged |
| organization — GET units, units/:id/members; POST/DELETE (admin) | JWT only; writes @RequireRole(admin) — ambient | **Not platform** — becomes Company-plane (AZ-03, F1) |
| integrations/connectors (15 routes), integrations/qr/:connectorId/orders | @RequireRole(admin) / IntegrationAuthGuard — ambient | **Needs classification (tenant-type data outside the Company plane)** — finding AZ-13 |
| media — POST upload, GET :id | JWT only; admin check inside the controller — ambient | **Needs classification** — finding AZ-14 |

**Ambient (platform) role data observed on the isolated environment:** 29 role keys / 75 grants in the control plane; ambient `user_roles`: both test users hold `admin` (= platform super-admin today); no user without a membership; no user without an ambient role. The ambient `admin` role carries module-wide grants for ERP modules in addition to platform nodes (ERP templates are still seeded into the ambient catalog at boot).

## D. Permission → Capability mapping (PROPOSED — requires sign-off)

Generated from the 209 existing nodes (no renames). A **capability** groups the nodes of one resource into business bundles: **View**, **Manage** (create/edit/assign/submit), **Authorize** (approve/post/award/release…), and each **Critical** node on its own. Risk: `low` · `sensitive` · `critical` · `platform-critical` (platform-plane nodes). Heuristic classification — the Phase 0 sign-off review may change any row.

### accounting (63 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| account | `account.view` | `account.edit`, `account.create`, `account.assign` | — | — |
| currency | `currency.view` | `currency.create`, `currency.edit` | — | — |
| exchange_rate | `exchange_rate.view` | `exchange_rate.create` | — | — |
| fiscal_year | `fiscal_year.view` | `fiscal_year.create` | — | — |
| fiscal_period | `fiscal_period.view` | `fiscal_period.edit` | — | `fiscal_period.reopen` |
| closing_snapshot | `closing_snapshot.view` | — | `closing_snapshot.verify` | — |
| closing_exception | `closing_exception.view` | `closing_exception.annotate_test_artifact` | — | `closing_exception.resolve` |
| tax_code | `tax_code.view` | `tax_code.create`, `tax_code.edit` | — | — |
| tax_period | `tax_period.view` | `tax_period.create` | — | — |
| dimension | `dimension.view` | `dimension.create`, `dimension.edit` | — | — |
| ap | `ap.view` | `ap.create` | `ap.approve` | `ap.adjust` |
| ar | `ar.view` | `ar.create` | `ar.approve` | `ar.adjust` |
| cash | `cash.view` | `cash.create` | `cash.approve` | `cash.adjust` |
| fixed_asset | `fixed_asset.view` | `fixed_asset.create`, `fixed_asset.edit` | `fixed_asset.approve` | `fixed_asset.post`, `fixed_asset.adjust` |
| journal | `journal.view` | `journal.create`, `journal.edit`, `journal.submit` | `journal.post` | `journal.reverse` |
| ledger | `ledger.view` | — | — | — |
| report | `report.view` | — | `report.export` | — |
| financial_event | `financial_event.view` | — | — | — |
| grni | `grni.view` | `grni.create` | — | — |
| inventory | `inventory.view` | `inventory.create` | `inventory.approve` | `inventory.adjust` |
| wip | `wip.view` | `wip.create` | — | — |

### attendance (14 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| connector | `connector.view` | `connector.create` | — | — |
| mapping | `mapping.view` | `mapping.create`, `mapping.edit` | — | — |
| raw_record | `raw_record.view` | — | — | — |
| manual_entry | — | `manual_entry.create` | — | — |
| import | `import.view` | `import.create` | — | — |
| day | `day.view` | — | — | — |
| correction | — | `correction.create` | — | — |
| approval | `approval.view` | `approval.create` | `approval.approve` | — |

### commission (6 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| policy | `policy.view` | `policy.create` | — | — |
| result | `result.view` | — | — | — |
| batch | — | `batch.submit` | `batch.approve` | — |
| adjustment | — | `adjustment.create` | — | — |

### core (8 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| approval | `approval.view` | `approval.manage` | — | — |
| config | `config.view` | — | — | `config.edit` |
| entitlement | `entitlement.view` | — | — | `entitlement.apply` |
| limit | `limit.view` | — | — | `limit.edit` |

### finance (4 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| invoice | — | — | `invoice.post` | `invoice.cancel` |
| payment | — | `payment.create` | — | — |
| (module) | — | `` | — | — |

### hr (11 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| department | `department.view` | `department.create`, `department.edit` | — | — |
| employee | `employee.view` | `employee.create`, `employee.edit`, `employee.link_user` | — | `employee.terminate` |
| leave_request | `leave_request.view` | `leave_request.create` | `leave_request.approve` | — |

### inventory (11 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| valuation | `valuation.view` | — | — | — |
| warehouse | — | `warehouse.create`, `warehouse.edit` | — | — |
| movement | `movement.view` | `movement.create` | — | — |
| assembly | — | `assembly.create` | — | — |
| reservation | — | `reservation.create` | `reservation.release` | — |
| transaction | — | `transaction.create` | — | — |
| stock_count | — | `stock_count.create` | — | `stock_count.adjust` |

### logistics (13 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| collection | `collection.view` | — | `collection.post` | — |
| return | — | — | — | `return.adjust` |
| sales_return | `sales_return.view` | `sales_return.create` | `sales_return.post` | — |
| shipment_return | `shipment_return.view` | `shipment_return.create` | `shipment_return.post` | — |
| carrier | — | `carrier.create`, `carrier.edit` | — | — |
| vehicle | — | `vehicle.create`, `vehicle.edit` | — | — |

### manufacturing (22 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| bom | `bom.view` | `bom.create`, `bom.edit` | — | `bom.delete` |
| routing | `routing.view` | `routing.create`, `routing.edit` | — | `routing.delete` |
| work_center | `work_center.view` | `work_center.create`, `work_center.edit` | — | `work_center.delete` |
| work_order | `work_order.view` | `work_order.operation_execute`, `work_order.create`, `work_order.material_issue`, `work_order.material_return`, `work_order.finished_goods_receive` | `work_order.release`, `work_order.hold`, `work_order.complete`, `work_order.cancel` | — |

### payroll (10 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| period | `period.view` | `period.create` | — | — |
| compensation | `compensation.view` | `compensation.create` | — | — |
| run | `run.view` | — | `run.calculate`, `run.review` | `run.approve`, `run.disburse` |
| adjustment | — | `adjustment.create` | — | — |

### procurement (24 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| goods_receipt | `goods_receipt.view` | `goods_receipt.create` | — | — |
| purchase_request | `purchase_request.view` | `purchase_request.create`, `purchase_request.edit` | `purchase_request.approve` | — |
| purchase_order | `purchase_order.view` | `purchase_order.create`, `purchase_order.edit` | `purchase_order.approve` | — |
| rfq | `rfq.view` | `rfq.create`, `rfq.edit`, `rfq.record_quotation` | `rfq.award` | — |
| supplier_invoice | `supplier_invoice.view` | `supplier_invoice.create` | `supplier_invoice.post` | `supplier_invoice.void` |
| supplier_payment | `supplier_payment.view` | `supplier_payment.create` | — | — |
| supplier | `supplier.view` | `supplier.create`, `supplier.edit` | — | — |

### reporting (2 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| finance | `finance.view` | — | `finance.export` | — |

### sales (10 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| catalog | — | `catalog.edit`, `catalog.create` | — | — |
| price_list | — | `price_list.edit` | — | — |
| customer | — | `customer.assign`, `customer.edit` | — | — |
| customer_status | — | `customer_status.edit` | — | — |
| customer_financial | — | `customer_financial.edit` | — | — |
| deposit | — | — | `deposit.approve`, `deposit.reject` | — |
| rep | — | `rep.assign` | — | — |

### system (5 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| release | `release.view` | — | — | `release.backup`, `release.restore`, `release.deploy`, `release.rollback` |

### targets (3 nodes)

| Resource | View | Manage | Authorize | Critical (own capability each) |
|---|---|---|---|---|
| target | `target.view` | `target.create` | `target.approve` | — |

**Totals (206 nodes + 3 `COMPANY_*` constants):** platform-critical 7 · platform-read 4 · critical 19 · sensitive 61 · low 115.

**Gaps the mapping exposes (inputs to F3):** (1) **treasury** has one module-wide node `finance`@`editable` on every route — view, cash-in, cash-out, transfer and reverse cannot be separated; reads need `editable`; (2) no `export` nodes outside reports/accounting; (3) no templates for procurement, payroll, attendance, commission, targets, treasury; (4) `reverse` exists only for journals — warehouse-transaction reversal is a legacy-role action (`warehouse_supervisor`), not a node; (5) workflow-stage duties (supervisor/manager approval of sales orders, warehouse-transaction submit/approve/post, returns authorize/receive, shipment dispatch) are legacy-role actions with **no node at all** — they need *workflow capabilities* (Blueprint §14).

## E. Company-Admin critical-permission analysis

**Today (verified on the isolated Company DBs):** the Company role `admin` holds **module-wide `editable`** on every entitled module — `accounting, attendance, commission, finance, hr, inventory, logistics, manufacturing, payroll, procurement, reporting, sales, targets` — plus `core.approval`, `core.config`, `core.entitlement`, `core.limit`, `system.release`, `system.release.backup`, and the three Company-administration nodes (`core.company.members.manage`, `.backup.manage`, `.audit.view`). Ancestor-walk inheritance means **every node under those modules is granted at `editable`.**

* **Critical operational/financial nodes reachable today by a Company admin: 19** (all of them): `accounting.fiscal_period.reopen`, `accounting.closing_exception.resolve`, `accounting.ap.adjust`, `accounting.ar.adjust`, `accounting.cash.adjust`, `accounting.fixed_asset.post`, `accounting.fixed_asset.adjust`, `accounting.journal.reverse`, `accounting.inventory.adjust`, `finance.invoice.cancel`, `hr.employee.terminate`, `inventory.stock_count.adjust`, `logistics.return.adjust`, `manufacturing.bom.delete`, `manufacturing.routing.delete`, `manufacturing.work_center.delete`, `payroll.run.approve`, `payroll.run.disburse`, `procurement.supplier_invoice.void`.
* **Platform-plane nodes also present in the Company `admin` role (and in the ambient `admin`):** `core.config.view`, `core.config.edit`, `core.entitlement.view`, `core.entitlement.apply`, `core.limit.view`, `core.limit.edit`, `system.release.view`, `system.release.backup`, `system.release.restore`, `system.release.deploy`, `system.release.rollback` — `core.config`, `core.entitlement`, `core.limit` and `system.release*` (module-wide). They are harmless to Company data today only because their controllers are ambient (never read the Company DB), but they violate the "Company Admin ≠ Platform authority" rule on paper and must not be copied into the new `company_admin`.
* **Behaviour that silently depends on `admin` being all-powerful (hard-coded `admin` literal in business logic):** sales-order manager-price override, released-order edit, review-stage edit; shipment actions (dispatch/reconcile/cancel paths), returns authorization/receipt, fulfilment worker bypass, warehouse-transaction role gate (`isAdmin` bypass), customers REVIEWER set, media access, `ScopeService`/`ScopeResolver` unrestricted scope. Section A lists each site. **Tightening `admin` in place would change all of them.**

**Conclusion / recommended resolution of the A2↔A5 conflict (no silent permission loss):** introduce `company_admin` as a **new system role key** (administration authority only: Users, Memberships, Roles, Scopes, Organization, Company settings, authorization audit, `core.company.*`, `core.approval.manage`, module administration nodes) used for **new Companies**, and keep the existing `admin` rows untouched in existing Companies, **relabelled "Legacy Administrator (Operational)"** (type `legacy`, identical grants). Existing Company admins therefore lose nothing; each Company can later narrow deliberately (assigning explicit roles, removing the legacy role) through the new editor. The `admin` literal call-sites are migrated to capabilities (F5) *before* any Company retires the legacy role. Role Management gets the anti-self-elevation rule (Blueprint §6.2) from day one.

**Critical list (19 operational + 11 platform):**

| Node | Class |
|---|---|
| `accounting.fiscal_period.reopen` | critical |
| `accounting.closing_exception.resolve` | critical |
| `accounting.ap.adjust` | critical |
| `accounting.ar.adjust` | critical |
| `accounting.cash.adjust` | critical |
| `accounting.fixed_asset.post` | critical |
| `accounting.fixed_asset.adjust` | critical |
| `accounting.journal.reverse` | critical |
| `accounting.inventory.adjust` | critical |
| `core.config.view` | platform-read |
| `core.config.edit` | platform-critical |
| `core.entitlement.view` | platform-read |
| `core.entitlement.apply` | platform-critical |
| `core.limit.view` | platform-read |
| `core.limit.edit` | platform-critical |
| `finance.invoice.cancel` | critical |
| `hr.employee.terminate` | critical |
| `inventory.stock_count.adjust` | critical |
| `logistics.return.adjust` | critical |
| `manufacturing.bom.delete` | critical |
| `manufacturing.routing.delete` | critical |
| `manufacturing.work_center.delete` | critical |
| `payroll.run.approve` | critical |
| `payroll.run.disburse` | critical |
| `procurement.supplier_invoice.void` | critical |
| `system.release.view` | platform-read |
| `system.release.backup` | platform-critical |
| `system.release.restore` | platform-critical |
| `system.release.deploy` | platform-critical |
| `system.release.rollback` | platform-critical |
