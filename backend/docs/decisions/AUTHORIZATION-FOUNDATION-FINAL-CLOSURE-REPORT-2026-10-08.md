# Authorization Foundation — Final Closure Report (2026-10-08)

**Mandate:** CTO HANDOFF — Authorization Foundation Closure (forensic review → continue from the previous team's stopping point → HR suites → Security/Mutation → Scoped Performance → Full Authorization Regression → Protected Baseline Regression → Evidence).
**Environment:** isolated only — Postgres `127.0.0.1:5656` (bv_* + d3verify_main, backend 3601, pre-F1 build 3602, statement-counting instance 3603) and the HR instance `127.0.0.1:5544`. **Production: HOLD, untouched. `daii_dev`: untouched. Push: none (the repository has no remote configured).** No commit was created in this pass (see §11).

## 0. Result

| Item | Status |
|---|---|
| F1 · F2 · F4 · F5 | **VERIFIED** |
| F3 | **VERIFIED** for the committed phase (`1f2feb6`); one F3 spec is red against the uncommitted Decision-3 delta → depends on **B1** |
| F6 | **VERIFIED** functionally and for security; **scoped-user performance gate NOT MET** → **B2** |
| CTO decisions 2 / 3 / 4-C (implementation) | **INTEGRATED · VERIFIED**, except the `wf.*` exception in Decision 3 → **B1** |
| **Authorization Foundation** | **BLOCKED — NOT CLOSED, NOT UAT READY** (two items need a CTO ruling: B1, B2) |

No security bypass, no cross-Company leakage, no Protected-Baseline regression was found. The two blockers are a **decision** (B1) and an **unmet acceptance gate** (B2); neither was resolved by changing a test, a threshold or the architecture.

### B1 — Architecture contradiction: `company_admin` automatically holds one `wf.*` node
The handoff (§5) states: the Initial Administrator receives `company_admin` and **does not automatically receive `wf.*`**. The previous team's uncommitted Decision-3 implementation seeds `company_admin` with `wf.core.organization.manage` (`company-nodes.ts` `COMPANY_ADMIN_ORGANIZATION_NODE`, `company-role-seeding.ts`, migration `1790012000000`), recorded in `AUTHORIZATION-CTO-DECISIONS-2026-10-07.md` as "the single deliberate exception". The node is the Organization-write rule (F5 moved `@RequireRole('admin')` Organization writes into the workflow namespace); it is an administration capability, not an ERP operation, and it is what lets `company_admin` build the org tree and place other people's scopes (`AccessScopeService.canAdministerAllUnits`).
*Evidence:* `company-roles.f3.real-pg.spec.ts` (committed, F3) asserts `company_admin` = exactly the four `core.company.*` nodes and fails with the extra `wf.core.organization.manage`; `closure-http-verification.js` shows the new Company's administrator holds exactly `["wf.core.organization.manage"]` in the `wf.*` namespace and nothing operational.
*Not done:* the F3 spec was **not** edited (that would change an acceptance criterion) and the node was **not** removed (that would strip Organization/Scope administration from every new Company) — the choice is the CTO's:
- **(a)** approve the node as a named exception to "no `wf.*`" → update the F3 spec expectation (cites the ruling), commit;
- **(b)** keep "no `wf.*`" literally: re-home Organization administration under a `core.company.*` administration node accepted by the Organization write rule (small, contained change in the rule/seed/migration, full re-verification);
- **(c)** remove it: a new Company's administrator then cannot build the org tree or place scopes; the platform plane must do it.

### B2 — Scoped-user performance gate not met
Acceptance (handoff §15): **scoped-user P95 ≤ approved baseline + 25 %**. The approved baseline used by every F1–F6 A/B is the **pre-F1 build** (3602). Fresh measurement in §5: **5 of 10 endpoints exceed** (worst +42 %). Measured against the F6 *administrator* in the same interleaved runs, the scoped user stays within **+22 %** everywhere — the scope mechanism alone fits the budget; the cumulative F1–F5 per-request authorization context **plus** the F6 scope statement does not. The previous team's own (never aggregated) runs of 2026-10-07 agree: +39 % and +62 %. Not hidden, not re-defined. Options for the CTO in §5.4.

## 1. F1–F6 status

| Phase | Commit | Phase-report status | Re-verified in this closure |
|---|---|---|---|
| F1 — request-scoped AuthorizationContext, `/auth/me`, navigation, Organization | `4388b34` `8a9d521` `1c562e6` | VERIFIED → UAT READY | full regression (§6) |
| F2 — Company Users, invitations, multi-role | `2059a20` | VERIFIED → UAT READY | regression; membership removal ⇒ grants removed (§4) |
| F3 — role metadata, taxonomy/risk, role management, `company_admin` | `1f2feb6` | VERIFIED → UAT READY | regression (1 spec red → B1); critical anti-elevation over HTTP (§4) |
| F4 — platform authorization, support access, integration catalog | `cbee96e` | VERIFIED → UAT READY (scope of F4) | regression; Decision 4-C over HTTP + DB (§4) |
| F5 — legacy authorization migration | `d55f839` | VERIFIED → UAT READY | regression; legacy-admin register (§2) |
| F6 — controlled scope pilot + Effective Access Preview | `33aae63` | VERIFIED (UAT READY pending CTO items) | regression; scope/cross-Company/no-mutation (§4); mutations (§4.4); scoped perf (§5 → B2) |

## 2. CTO decisions (approved, not reopened) and their verified implementation

| Decision | Implementation state | Evidence |
|---|---|---|
| D1 F4-B Hybrid integrations | Control-plane half exists since F4; Company-owned retrofit of `IntegrationsController` = **DEFERRED / NOT YET IMPLEMENTED** | `AUTHORIZATION-CTO-DECISIONS-2026-10-07.md` |
| Legacy `admin` → alias → retirement | **No-new-dependency ceiling enforced**: `legacy-admin-dependency.register.spec.ts` (frozen per-file ceiling, shrink-only, no `admin → company_admin` mapping) — green in §6. Final retirement **DEFERRED** | regression |
| New Company = `company_admin` | Provisioning default flipped; explicit `'admin'` kept as opt-in. **Verified**: real provisioning on 5544 (4/4), real HTTP provisioning of a new Company (§4.2), mutation "default flipped back" killed. `wf.*` exception → **B1** | §3, §4, §4.4 |
| Mail provider = XNEXUSTECH-managed | No Company-visible credential exists; managed provider wiring **NOT YET IMPLEMENTED**; Company SMTP **DEFERRED** | — |
| D16 second approver | No global policy; PR/PO maker ≠ checker unchanged; thresholds **DEFERRED / POLICY REQUIRED** | regression (procurement maker/checker specs green) |
| Support self-grant prohibited | `SupportAccessService.grant`: named grantee ≠ grantor, refusal audited; support membership never gets a scope/role | §4.3 (DB-proven), mutation killed |

## 3. HR characterization suites (Step A) — HR instance `127.0.0.1:5544`
Previous team: 17/17 at 12:44 and 13:04 on 2026-10-07, **before** the scope optimisation of 16:59 — therefore re-run on the current tree (password passed via environment from the local file, never printed).

| Suite | Env / port | Passed | Failed | Skipped | Classification |
|---|---|---|---|---|---|
| `limit-engine/limits-scope.characterization.spec.ts` | isolated / 5544 | 5 | 0 | 0 | — |
| `database-provisioning/module-add-existing-company.characterization.spec.ts` | isolated / 5544 | 5 | 0 | 0 | — |
| `database-provisioning/ui-created-company-admin.characterization.spec.ts` | isolated / 5544 | 3 | 0 | 0 | — |
| `database-provisioning/provisioning-lifecycle.characterization.spec.ts` | isolated / 5544 | 4 | 0 | 0 | — |
| `database-provisioning/new-company-default-administrator.verification.spec.ts` (Decision 3) | isolated / 5544 | 4 | 0 | 0 | — |
| **Total** | | **21** | **0** | **0** | **VERIFIED** |

## 4. Security / mutation verification (Step B)
Real HTTP against the booted backend (3601), test identities only. **New tool** `authz-tools/security-mutation-verification.js`: every refused call is bracketed by md5 fingerprints of the tables it could touch in Company A's DB, Company B's DB and the control plane (`access_scopes, user_roles, roles, role_permissions, org_units, org_memberships, warehouses, purchase_requests, warehouse_transactions, sales_orders` / `user_company_memberships, user_roles`); a refusal passes only with the refusal status **and zero change**. Positive controls prove the fingerprints detect real writes. A = Verify Co, B = Fresh Co 3, unauthorized support target = Fresh Co 4.

### 4.1 Scope — 13/13
Out-of-scope stock read, PR create, warehouse-transaction create, transfer to an out-of-scope destination, warehouse status change → **404, no mutation**; a user without members.manage granting itself → 404, no mutation; a delegated people-manager (scope X, not org admin) granting another user a unit **outside its own scope** → 404, no mutation; the same manager **adding to** or **widening** its own scope → **403 `SELF_SCOPE_CHANGE`, no mutation**; granting inside its scope → 200 (mutation detected — control); **removing a membership removes its grants** (DB rows 2 → 0); the removed member's still-valid token → 403.

### 4.2 Cross-Company — 12/12
A→A **ALLOW** (200), B→B **ALLOW** (200, no A warehouse visible); A-only member selecting B → 401, B-only member selecting A → 401 (no mutation); A administrator changing scopes / roles of a B user from an A token → 404, no mutation; B administrator changing scopes of an A user → 404; B administrator "removing" an A user → 200 **no-op** (removal is bound to the token's Company; the A membership and every fingerprint unchanged — F2 idempotent design); B token on an A warehouse id → no A data.

### 4.3 Support — 11/11
Self-grant → **403 `SELF_GRANT_PROHIBITED`**; un-named grantee (old "for myself" default) → 400; Platform Super Admin self-grant → 403; another platform user grants → 201 (control); holder self-extends → 403 (expiry unchanged); **self-grant on an unauthorized Company → 403**; selecting the unauthorized Company → 401; support (inside A) giving itself a scope / a role / Company Admin / an ERP write → 404; administrator giving the support membership a scope → 409 `SUPPORT_ACCESS_FIXED`; every refusal **without mutation**; each refused self-grant audited (`platform.support_access.self_grant_denied`, `denied`).

**Total: 40/40 assertions passed** (`secmut-2`).

### 4.2b Decision 3 / 4-C over real HTTP — `closure-http-verification.js` — **23/23**
Test defect found and fixed in the previous team's script: it assumed Verify Co has a `company_admin` role row; every bv Company predates Decision 3 (legacy `admin`, D17 keeps existing Companies unchanged). The script now provisions a Company through the real `POST /installation/companies` path; its initial membership carries `company_admin` (never `admin`). Also corrected: the operator role it created reached a **critical** node (`inventory` → `inventory.stock_count.adjust`), which the F3 risk-aware anti-elevation correctly refuses (403 `ROLE_EXCEEDS_GRANTOR`) — now asserted explicitly and a non-critical role is used. Result: `company_admin` holds exactly `wf.core.organization.manage` in `wf.*` (→ B1) and no ERP capability (four ERP writes 404); administers organization, users and roles of others; cannot change its own roles (`SELF_ROLE_CHANGE`) or scope (`SELF_SCOPE_CHANGE`); Effective Access Preview refuses `sales.order.create` by permission; no reach into another Company.

### 4.4 Mutation testing — 6/6 killed
Re-run because the scope service was rewritten after the previous team's 4/4 (single-statement scope + warehouse visibility):

| Mutation | Spec | Result |
|---|---|---|
| D3 default flipped back to `admin` | new-company-default-administrator (5544) | KILLED (4 failed) |
| D4-C self-grant check removed | platform-authorization.f4.real-pg | KILLED |
| self-scope-widening check removed | cto-decisions-2026-10-07.real-pg | KILLED |
| `company_admin` seeded with every `wf` node | cto-decisions-2026-10-07.real-pg | KILLED |
| *new:* `assertWarehouse` resolved-map path never refuses | access-scope.f6.real-pg | KILLED (3 failed) |
| *new:* `visibleWarehouseIds` resolved-map path returns hidden warehouses | access-scope.f6.real-pg | KILLED (3 failed) |
Sources restored and checked (no mutant residue; diff identical before/after).

### 4.5 Finding outside authorization (registered, not fixed here)
**UNRELATED PRE-EXISTING DEFECT (data integrity, procurement):** `POST /procurement/purchase-requests` accepts a `warehouseId` that does not exist in the Company and persists it (`purchase_requests` has no FK). Identical on the pre-F1 build (3602) and the current build. Not cross-Company leakage (Company B is never read or written — fingerprints) and not an authorization regression (F6's guard deliberately leaves "unknown warehouse" to the handler, which does not report it). Proposed as a separate task. Test rows it produced in `bv_co`: 3 draft PRs with warehouse ids `…000000003605`, `…000000003606` and a Fresh Co 3 warehouse id.

## 5. Scoped-user performance (Step C)

### 5.1 Method
`authz-tools/scoped-user-latency.js` (previous team's harness, unchanged): same build, same environment, same endpoints; three sessions **interleaved with rotating order** — pre-F1 administrator (3602, the approved baseline), F6 administrator (3601), F6 scoped user (3601, explicit grant on one branch, linked warehouse); warm-up 5; **N = 100 per session per endpoint, 3 runs**; any non-200 discards the endpoint's run; throttler respected. Statements per request counted exactly on the measurement-only instance 3603. Machine otherwise idle (trace instances stopped, no Jest running).

### 5.2 Result (mean of 3 valid runs; zero non-200; ms)

| Endpoint | pre-F1 admin p50/p95/p99 | F6 admin p50/p95/p99 | F6 **scoped** p50/p95/p99 | scoped vs pre-F1 p95 | scoped vs F6 admin p95 | stmts admin → scoped | Gate (≤ +25 %) |
|---|---|---|---|---|---|---|---|
| sales-orders list | 10.2/14.2/28.4 | 12.4/18.1/35.2 | 14.1/20.2/52.2 | **+42 %** | +11 % | 11 → 12 | **FAIL** |
| sales-orders page | 9.8/14.0/30.8 | 10.9/16.6/33.1 | 12.5/18.7/35.3 | **+33 %** | +13 % | 11 → 12 | **FAIL** |
| sales-orders/:id | 10.5/18.5/50.2 | 11.3/17.3/36.4 | 13.1/19.9/44.0 | +7 % | +15 % | 14 → 16 | pass |
| purchase-orders | 7.9/11.8/17.7 | 7.3/11.0/28.3 | 8.8/13.3/21.4 | +13 % | +20 % | 7 → 8 | pass |
| purchase-requests | 7.9/11.8/24.4 | 7.4/10.5/13.3 | 8.4/12.4/33.8 | +5 % | +18 % | 7 → 8 | pass |
| inventory/warehouses | 6.6/10.7/16.3 | 7.2/12.0/39.8 | 8.7/13.7/49.6 | **+29 %** | +15 % | 6 → 7 | **FAIL** |
| inventory/stock | 7.3/10.1/12.3 | 8.8/11.8/12.9 | 10.6/14.3/23.7 | **+42 %** | +22 % | 9 → 10 | **FAIL** |
| inventory/reports/stock | 6.6/9.4/20.4 | 7.7/11.3/35.1 | 9.5/13.0/29.1 | **+38 %** | +15 % | 7 → 8 | **FAIL** |
| warehouse-transactions page | 7.4/10.6/12.1 | 8.3/12.4/25.5 | 9.1/13.2/25.6 | +25 % | +7 % | 8 → 7 | pass (at limit) |
| warehouse-transactions/overview | 7.9/12.2/16.0 | 8.9/13.3/33.7 | 10.0/13.9/36.3 | +15 % | +5 % | 13 → 12 | pass |
Absolute cost of the worst cases: +4 to +6 ms p95 on 10–20 ms requests. In this session the F6 **administrator** also reads +27 % p95 on `sales-orders list` (F6 report: +13 %), i.e. part of the excess is the F1–F5 baseline drifting in this environment, not the scope.

### 5.3 Root-cause analysis (per-request SQL trace, measurement-only preload, current vs pre-F1)
- Inventory endpoints: pre-F1 5 statements → scoped 7: **+1** the request's authorization context (F1–F5, one `user_roles ⋈ roles ⋈ role_permissions` statement) **+1** the F6 scope statement (units closure + warehouse visibility in ONE statement — the previous team's optimisation; it lowered the scoped count by one statement per request, but the trace shows no further statement to remove there). Each local round trip ≈ 0.7–1 ms ≈ 10–15 % of these requests.
- `sales-orders` (all routes): the authorization context is loaded **twice per request for everyone** — once by the guard chain (memoised on the request) and once by `SalesOrdersService` through `AuthorizationService.workflowAccess(userId, manager)`, which bypasses the request memo (8 call sites). Removing it saves one statement for administrator and scoped user alike; it touches the Protected-Baseline sales-orders service, so it was **not** changed during closure.
- Purchase orders are cheaper than pre-F1 (10 → 7–8 statements: F5 removed role lookups).

### 5.4 Options for the CTO (none applied)
1. **Accept** the scoped-user cost as an intentional security-boundary cost (precedent: F1 `/organization/units`), recording the per-endpoint numbers above.
2. **Authorize optimisation**, then re-measure under the unchanged gate: (a) pass the request's `WorkflowAccess` into `SalesOrdersService` instead of reloading it (−1 statement on every sales-order request); (b) resolve the scope statement **in parallel** with the authorization context on `@WarehouseScoped` routes (latency = max instead of sum; precedent: F1 `/auth/me` speculative parallel reads, `8a9d521`) — costs one wasted parallel statement for unrestricted users.
3. Both: accept now for UAT, optimise as the first post-Foundation work package.

## 6. Full authorization regression (Step D) — whole repository, serial
Command: `npx jest --runInBand` on 5656 / `d3verify_main` (the HR-instance suites of §3 excluded here because they ran on 5544). Run 19:36:55Z → 20:05:41Z (22:36–23:05 Cairo — outside the 00–03 h window of the known grni day-boundary defect).

**166 suites: 162 passed, 3 failed, 1 skipped · 1 141 tests: 1 128 passed, 12 failed, 1 skipped.** Classification of every non-pass:

| Suite | Failed | Root cause | Classification | Action / state |
|---|---|---|---|---|
| `database-provisioning.service.unit.spec.ts` | 10 | Decision 3 flipped the provisioning default; the spec's module mock lacked `seedCompanyAdministratorRole` and asserted the legacy default | **TEST DEFECT** (incomplete Decision-3 integration by the previous team) | Aligned to the approved decision **without losing coverage**: default ⇒ `company_admin` asserted (and legacy role *not* seeded); a **new** test keeps the legacy `admin` path as explicit opt-in. **Re-run: pass** |
| `database-provisioning.service.spec.ts` (real PG) | 1 (2 assertions) | same: asserted the initial admin's `admin` grant/membership | **TEST DEFECT** (same) | Now asserts `company_admin` = 1 **and** `admin` = 0 (stricter). **Re-run: pass (18/18 for both files)** |
| `company-roles.f3.real-pg.spec.ts` | 1 | `company_admin` holds `wf.core.organization.manage` | **ARCHITECTURE CONTRADICTION** | **Not changed → B1** |
| `t0-clean-company-baseline.spec.ts` | skipped | opt-in audit run (`T0_BASELINE=1`), skipped by design | PRE-EXISTING CHARACTERIZATION BEHAVIOR | none |

Coverage of the handoff's §16 list, all in the green set: Company isolation (all `*.company-isolation` + real-PG two-Company harness specs), multi-role union / most-permissive resolution (F2/F3 specs), permission deny & scope deny (F6 + guards), entitlement (plans/limit-engine), Company lifecycle (incl. LA-1 admission specs), user lifecycle & invitations (F2), self-elevation prevention (F2/F3/CTO-decisions), role management (F3, except B1), scope management (F6/CTO-decisions), approval ownership & maker/checker (approval-engine, procurement ESC-3), `/auth/me` and navigation capability behaviour (F1/F5 specs), Platform vs Company separation (F4 real-PG, 10/10).

## 7. Protected Baseline regression (Step E)
**No Protected-Baseline regression.** Every domain suite passed: accounting (incl. GL / GRNI / fixed assets / event engine company-isolation, f03 deadlock retry, wip reconciliation), procurement (PR/PO/GR isolation and posting, maker ≠ checker), sales-orders, treasury, inventory-warehouse, CRM, customer-finance, fulfillment, shipment, returns, manufacturing (incl. `work-order-phase3-e2e`), HR / attendance / payroll / commission / targets. The only failures are the three foundation specs of §6, none in existing business functionality.

## 8. Scope coverage register
**Scope enforced / verified:** Inventory / Warehouse transactions (stock, movements, reservations, stock and movement reports) · Purchase Requests · Purchase Orders · Goods Receipts · Sales Orders · Treasury Accounts.
**NOT YET IMPLEMENTED / SCOPE EXPANSION (not a Foundation failure, not scope-enforced, must not be described as such):** Customer Accounts / AR · Reports (outside the four inventory report endpoints) · Fulfilment · Shipments · Returns · every other domain.

## 9. Deferred register (DEFERRED / NOT YET IMPLEMENTED — not failures)
Legacy `admin` final retirement (ceiling enforced, register shrink-only) · F4-B Company-owned integrations retrofit (15 `IntegrationsController` routes) · XNEXUSTECH-managed mail provider wiring · Company custom SMTP / provider · D16 second-approver thresholds (policy required) · support-access *request/approval* entity (prohibition enforced regardless) · Scope expansion beyond the F6 pilot · any module/domain not yet built.

## 10. Remaining risks
1. **B1** and **B2** (above) — closure blockers.
2. A `company_admin`-only Company has **no path inside the Company to a first holder of critical capabilities** (F3 risk-aware anti-elevation; e.g. `inventory` editable ⇒ `inventory.stock_count.adjust`): it must come from the platform plane (installation membership route / time-boxed support), as recorded in the F3 report (open item 2). Verified over HTTP (403 `ROLE_EXCEEDS_GRANTOR`). Consistent with "NOT ERP God Mode"; operationally the onboarding flow must cover it.
3. Pre-existing procurement data-integrity gap (§4.5).
4. Provisioning retry of a half-provisioned Company that was started under the old default reuses its existing `admin` membership row while seeding `company_admin` (reuse-as-is behaviour, unchanged) — edge case, no existing Company affected.
5. The grni 00:00–03:00 Cairo false-drift fix is **not in this tree** (memory: implemented elsewhere, uncommitted). A regression run inside that window would show the known pre-existing failure.
6. Uncommitted foreign work in the same tree: **LA-1 Layer 2** (SaaS Control Plane, 2026-10-06, status PARTIAL, awaiting CTO): two schedulers, `installation-audit.controller.ts`, `company-lifecycle-admission.ts` + spec, `FINAL-CLOSURE-PACKAGE.md`, `LA-1-…RECORD.md`. Not part of this closure, not modified; it is compiled into the same `dist` and its specs are green in §6.
7. Test residue in the isolated bv environment (no delete path): two provisioned test Companies `Closure Co 1791488199905` / `Closure Co 1791488574403` (with `cl.cadmin.*` administrators), test org units, deactivated test warehouses, the PRs of §4.5. Fixtures left by the previous team's crashed runs and by one crashed run here were cleaned **through the audited API** (3 warehouses deactivated, 4 test roles deleted, 2 test `support_operations` grants revoked).

## 11. Git evidence
Branch `master`, HEAD `33aae63` (F6). F-commits: F1 `4388b34`/`8a9d521`/`1c562e6`, F2 `2059a20`, F3 `1f2feb6`, F4 `cbee96e`, F5 `d55f839`, F6 `33aae63`. **No remote configured; nothing pushed.** **No commit made in this pass**: the closure delta (previous team's Decision 2/3/4-C implementation + this pass's test alignments and tools) stays uncommitted until B1 is ruled, because B1 decides part of its content.
Uncommitted — authorization closure delta (previous team, 2026-10-07): `support-access.service.ts`, `access-scope.service.ts`, `company-access-scope.controller.ts`, `company-role-seeding.ts`, `company-user-roles.ts`, `company-nodes.ts`, `database-provisioning.service.ts`, `platform-authorization.f4.real-pg.spec.ts`, new `1790012000000-CompanyAdminOrganizationNode.ts`, `cto-decisions-2026-10-07.real-pg.spec.ts`, `new-company-default-administrator.verification.spec.ts`, `legacy-admin-dependency.register.spec.ts`, `AUTHORIZATION-CTO-DECISIONS-2026-10-07.md`, `authz-tools/{closure-http-verification,scoped-user-latency,scoped-user-aggregate}.js`.
This pass: `database-provisioning.service.unit.spec.ts`, `database-provisioning.service.spec.ts` (Decision-3 alignment, §6); `authz-tools/closure-http-verification.js` (test-defect fixes, §4.2b); new `authz-tools/security-mutation-verification.js`; `authz-tools/README.md`; this report.
Uncommitted foreign: LA-1 Layer 2 files (§10.6).

## 12. Environment evidence
Postgres 18 `127.0.0.1:5656` (cluster in the previous session's scratchpad; `bv_cp`, `bv_co`, Fresh Co 3/4 DBs, `d3verify_main`); HR instance `127.0.0.1:5544` (`D:\DAII-ISOLATED-PG\data`, `isolated_admin`); backend 3601 = current `dist` (built 2026-10-07 17:03, no source newer — verified), pre-F1 build 3602, counting instance 3603 (`count-queries.js` preload); two SQL-trace instances 3605/3606 started for §5.3 and stopped afterwards. Raw outputs (session scratchpad `3e159832…/scratchpad`): `hr4-0108.{log,json}`, `closure-http-3.txt`, `secmut-2.txt`, `mutation-0108.txt`, `full-reg.{log,json,time}`, `perf-0108-{1,2,3}.json`, `perf-0108-agg.txt`, `trace-1.json`. Previous team's raw outputs: scratchpad `0f4192f6…/scratchpad` (`hr4-*.log`, `c-mutation.txt`, `perf-scoped-*`).

## 13. Requested CTO rulings
- **B1:** option (a), (b) or (c) for `wf.core.organization.manage` on `company_admin`.
- **B2:** option 1, 2 or 3 for the scoped-user latency gate.
After the rulings: apply (if any code change: full regression + security + mutation + scoped benchmark re-run under the unchanged gate), commit locally, and set **Authorization Foundation → CLOSED → UAT READY**.

---

## Addendum — 2026-10-09: CTO rulings applied, then STOP (security bypass found)

CTO rulings received: **B1 = Option B** (reclassify Organization administration out of `wf.*`), **B2 = Option 2** (optimise, no exception, same gate). Work stopped under the handoff's STOP rule when a scope bypass was found on a pilot surface while implementing B2. **Authorization Foundation: BLOCKED — NOT CLOSED.**

### A1. STOP — scope bypass: `GET /inventory/reports/stock/export`
- **What:** declared `@WarehouseScopeFiltered('stock of the caller's visible warehouses only')`, but the handler calls `getStockReport(warehouseId, manager)` **without** the caller's visible-warehouse set (`inventory.controller.ts`, `stockReportExport`). The JSON twin `GET /inventory/reports/stock` passes it. The other exports / import / movement reports all apply it (audited). Only the explicit-`warehouseId` form is guarded (404).
- **Origin:** committed F6 (`33aae63`). The F6 report listed "excel exports … not exercised via file" as a residual; the route-coverage spec checks declarations, not that the handler applies them.
- **Evidence (real HTTP, bv backend 3601, scoped user with a grant on branch X only; `Main Warehouse` linked to branch Y for the run):** warehouse list → Main Warehouse not visible; JSON stock report → **0 rows**; **export → 200 with 4 rows of `WH-MAIN — Main Warehouse` and its custody sub-location `PREP-000001`** (both out of scope); `export?warehouseId=<Main>` → 404. Fixture restored and verified (link back to unlinked; test warehouse deactivated; test user and role removed). Script/output: session scratchpad `stock-export-bypass-proof.{js,txt}`.
- **Impact:** a scoped user holding inventory read permission can export stock quantities of every warehouse in their Company. Same Company only (no cross-Company exposure); permission still required.
- **Proposed fix (NOT applied — awaiting authorization):** resolve `visibleWarehouses(req)` in `stockReportExport` and pass it to `getStockReport` exactly as `stockReport` does; add an HTTP/file-level test; extend the coverage spec so a `@WarehouseScopeFiltered` handler must call the scope service (or cover every export by file in the F6 HTTP tool).

### A2. B1 — implemented and verified at spec level
- New Company administration node **`core.company.organization.manage`** (in `COMPANY_ADMINISTRATION_NODES`); no existing administration node represented the org tree, so this replaces the workflow node — it is not a duplicate. The workflow rule `core.organization.manage` is retired.
- Organization write routes: `PermissionGuard` + `@RequirePermission(core.company.organization.manage, 'editable')` (refusal is now **404**, the convention of the other Company administration surfaces; was 403). Navigation item uses `permissionNode`. `canAdministerAllUnits` checks the node. Frontend Organization page checks the node.
- Migrations: `1790012000000` (never released) now grants the administration node to an existing `company_admin`; new **`1790013000000-ReclassifyOrganizationAdministration`** moves every grant of `wf.core.organization.manage` to the new node at the same access level and removes the old rows (idempotent; `down()` = inverse). The committed F5 migration `1790009000000` is untouched; its drift test now allows exactly this one reclassified node.
- **Found and fixed with B1:** `POST /organization/units/:id/members` let an Organization administrator add **themselves** to a unit — an org membership is a scope source, so this bypassed `SELF_SCOPE_CHANGE`. Self-assignment is now refused (403 `SELF_SCOPE_CHANGE`); removing oneself stays allowed.
- Specs updated to assert the administration node **and that `company_admin` holds zero `wf.*` capabilities**: CTO-decisions (+ new reclassification test: same access, idempotent, inverse, legacy admin reclassified at provisioning), new-Company verification (5544), organization isolation (+ self-assignment test; PermissionGuard metadata), workflow-rules drift, provisioning specs. **Results: 143/143 (5656) + 4/4 (5544).** `dist` rebuilt (the real-PG harness provisions from compiled migrations).

### A3. B2 — implemented, typechecked, spec-checked; NOT yet HTTP-verified or benchmarked
- **Duplicate authorization-context load removed (sales-orders):** the 8 `SalesOrdersService` methods reached from HTTP take an optional trailing `actorAccess`; the controller passes the request's already-loaded `WorkflowAccess` (same user, same Company; `companyId` is never consulted by a decision). Other callers unchanged.
- **Scope path in one round trip:** on a request's first authorization load, `AccessScopeService.forRequest` loads the context **and** the scope rows in one statement (`AuthorizationContextService.forRequestWith`; the context is built by the same `buildAuthorizationContext` from the same `AUTHORIZATION_CONTEXT_FROM` rows as `loadAuthorizationContext`; units/warehouse SQL shared with `resolve()`); scope rows are used only if the context says the caller is restricted; a Company without `warehouses` falls back to the previous path. No check removed, no threshold changed.
- **Not done yet (stopped):** pre-loading the scope in `WarehouseScopeGuard` for `@WarehouseScopeFiltered` list routes; HTTP verification; the three-way benchmark.
- State: backend `src` typecheck 0 errors; frontend 0 errors; scope/authorization/CTO-decisions/sales-orders specs **74/74**.

### A4. Not run because of the STOP
Security/mutation re-run, full Authorization Regression, Protected Baseline Regression, and the scoped benchmark on the B1+B2 build; the bv databases have **not** been migrated with `1790013000000` and the backends on 3601/3603 still run the old build.

### A5. Requested
Authorize the A1 fix (or rule otherwise). After it: finish B2 (filtered-route pre-load), migrate the bv databases, restart the verification backends on the new build, then run security/mutation (+ the export case) → full regression → Protected Baseline → three-way benchmark under the unchanged gate → final report.
