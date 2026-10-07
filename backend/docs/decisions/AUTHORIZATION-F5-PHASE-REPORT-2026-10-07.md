# Authorization Foundation — F5 Phase Report: Legacy Authorization Migration (2026-10-07)

Scope (CTO directive 2026-10-06/07): Map → Dual-check → Migrate → Retire on the hard-coded role decisions (backend call sites + frontend `hasRole()`), success condition **Capability Diff = ∅**; `/admin/sales-reps` becomes Company-aware (`sales_rep` is a Company-scoped role); Approval Engine keeps the path JWT → Company Context → Permission → Resource Company Ownership → Approval.
Environment: isolated PG 127.0.0.1:5656 (bv_* databases, backend 3601, frontend 5601) and `d3verify_main` for specs. `daii_dev` and Production untouched. No push.
Prerequisite: F4 closed (`cbee96e`).

## 1. What was implemented

**Map.** `foundation/authorization/workflow-rules.ts` expresses every legacy role decision once, as a *workflow rule* with a capability node in the `wf.<module>.<area>.<action>` namespace (46 rules: sales-order lifecycle + stage edits + manager price + list/read-any, customer reviewer, rep directory and "act as rep", shipment/returns/fulfilment, warehouse-transaction actions, scope-unrestricted, organization management, 8 menu rules). The namespace is deliberately outside the module prefixes, so a module-wide grant (e.g. `sales: editable` in a template) can never silently confer a power the old role key gated (that would be a capability *gain*).

**Dual-check.** `WorkflowAccess` (`authorization/workflow-access.ts`) answers a rule under `AUTHZ_WORKFLOW_MODE`: `legacy` (role list only — rollback), `dual` (role list OR capability — can only add; every disagreement counted in `WORKFLOW_DIVERGENCE`), `capability` (target). `AuthorizationService.workflowAccess(userId, manager?)` loads roles + grants with ONE statement (shared `loadAuthorizationContext`, same as the request context); `RolesGuard` gained `@RequireWorkflow(rule)` for routes; `NavigationService` gained `workflowRule` on menu items.

**Migrate.** Migration `1790009000000-WorkflowCapabilityGrants` (additive, idempotent, frozen snapshot, no-op `down`) grants each rule's node to the Company roles that held the legacy key, and to `admin` for all of them; the `admin` seeding for new Companies includes the nodes. Call sites moved: sales-orders (submit/resubmit/approve/reject chain, stage edits, manager price, list/read, draft edit/delete), shipments (8), returns (6), fulfilment, warehouse transactions, customers (reviewer ×4), scope service + resolver, organization writes (3), navigation (13 items), `POST /auth/register` (platform capability `platform.user.create` ∨ legacy platform `admin`). Frontend: all **107** `hasRole()` uses converted to `can()` / `canPlatform()` against the real backend nodes or `wf.*` rules; `hasRole` removed from `AuthContext`.

**Retire (the default).** `DEFAULT_WORKFLOW_MODE = 'capability'`. Rollback = `AUTHZ_WORKFLOW_MODE=legacy|dual` + restart, no deploy. Monitor: `GET /platform/authz/workflow-divergence` (`platform.audit.view`).

**`/admin/sales-reps`.** Moved out of the platform `AdminController` into `SalesRepsDirectoryController` (`JwtAuthGuard → CompanyContextGuard → RolesGuard + @RequireWorkflow('sales.rep.list')`): the reps of the CURRENT Company, read from that Company's own `roles/user_roles`. Same URL and result shape. The Customers screen now loads its rep list from it (the former `/admin/users` was the platform's user table and 403'd for Company-only administrators).

**Approval Engine.** Verified, not changed: every route already runs `JwtAuthGuard → CompanyContextGuard → RolesGuard → PermissionGuard` and threads the Company manager; a request id of another Company does not exist in the caller's database (Model B), so resource ownership is structural (covered by `approval-engine.company-isolation.spec.ts`, green). D6 / PR-PO maker-checker untouched.

## 2. Files
Backend — new: `workflow-rules.ts`, `workflow-access.ts`, `authorization-context.loader.ts`, `workflow-rules.spec.ts`, `admin/sales-reps-directory.controller.ts`, migration `1790009000000`. Modified: `authorization.service.ts`, `authorization-context.service.ts`, `roles.guard.ts`, `require-role.decorator.ts`, `permission-catalog.ts`, `capability-catalog.ts`, `company-role-seeding.ts`, `navigation-registry.ts`, `navigation.service.ts`, `organization.controller.ts`, `admin.controller.ts`/`admin.module.ts`, `auth.controller.ts`, `platform.controller.ts`, `scope.service.ts`, `scope-resolver.service.ts`, sales-orders / shipment / returns / fulfillment / warehouse-transactions / customers services (+ the two action-role maps), 3 specs (navigation ×2, company-admin-role-seeding). Frontend: 49 pages/components + `AuthContext`. Tool: `authz-tools/f5-http-verification.js` (+ `customers` endpoint added to the A/B harness).

## 3. Tests
- `workflow-rules.spec.ts` (10): migration snapshot == rule map (no drift); **legacy decision == capability decision for all 512 combinations of the 9 legacy role keys × 46 rules (23,552 decisions, 0 divergence)**; deny by default; read-only is not enough; a Company-designed role with the grant passes in `capability`/`dual` but not `legacy`; `dual` never removes a legacy permission; `capability` removes the legacy leg; divergence counters; unknown rule throws.
- Real HTTP (bv, `f5-http-verification.js`): **27/27 in `dual`** and **26/26 in `capability`** (the one dual-only assertion is skipped): capabilities mirror each legacy role (manager, supervisor, rep, finance, warehouse worker, driver, bare member, administrator = all 46); menus per role; `/admin/sales-reps` Company A/B isolation + allow/deny; organization writes allow/deny; a custom Company role granted `wf.core.organization.manage` works and stops working when removed; customer reviewer vs unassigned rep; `register` refused for non-admins; divergence endpoint platform-only; **`dual` run: legacyOnly = 0** (the one `capabilityOnly` is the intentional custom-role probe).
- Browser (bv frontend 5601): administrator sees organization form/assign, warehouse create/import/deactivate, product create/edit, shipping methods, price-list create, customer rep/classification/policy/price-list columns (rep list from `/admin/sales-reps`, 200); a `warehouse_worker` sees none of the administration controls on the same screens and keeps fulfilment.

## 4. Capability Diff (success condition)
- Model: 512 role combinations × 46 rules → **0**.
- bv Companies (every user of Verify Co, Fresh Co 3, Fresh Co 4): before the migration 184/184 rule decisions diverged (as expected — the grants did not exist); **after: 0/184**; the 1,452 non-workflow effective capability levels compared before/after are **identical (0 diffs)**. bv has only administrator identities, so role variety is carried by the model proof and the HTTP run.

## 5. Regression (affected areas: foundation, procurement, accounting company-isolation ×3, treasury, sales-orders, crm, inventory-warehouse, shipment, returns, fulfillment)
First run (capability default): **760/804 passed; 114 suites.** 44 failures: 17 are the four characterization suites that need the HR instance on port 5544 (never executed here — `provisioning-lifecycle`, `module-add-existing-company`, `limits-scope`, `ui-created-company-admin`); 27 were caused by this change and are fixed: navigation specs' mocked `AuthorizationService` lacked `workflowAccess` (19), `RolesGuard` read the workflow metadata key through a mocked reflector that returns the role array (now `typeof === 'string'`, 5), `company-admin-role-seeding` expected 4 fixed nodes (now 4 + 46, 3). Failures were cleared individually (the three affected groups re-run green, 70/70 with the authorization folder). No Protected Baseline spec (NAV, ESC-3, D1–D10, T0, PRC-01, D7–D9, CUS-01, FA-02, INV-03, journal numbering) appears among the failures; the full-repo regression remains reserved for the final release gate.

## 6. Security / isolation
- Platform authority never implies Company authority and vice versa: `register` uses the ambient (platform) context only; `/admin/sales-reps` and every workflow decision read the Company database through the request context / the Company manager.
- `/admin/sales-reps`: Company B's token never lists Company A's rep (HTTP A/B).
- Anti-elevation unchanged: wf nodes are `low`/`sensitive` (none of the 19 critical nodes); custom roles granting them are subject to the F3 rules.
- Deny by default: unknown rule → exception, never allow; a member with no role holds no workflow capability.
- Intentional visibility change (reported, not a power change): the menu/links to `/admin`, `/integrations`, `/release-center` still key on the legacy `admin` role (see §8); the Layout's platform dropdown now keys only on platform capabilities (`canPlatform`), not on the Company-side `admin` role key (those routes were already 403 for a Company-only administrator).

## 7. Performance (interleaved A/B vs the pre-F1 build, 3 runs × N=100, zero non-200)
| Endpoint | pre p50/p95 (ms) | F5 build p50/p95 (ms) | Δp50 | Δp95 |
|---|---|---|---|---|
| auth/me | 5.3/7.7 | 5.7/8.6 | +6% | +13% |
| me/navigation | 70.8/95.9 | 5.8/8.9 | −92% | −91% |
| memberships/mine | 4.1/6.5 | 4.8/7.2 | +18% | +11% |
| accounting/accounts | 6.9/10.3 | 8.8/12.2 | +28% | +18% |
| sales-orders | 6.7/9.2 | 7.3/10.8 | +8% | +17% |
| approvals/requests | 6.1/8.2 | 5.8/8.7 | −5% | +6% |
| purchase-orders | 6.8/9.6 | 7.0/9.8 | +2% | +2% |
| customers (F5 path) | 5.8/7.5 | 5.9/8.2 | +2% | +10% |
| organization/units (F1 intentional boundary cost) | 3.2/4.5 | 4.7/7.5 | +45% | +65% (≈ +1.5–3 ms) |
Same as the F4 build within noise (sales-orders p95 +17% vs F4's +32% outlier). `/auth/me` and `/me/navigation` ≤ baseline criterion is met for navigation; `/auth/me` p95 +13% is the same F1/F4 residual (single-digit ms). Guarded endpoints are under +25% p95. The services that used to run two statements (`user_roles` then `roles`) for a role check now run one.

## 8. Status, decisions recorded, residual risks
Status: **IMPLEMENTED → INTEGRATED → VERIFIED** (real PG, booted backend, real HTTP both modes, browser, A/B isolation, allow/deny, regression as above). UAT READY pending the CTO items below.

Residual / not in F5 by decision:
1. **Integrations** (`integrations.controller.ts`, 15 `@RequireRole('admin')`) — F4-B (AZ-13 Company-owned connections) awaits the CTO's go; **Media** (`media.controller.ts`, 1 check) — AZ-14, its own phase.
2. **Platform plane `admin` alias** (`AdminController.assertMayChangeRole`, `PlatformGuard`, `auth.controller` register) and the three platform menu entries keep the legacy ambient `admin` role as a documented alias of Platform Super Admin; retiring it needs the CTO's decision on re-assigning existing platform admins to `platform_super_admin`.
3. `sales.service.isSalesRep` is a designation lookup (is this user a sales representative profile), not an authorization decision — kept.
4. Remaining `getRoleKeysForUser` uses are data reads (user listings, permission-service role-id join) or audit "before" snapshots.
5. Role keys equal to the legacy keys created later by a Company do not receive the `wf.*` grants automatically (only roles existing when the migration ran, and `admin` at provisioning) — they are granted explicitly via role management.
6. D17 default for new Companies (`administratorRole`) is still `admin`; flipping it to `company_admin` is the pending CTO decision (it would drop the wf powers from new Companies' first administrator unless they are added to that template).

## 9. Evidence index
`backend/docs/decisions/authz-tools/f5-http-verification.js`; specs `workflow-rules.spec.ts`, `navigation*.spec.ts`, `company-admin-role-seeding.spec.ts`; scratch tools (not committed): `bv-wf-diff.js` (Capability Diff on bv), `bv-cap-snapshot.js` before/after.

## 10. CTO items
Authorize F4-B; decide the platform `admin` alias retirement; D17 default flip (with the wf grants question above); mail provider; D16 second approver; support self-grant policy; running the four characterization suites on the 5544 instance. **F6 (controlled scope pilot) starts next unless the CTO holds it.**
