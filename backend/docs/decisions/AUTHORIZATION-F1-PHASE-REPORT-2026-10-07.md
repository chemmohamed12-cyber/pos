# Authorization Foundation — F1 Phase Report (2026-10-07)

Scope: F1.1 AuthorizationContext · F1.2 additive `/auth/me` · F1.3 frontend `can()/inScope()` · F1.4 server-driven navigation · F1.5 F-1 Organization boundary · F1.6 tests.
Environment: isolated PG 127.0.0.1:5656, backend 3601 (bv_* DBs). `daii_dev` and Production untouched. No push.
Commit: `4388b34`.

## 1. What was implemented
- **AuthorizationContext** — roles + every `role_permissions` row for the request's user, loaded in ONE SQL statement from the Company DataSource (or ambient tables in platform mode), memoized on the request only, fail-closed (a failed load leaves no cache entry). Semantics are identical to `PermissionService.resolve` (ancestor chain, most specific per role, most permissive across roles, deny by default).
- `RolesGuard` / `PermissionGuard` read from the context when it is injectable (`@Optional`), legacy path otherwise.
- **`/auth/me`** additive: legacy `id/email/fullName/roles` unchanged; new `identity, platform, company, membership, capabilities, scopes, entitlements, policyFlags, authzVersion, legacyRoles`. Company claim honoured only if the Membership exists. Capabilities are entitlement-filtered and are a UX hint, never an authority.
- **Frontend**: `lib/authz.ts` (`canFrom`, `inScopeFrom`), `AuthContext` exposes `authz/can/inScope/refreshAuthz`; PO goods-receipt and supplier-invoice payment actions use `can()` (server still enforces).
- **Navigation** resolves through the context (≈172 statements → 1 per request).
- **F-1 Organization**: controller on `CompanyContextGuard` + Company DataSource; platform tokens without a Company get 403; writes keep `@RequireRole('admin')`. Core migration `1790002000000-EnsureOrgUnitCode` (idempotent; `org_units.code` was missing in non-HR Company DBs) and the HR retire migration made idempotent.

## 2. Files
Backend: `authorization/{authorization-context.ts, authorization-context.service.ts, role-classification.ts, authorization.module.ts, roles.guard.ts}`, `permission/{permission-catalog.ts, permission.guard.ts}`, `authentication/{auth-me.service.ts, auth.controller.ts, authentication.module.ts}`, `navigation/{navigation.controller.ts, navigation.service.ts}`, `organization/{organization.controller.ts, organization.module.ts}`, 2 migrations.
Frontend: `lib/authz.ts`, `context/AuthContext.tsx`, `pages/procurement/{PurchaseOrders,SupplierInvoices}.tsx`.

## 3. Tests (all green when run)
| Spec | Result |
|---|---|
| authorization-context.spec (unit, equivalence with resolve) | 6/6 |
| authorization-context.company-isolation (real PG, A/B) | 7/7 |
| auth-me.contract | 8/8 |
| navigation-authorization-context | 2/2 |
| organization.company-isolation (real PG) | 5/5 |
| Real HTTP against booted backend (script `f1-http.js`) | 14/14 |
| Browser: Organization screen under Company token; GR form via `can()` | verified |

## 4. Regression (affected areas: foundation, procurement, treasury, sales-orders, crm, inventory-warehouse)
First run: 104 suites, **700/718**. Failures: the 4 characterization suites (need the HR instance on port 5544, owned by another session — NOT executed) and one `grni-posting` test that passes alone (2/2). Attribution run on the pre-F1 build: see §9.

## 5. Security / isolation
Same identity with two Company tokens gets two different authorization views (different company, membership id, authzVersion); forged `x-company-id`/`x-roles` headers and `companyId` query are ignored; forged bearer → 401; the org unit created under Verify Co is absent in Fresh Co 3 and the platform `org_units` table is untouched; platform token without Company → 403 on `/organization/units`. No privilege widening: context semantics proven equal to `resolve`.

## 6. Performance (interleaved A/B vs real pre-F1 build, mean of 3 runs, N=150 each)
| Endpoint | pre p50/p95 (ms) | F1 p50/p95 (ms) | Δp50 | Δp95 |
|---|---|---|---|---|
| health | 2.5/4.2 | 2.4/4.7 | −3% | +13% |
| **auth/me** | 5.6/9.2 | 6.8/11.2 | **+20%** | **+22%** |
| me/navigation | 87.4/141.4 | 9.9/15.1 | −89% | −89% |
| memberships | 7.9/11.2 | 7.3/11.3 | −7% | +1% |
| accounting/accounts | 8.3/12.7 | 8.7/13.7 | +5% | +8% |
| sales-orders | 8.8/12.6 | 9.3/13.2 | +6% | +5% |
| approvals/requests | 8.5/12.1 | 7.4/10.5 | −13% | −13% |
| purchase-orders | 7.9/11.7 | 7.1/10.3 | −10% | −12% |
| **organization/units** | 4.7/6.2 | 6.5/8.8 | **+39%** | **+41%** |

Normal guarded routes are within the +25% budget. Two deviations:
- `/auth/me`: +1.2/+2.0 ms absolute; the payload is now richer (Company roles, 359-node capability map, entitlements, scopes). The F1 criterion said "≤ baseline" — **not met literally**.
- `/organization/units`: +1.8/+2.6 ms absolute; intentional — the route now runs the Company guard chain (membership + company status) it previously skipped (that was the F-1 leak).

## 7. Status
IMPLEMENTED · INTEGRATED · VERIFIED (isolated env) with the two performance deviations above. Not UAT READY.

## 8. Blockers / decisions requested from the CTO
1. Accept the two deviations (recommended: absolute cost ≈ 2 ms, one is the security fix), **or** order further reduction of `/auth/me` before F2.
2. Characterization suites (HR instance on 5544) remain unexecuted by this session.

## 9. grni-posting attribution
Pending the pre-F1 run; result appended below when available.
