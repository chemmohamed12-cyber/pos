# Authorization Foundation — F6 Phase Report: Controlled Scope Pilot + Effective Access Preview (2026-10-07)

Scope (CTO directive, Blueprint §9 / amendment A4): scope enforcement on **exactly four pilot areas** — Inventory / Warehouse Transactions, PR / PO / GR, Sales Orders, Treasury Accounts — plus the scope management surface and the Effective Access Preview. **No other domain receives scope enforcement during Foundation.**
Environment: isolated PG 127.0.0.1:5656 (bv_* databases, backend 3601, frontend 5601) and `d3verify_main` for specs. `daii_dev` and Production untouched. No push.
Prerequisite: F5 closed (`d55f839`).

## 1. What was implemented

**Scope model (Permission = what, Scope = where).** `AccessScopeService` is the single definition of "which organization units may this user work with": the closure (unit + descendants) of the user's `org_memberships` (kept as a scope source — ADR-031 treasury scoping has always read them, so nothing changes for existing Companies) **plus** their explicit `access_scopes` grants (`includeDescendants` on/off; a grant on the Company root is the explicit "All company"). `core.scope.unrestricted` (the Company administrator) sees everything. Resolution is one recursive-CTE statement for a scoped user and **no extra statement** for an unrestricted one (it reuses the request's authorization context); nothing is cached across requests, so a grant, a revoke or a role change is effective on the very next call.

**Scope key = the warehouse.** New nullable `warehouses.orgUnitId` (D12: a *link* to an org unit of type branch/warehouse, not a duplicate; inventory-tagged migration `1790011000000`). Every pilot record already carries a warehouse (stock movements, reservations, warehouse transactions, PR, PO, GR via its PO, sales orders), so one key scopes all of them. A warehouse without a link is **unscoped = visible to everyone** (ADR-031 §3: every existing Company behaves exactly as before until someone links a warehouse). An operational custody sub-location inherits its parent warehouse's unit. A sales order's branch is its warehouse's unit (no new column); an order without a warehouse (legacy) is unscoped. Treasury accounts keep their existing `orgUnitId` and now resolve through the same service (the old per-unit descendant loop is gone).

**Enforcement (layered, declarative).**
- `WarehouseScopeGuard` + `@WarehouseScoped(sources)` — for any route that addresses or creates something in a warehouse (query / path / body / "the warehouse of this record"), checked before the handler; denial is **404, never 403** (anti-enumeration, ADR-005). A transfer needs **both** warehouses in scope.
- Lists / reports / exports filter by the caller's visible warehouses **in the query, before returning or aggregating** (warehouses, stock report, movements report, warehouse-transaction list/page/overview KPIs, PR list, PO list, sales-order list/page). `@WarehouseScopeFiltered` marks them.
- `@WarehouseScopeExempt(reason)` — reviewable "not warehouse data" declarations (templates, reason codes, bulk-create of unlinked warehouses).
- **Coverage spec**: every route of the six pilot controllers must carry one of the three markers, the guard must sit on every pilot controller, and the pilot is exactly those six controllers (a new unscoped route, or scope leaking into another domain, fails the build).

**Management + preview.** `GET/PUT /company/users/:userId/scopes` (administration authority `core.company.members.manage`; target must be an ACTIVE member of this Company; a grant is **contained by the actor's own scope** — the administrator may grant anything; narrowing/removal is always allowed; audited as `company.user.scopes_changed`). `GET /company/users/:userId/effective-access?node=&level=&warehouseId=&orgUnitId=` — the preview is computed with the *same functions the guards use* (`AuthorizationContext.hasAtLeast` + `AccessScopeService`) and names the layer that refuses (permission vs scope), lists the units and the visible/hidden warehouses. `POST /inventory/warehouses/:id/org-unit` links/unlinks a warehouse (needs the warehouse **and** the new unit inside the caller's scope; audited `inventory.warehouse.org_unit_changed`); creating a warehouse accepts an optional link. Removing a member deletes their explicit scope grants (a person invited again later does not silently regain a scope). `/auth/me` `scopes.orgUnitIds` now includes explicit grants (same single statement, with a fallback for a not-yet-migrated database).

**UI.** Company Users → **Scope** button opens the access-scope panel (explicit grants add/remove with sub-units toggle, effective units, visible/hidden warehouses, and an "ask: can they?" preview). Warehouses → an **Organization unit** column (select) and a field on the create form.

## 2. Files
Backend — new: `scope/access-scope.entity.ts`, `access-scope.service.ts`, `warehouse-scope.decorator.ts`, `warehouse-scope.guard.ts`, `company/company-access-scope.controller.ts`, migrations `core/1790010000000-AccessScopes` and `inventory/1790011000000-AddWarehouseOrgUnit`, specs `access-scope.f6.real-pg.spec.ts` (11) and `warehouse-scope.coverage.spec.ts` (19). Modified: `scope-resolver.service.ts`, `scope.module.ts`, `core-company-entities.ts`, `company.module.ts`, `company-user-management.service.ts`, `auth-me.service.ts`, `warehouse.entity.ts`, inventory / warehouse-transactions / purchase-request / purchase-order / goods-receipt / sales-orders controllers and services, three module files, one treasury spec constructor. Frontend: `components/AccessScopePanel.tsx` (new), `CompanyUsers.tsx`, `Warehouses.tsx`. Tool: `authz-tools/f6-http-verification.js` (+ four pilot endpoints in the A/B harness).

## 3. Tests
- **Real PG (two disposable Companies)** — `access-scope.f6.real-pg.spec.ts`, 11/11: administrator unrestricted; a user with no scope sees only unlinked warehouses; a membership is a scope source with descendants and the custody sub-location inherits its parent; explicit grant = membership, `includeDescendants=false` stops at the unit; "All company" grant reaches every unit; `assertWarehouse` 404 / unlinked / unknown; **Company A's scope never reaches Company B**; `describe()`; grants contained by the actor's scope (new/widened only), removal always allowed, unknown unit 400; `WarehouseScopeGuard` for query / record / body sources, transfers need both sides, fails open only on data and closed on structure.
- **Coverage** — 19/19.
- **Mutation checks (4/4 killed)**: guard never asserts → 2 failures; descendants removed → 8; `allowsUnit` always true → 4; a pilot route loses its declaration → coverage fails.
- **Real HTTP on the booted bv backend (Verify Co + Fresh Co 3 as the A/B)** — `f6-http-verification.js`, **39/39 passed** (the first run was 38/39 — one assertion in the script counted audit rows wrongly; corrected, then re-run in full): two branches (X, Y), three new warehouses linked X / Y / unlinked and the demo warehouse that holds the existing order and PO linked to Y for the run (restored afterwards), three operators with **identical permissions** whose only difference is scope (x belongs to X, y has an explicit grant on Y, n has nothing). Verified on every pilot surface: warehouse list; stock; warehouse inventory; assign-items / re-link / status; stock and movement reports (filtered before aggregation); warehouse-transaction create (source and transfer destination), count, list, paginated list, overview KPIs, detail, lines, transition; PR create / list / detail / all four transitions; PO list / detail / transitions / create; GR list and post derived from the PO; sales-order list, paginated list, detail, lines, edit-history, transition, draft edit, delete, create; reservations by order. A grant is **effective on the next call (no re-login)**, removal likewise; **Effective Access Preview ≡ guards on 9/9 (3 users × 3 warehouses)** and it names scope vs permission; scope management is administration-only (operator 404/403, unknown unit 400, non-member 404, no token 401); audit rows present; Company B untouched; restore verified; member removal deletes the grants.
- **Browser** (bv frontend): the Warehouses page shows the Organization unit column with selects; the Company Users **Scope** panel opens (explicit grants, units, visible/hidden warehouses, preview, add-unit select populated from the org tree).

## 4. Regression (affected areas: foundation, procurement, accounting company-isolation ×3, treasury, sales-orders, crm, inventory-warehouse, shipment, returns, fulfillment)
First run **817/834 passed (116 suites)**. The 17 failures are exactly the four characterization suites that need the HR instance on port 5544 (never executed here); **no other failure**, including every Protected Baseline spec in the set (approval engine isolation, treasury isolation, procurement isolation, sales-orders isolation, GRNI, authorization suites). The full-repo regression stays reserved for the final release gate.

## 5. Security / isolation
- Scope lives in the **Company database** (`access_scopes`, `org_units`, `warehouses`): a scope can never cross Companies (proved on two real databases and over HTTP).
- Out of scope = 404 on every pilot surface; the unscoped, unknown-id and non-UUID cases are decided by data (they fall through to the handler / DTO), structure fails closed.
- Anti-elevation for scope: a grant outside the actor's own scope is refused as "not found"; the administrator (unrestricted) is the only one who can grant the Company root.
- The preview cannot disagree with the guards because it calls the same functions; the HTTP property check (9/9) confirms it end to end.
- Zero behaviour change by default: with no linked warehouse every scoped user still sees everything they saw before (empty `access_scopes`, unlinked warehouses = visible).

## 6. Performance (interleaved A/B vs the pre-F1 build, 3 runs × N=100, zero non-200; administrator session)
| Endpoint | pre p50/p95 (ms) | F6 build p50/p95 (ms) | Δp50 | Δp95 |
|---|---|---|---|---|
| auth/me | 5.1/7.2 | 5.7/8.0 | +11% | +11% |
| me/navigation | 72.0/93.4 | 5.7/7.7 | −92% | −92% |
| sales-orders (pilot) | 6.9/9.4 | 8.1/10.7 | +17% | +13% |
| purchase-orders (pilot) | 6.9/9.9 | 6.5/9.0 | −5% | −8% |
| purchase-requests (pilot) | 7.0/9.9 | 6.6/9.5 | −6% | −4% |
| inventory/warehouses (pilot) | 4.7/7.2 | 5.6/8.1 | +20% | +12% |
| warehouse-transactions page (pilot) | 5.4/7.9 | 6.4/9.8 | +18% | **+25%** (at the limit) |
| inventory/reports/stock (pilot) | 4.8/6.4 | 5.6/7.7 | +17% | +21% |
| accounting/accounts | 7.0/11.1 | 7.9/12.9 | +13% | +16% |
| customers | 6.6/8.6 | 6.9/8.8 | +4% | +2% |
| organization/units (F1 intentional boundary cost) | 3.2/4.7 | 4.8/6.9 | +50% | +46% (≈ +1.5–2 ms) |
All guarded endpoints are ≤ +25% p95; `warehouse-transactions` sits exactly at the limit. For the administrator the F6 cost is at most ONE statement (the request's authorization context, where no earlier guard had loaded it); a scoped user costs one more (the scope CTE). **Not measured here**: scoped-user latency on its own (the harness session is the administrator) — flagged as a residual. The measured numbers include F1–F5 changes, not F6 alone (the F5 report has the same endpoints at similar values).

## 7. Status
**IMPLEMENTED → INTEGRATED → VERIFIED** (real PG, booted backend, real HTTP, A/B isolation, allow/deny, audit, mutation checks, preview ≡ guards, affected-area regression, browser). UAT READY pending the CTO items.

## 8. Decisions recorded, residual risks
Decisions taken inside the Blueprint (flagged for the record):
1. **Scope source = org memberships ∪ explicit grants** (memberships kept for ADR-031 compatibility; Blueprint's `access_scopes` added). A person who "belongs" to a unit therefore also *reaches* its data.
2. **One scope key — the warehouse** (sales orders and PR/PO/GR derive from their warehouse; the Blueprint's per-order `orgUnitId` column was deliberately not added). Legacy orders without a warehouse are unscoped.
3. **Cross-branch transfers**: a transaction involving two warehouses is visible/actionable only to someone whose scope covers both (read and write); handled by users scoped to both sides (e.g. central logistics) or the administrator.
4. A grant can only be made inside the actor's own scope; removing a member removes their grants.

Residuals (not in the pilot by decision A4, or not yet measured):
- **Other domains still read pilot data unscoped**: reports (sales / stock overviews other than the four inventory endpoints), customer accounts / AR, fulfilment, shipments, returns, `/inventory` consumers in other modules. Enforcing there is Expansion work; until then an out-of-scope user can still see order totals through those surfaces.
- Excel exports `warehouses/export`, `reports/*/export` and the opening-stock import row filter use the same service filters but were not exercised through a file upload/download in the HTTP run.
- Creating a warehouse **with** a link is not separately audited (re-linking and every scope grant are); the link is visible on the record.
- Org units can't be deleted via the API: the bv Verify Co keeps the test units (`F5 Team…`, `F6 Branch X/Y…`) and three deactivated F6 warehouses.
- Departments as a scope dimension and per-role-assignment / own-records-only scope are Expansion (A4).
- Scoped-user latency (one extra CTE) is a design cost, not yet measured separately.

## 9. Evidence index
`backend/docs/decisions/authz-tools/f6-http-verification.js`; specs `access-scope.f6.real-pg.spec.ts`, `warehouse-scope.coverage.spec.ts`; mutation log in the session; bv databases migrated with `1790010000000` / `1790011000000`.

## 10. CTO items
Foundation F1–F6 are now implemented. Open decisions, unchanged from F5 plus F6: authorize F4-B (Company-owned integrations); retire the platform `admin` alias; D17 default for new Companies; mail provider; D16 second approver; support self-grant policy; run the four characterization suites on the 5544 instance; **confirm scope Expansion order** (which domains after the pilot) and whether a scoped user's reports in other domains must be filtered before the Foundation release.
