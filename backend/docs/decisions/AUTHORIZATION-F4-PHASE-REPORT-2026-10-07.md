# Authorization Foundation — F4 Phase Report: Platform Authorization and Support Access (2026-10-07)

Scope (CTO directive 2026-10-06/07): the `platform.*` namespace + the four approved platform roles (Platform Super Admin, Company Manager, Support / Operations, Audit / Read-only) · support access that is Explicit + Time-boxed + Reason-required + Audited + Company-visible · AZ-13 (Integrations — Hybrid ownership) and AZ-14 (Media — Company-owned, migration only in its own phase).
Environment: isolated PG 127.0.0.1:5656 (bv_* databases, backend 3601, frontend 5601). `daii_dev` and Production untouched. No push.
Prerequisite: F3 closed VERIFIED → UAT READY (`1f2feb6`).

## 1. What was implemented

**Platform namespace and roles.** 37 `platform.*` nodes (company, user, membership, entitlement, plan, role, audit, release, config, limit, support, integration) with risk (`low | sensitive | platform-critical`) and bilingual titles; the existing platform nodes (`system.release.*`, `core.config.*`, `core.limit.*`, `core.entitlement.*`) are MAPPED as legacy aliases, not duplicated or renamed. The four platform roles are seeded into the CONTROL PLANE only (a boot seeder, not a `core` migration — those also run on every Company database): `platform_super_admin` (everything), `company_manager` (company lifecycle except decommission, memberships, packages, support), `support_operations` (reads + support access, no entitlement/lifecycle change), `platform_audit_readonly` (every view, nothing else). The existing ambient `admin` is the legacy alias of the Super Admin: granted every platform node and still accepted by the guard.

**`PlatformGuard` + `@RequirePlatform(node, level, {legacyNodes})`.** Resolves ONLY the caller's control-plane authority (never a Company database, whatever `companyId` the token carries). Allowed when the caller holds the platform node, or the route opted in to a legacy node that was its SOLE gate before F4 (config / limits / entitlement), or holds the legacy `admin`. A route that declares nothing falls back to its `@RequireRole` (only `/admin/sales-reps`, moving in F5) and otherwise is DENIED (fail closed). Release routes required `admin` AND the node: they got NO legacy-node opt-in, so nothing is loosened.

**Platform controllers migrated** (77 routes): installation companies / memberships / audit, plans & packages, entitlement, config, limits, release (31 routes), admin. A completeness spec enumerates every route of every platform controller and fails if one is left to the fail-closed default.
- `/admin/*` (AZ-07/AZ-01 platform side): every user/role write is now audited in the platform hash chain (status, profile, password reset — never the password —, role assigned/revoked); assigning or revoking a PLATFORM role needs `platform.role.manage`; the last Super Admin cannot be removed.
- `/auth/me`: `platform.capabilities` is now the caller's effective `platform.*` map (a UX hint like every capability); membership exposes `kind` / `expiresAt`.
- New `PlatformController`: `/platform/roles`, `/platform/nodes`, `/platform/support-access` (list / grant / revoke), `/platform/integrations/providers` (AZ-13 catalog).

**Support access (the only way a platform user enters a Company).** A `support` membership: created by an explicit act of someone holding `platform.support.grant`, mandatory reason (≥ 10 characters), at most 8 hours (default 4), only for a platform-role holder, never for an ordinary member of that Company, carrying exactly one limited Company role `support_readonly` (read-only on the entitled modules; nothing editable, nothing critical, no administration). The expiry is enforced on EVERY request by the access guards (an expired row = a missing row: `CompanyContextGuard`, `select-company`, refresh, `/memberships/mine`, `/auth/me`), then a sweeper (60 s) removes the Company-side role and writes the closing audit. Company-visible: the access shows in the Company user directory (kind, reason, expiry) and in the Company's OWN audit chain (`support_access.granted | revoked | expired`), the platform chain records it too; the Company's administrators can end it at any time; the Company cannot silently turn it into a normal membership (role/status changes on a support member are refused). Platform authority alone gives no Company access at all.

**AZ-13 (Hybrid).** Implemented the platform-owned half: the Integration Catalog (`integration_providers`, seeded with `qr_store`, availability open/close audited, `platform.integration.*`). The Company-owned half (connections, credentials, mappings, logs) is NOT moved in F4 — it is a data-residency / credential-custody migration with an unauthenticated intake endpoint that needs its own gate; the entity-by-entity ownership map and the F4-B plan are in `AUTHORIZATION-AZ13-AZ14-OWNERSHIP-RECORD-2026-10-07.md`. **AZ-14 (Media):** recorded; no migration (per the directive).

**Frontend.** Control-plane section driven by platform capabilities (Support access, Platform roles added; the Company registry link also for non-admin platform roles), Support access screen (list, grant with reason/hours, end now), Platform roles screen (roles with grants and holders, assign/revoke), a read-only "time-boxed support access" banner inside a support session, and the support badge / "End access" action in Company Users.

## 2. Files
Backend new: `platform/{platform-nodes.ts, platform.guard.ts, platform-role.seeder.ts, support-access.service.ts, support-access.scheduler.ts, integration-catalog.service.ts, platform.controller.ts, platform.module.ts, platform-authorization.f4.real-pg.spec.ts}`, migrations `1790007000000-SupportAccessMemberships`, `1790008000000-IntegrationProviderCatalog`. Modified: the platform controllers (`company-registry`, `installation-membership`, `installation-audit`, `plans`, `entitlement`, `configuration`, `limit`, `release`, `admin`), `admin.module.ts`, `membership.entity/service`, `company-user-management.service`, `company-user-roles`, `memberships-mine.controller`, `auth-me.service`, `app.module.ts`, `limits-scope.characterization.spec.ts` (adapted to the platform guard; not runnable here).
Frontend: `pages/control-plane/{SupportAccess,PlatformRoles}.tsx`, `CompanyUsers.tsx`, `components/Layout.tsx`, `context/AuthContext.tsx`, `lib/authz.ts`, `App.tsx`.

## 3. Tests
| Spec / check | Result |
|---|---|
| `platform-authorization.f4.real-pg.spec` (real PG, two Companies + control plane) | 9/9 |
| Mutation proof: without the expiry filter and with a loosened guard, 3 tests FAIL; restored | proven |
| Guard matrix over the REAL routes (14 routes × 7 identities incl. a Company administrator with a Company token) | exact expected allow/deny |
| Completeness: every route of 10 platform controllers declares a platform permission / legacy role | > 60 routes, 0 undeclared |
| Real HTTP against the booted backend (`authz-tools/f4-http-verification.js`) | 26 PASS / 0 FAIL |
| Capability diff on the isolated Companies before/after the F4 migrations and boot seed | 4 users: **0 losses, 0 gains**, 1452 pairs unchanged; ambient admin gains only the 37 platform nodes |
| Browser (5601): control-plane links, Platform roles (4 roles + legacy admin holders), Support access screen → grant via the form → Company administrator sees the support badge → "End access" | verified |

## 4. Regression (affected areas: foundation, procurement, accounting company-isolation, treasury, sales-orders, crm, inventory-warehouse)
Serial run on the final code: **107 suites, 734/752 first run.** Failures: the 4 environment-guarded characterization suites (17 tests; they need the isolated HR instance on port 5544, owned by another session, and are NOT executed here) and ONE real finding of this phase — `installation-membership.controller.spec` (5/6) asserted the old `@RequireRole('admin')` wiring of a controller F4 deliberately moved to the platform guard. It was updated to assert the new wiring (platform guard + each route's `platform.membership.*` node) and passes 6/6; no behavioural assertion was weakened. `limits-scope.characterization.spec` (one of the four) also asserted the old `/limits` wiring and was adapted to the platform guard, but cannot be executed here. The accounting/HR Protected-Baseline suites (D1–D10, T0, journal numbering, FA-02) are outside this affected area and are covered by the full-repo regression at the final release gate (standing rule); F4 touches no accounting or HR code.

## 5. Security / isolation evidence
Matrix over HTTP: Super Admin all allowed; Company Manager gets companies/plans/memberships but 403 on config, release, integration catalog; Support reads + release view and opens support access; Auditor reads only (403 on support grant, password reset, catalog write); a person with NO platform role gets 403 on every platform route — also with a Company token; no token / forged token 401. Escalation: a Company Manager cannot assign any role; a Super Admin can. Support access: short reason 400, > 8 h 400, non-platform target 400, ordinary member 409 (service level), Auditor 403; the support session reads Company data (200) but gets 404 on user/role administration; expiry refuses the very next request (403) and `select-company` (401) before any sweep; the sweeper closes it with `support_access.expired` in the Company chain; the Company ends a live access (200) and the support user is refused immediately; a Super Admin without support access cannot select the Company (401). Platform and Company hash chains verify.

## 6. Performance (interleaved A/B vs the pre-F1 build, 3 runs × N=100, zero non-200 — stricter harness; final build)
| Endpoint | pre p50/p95 (ms) | F4 build p50/p95 (ms) | Δp50 | Δp95 |
|---|---|---|---|---|
| auth/me | 5.2/8.2 | 5.3/8.5 | +1% | +4% |
| me/navigation | 69.4/106.1 | 5.4/8.4 | −92% | −92% |
| memberships/mine | 4.0/6.8 | 4.6/7.2 | +15% | +5% |
| accounting/accounts | 6.9/9.9 | 8.1/11.5 | +18% | +15% |
| sales-orders | 6.9/9.2 | 7.7/12.2 | +12% | +32%* |
| approvals/requests | 6.2/9.5 | 5.7/8.2 | −8% | −14% |
| purchase-orders | 6.7/9.6 | 6.2/9.0 | −7% | −6% |
| organization/units (F1 intentional boundary cost) | 3.2/4.5 | 4.5/6.8 | +40% | +50% (≈ +2 ms) |
| company/users (F2) | n/a | 6.3/10.1 | — | — |
\* one p95 outlier in run 1 (16.1 ms; runs 2 and 3: +14% / +5%); medians +7%…+12% in all three runs — measurement noise at these absolute values (≈ 3 ms).
History: the first F4 campaign showed `/auth/me` +11%/+18% because a platform administrator now also gets `platform.capabilities` (one extra control-plane statement in Company mode). The legacy `admin` alias holds every platform node by definition, so Company mode no longer loads anything extra for it; only non-`admin` platform roles pay one parallel statement. Final: parity.
The access guards gained one predicate (`expiresAt`) on the same indexed membership row; the platform routes are administration screens, not hot paths.

## 7. Status
**F4: IMPLEMENTED · INTEGRATED · VERIFIED (isolated environment) → UAT READY for the platform authorization and support-access scope**, with AZ-13's Company-owned half scheduled as its own gate (§8.1; nothing regressed, the ambient behaviour is unchanged). No cross-company exposure, no privilege escalation (platform-role assignment gated, last Super Admin protected, critical power untouched), no ability loss (Company capability diff ∅; ambient admin only gains platform nodes), no Protected-Baseline regression, audit chains verify, performance inside the budget.
AZ mapping: AZ-09 (platform authorization = one role) closed · AZ-07 platform side (admin writes unaudited) closed · AZ-13 platform-owned half implemented, Company-owned half planned (F4-B) · AZ-14 recorded, migration deferred by decision.

## 8. Decisions recorded, residual risks and CTO items
1. **AZ-13 Company-owned half → F4-B (own gate).** Needs your explicit go: it moves credential custody and may migrate real DAII rows (plan in the ownership record). Until then `/integrations/*` and `/media/*` stay on the ambient plane exactly as before (pre-existing AZ-13/AZ-14, not regressed).
2. **Support role is read-only by the permission model.** `support_readonly` can only do what a role with read-only grants can do; routes that are guarded by nothing but authentication (accepting any member) would also accept a support member — the same posture as any role-less member today; the F5 call-site inventory is where those get closed.
3. **Self-grant.** `support_operations` may open access for themselves (reason, ≤ 8 h, audited, Company-visible, Company can end it). If you want a second person to approve, say so — it is a one-line policy (grant requires `platform.support.grant` held by someone else).
4. **Legacy `admin` alias stays** until F5 retires the role checks; the guard honours it so no platform administrator loses anything.
5. The installation membership route (`/installation/companies/:id/memberships`, attach by user id) is still the platform support/bootstrap path (now `platform.membership.*`); with `company_admin`-only new Companies it is also the route that gives the first holder of critical power (F3 §8.2).
6. `limits-scope.characterization.spec` asserted the old `/limits` wiring (`PermissionGuard`); it was adapted to the platform guard but, like the other three port-5544 characterization suites, cannot be executed by this session.

## 9. Gate evidence index
- Real PG: `platform-authorization.f4.real-pg.spec.ts` 9/9 + mutation proof; adapted `installation-membership.controller.spec` 6/6; `auth-me.contract` 8/8 after the platform-capabilities change.
- Real HTTP: `authz-tools/f4-http-verification.js` — 26 PASS / 0 FAIL on the final build (isolated 3601).
- Capability diff ∅ on every READY bv Company (`authz-tools/capability-snapshot.js` before/after): 4 users, 0 losses, 0 gains, 1452 pairs unchanged.
- Browser (5601): control-plane links (Company registry, Support access, Platform roles), Platform roles (4 roles + legacy admin 2 holders), Support access grant through the form → Company administrator sees the support badge in Company Users → "End access" → the row is gone.
- Regression §4; performance §6; ownership record for AZ-13/AZ-14: `AUTHORIZATION-AZ13-AZ14-OWNERSHIP-RECORD-2026-10-07.md`.
- Commit: see the git log entry `feat(authz): F4 …` (no push).

## 10. CTO items
1. **Authorize F4-B** (AZ-13 Company-owned integrations: Company-plane retrofit, per-Company credential custody, routing for the QR intake, migration plan for existing ambient rows) — or tell me to defer it behind F5/F6.
2. Support access self-grant policy (§8.3): keep, or require a second person.
3. D17 default for new Companies (F3 §8.1) — flip at F5 exit; mail provider for invitations (F2 §8.2); D16 second approver for critical grants.
4. Execution of the four port-5544 characterization suites, if you want them run before F5.
