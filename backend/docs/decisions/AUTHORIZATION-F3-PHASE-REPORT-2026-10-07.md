# Authorization Foundation — F3 Phase Report: Roles, Templates, Taxonomy (2026-10-07)

Scope (CTO directive 2026-10-06/07): System / Template / Custom roles · capability taxonomy and risk · union / most-permissive (kept) · template versioning (offered, never forced) · `company_admin` = administration authority only (D17: a new key for new Companies; existing `admin` rows kept verbatim and relabelled "Legacy Administrator (Operational)") · a package upgrade grants only module-administration capabilities.
Environment: isolated PG 127.0.0.1:5656 (bv_* databases, backend 3601, frontend 5601). `daii_dev` and Production untouched. No push.
Prerequisite: F2 closed VERIFIED → UAT READY (`2059a20`).

## 1. What was implemented

**Role metadata (additive, idempotent migration `1790005000000`).** `roles` gains `type` (`system | template | custom | legacy`), `templateKey`, `templateVersion`, `templateIgnoredVersion`, `customized` (nullable: "not evaluated yet"), `isActive`, bilingual name/description, `updatedAt`, `createdBy`. Existing rows are classified from the KEY only: the 20 catalog template keys → `template`@v1; the pre-template flat keys and the existing `admin` → `legacy` (D17); everything else → `custom`. The migration also gives every existing `admin` the new `core.company.roles.manage` node (the compatibility grant the F2 members node also got). Nothing is renamed, no grant is removed.

**Taxonomy.** `permission-risk.ts`: the 19 Phase-0 critical nodes (explicit list), sensitive verbs, low; `role-grant-math.ts`: the Permission Engine's semantics as pure functions (most specific ancestor wins) and `criticalNodesCovered` (a module-wide grant covers every critical node below it); `capability-catalog.ts`: every catalog node with module, resource, action, risk and a bilingual business title ("Post journal / ترحيل قيد اليومية") from a verb/resource/module dictionary. `core.company.*` nodes live in a leaf file; the four administration nodes are now part of the catalog universe.

**Role management (`/company/roles`, no company parameter; `core.company.roles.manage` read for GETs, editable for writes):** list (members, grants, critical count, customised, template update available) · detail (grants with titles, risk, dormant flag) · permission catalog for the editor (entitled modules only) · template list · create from template (cloned at its version, never assigned) · create custom · clone · update (names, description, active, full grant set) · delete · template-update diff / apply (all or selected) / ignore.

**Rules enforced in the service (the UI only mirrors them):**
- *Protected roles:* `system` (`company_admin`) and `legacy` (the flat keys + `admin`, which business logic still checks by name) cannot be edited or deleted; template and custom roles are Company-owned. Editing a template role marks it customised.
- *Risk-aware anti-elevation (replaces F2's "hold everything" rule).* Administration authority (the members/roles management nodes) lets an actor assign or define ANY non-critical role/grant; a role that reaches a CRITICAL node can be newly defined, cloned, assigned or removed only by someone who holds that critical node EXPLICITLY. This is the Blueprint §6.2 rule and is what makes `company_admin` usable (the old rule would have made it unable to assign anything). The F2 user/invitation services and spec were updated to it.
- *Entitlement ≠ Permission (E4):* a grant for a module outside the Company's package cannot be added; grants already there stay, shown dormant; re-enabling the module restores them as before (E3).
- *Dependency completion:* granting an action `editable` also grants the resource's `view` node read-only (reported as `autoAdded`).
- *Administration never disappears:* an edit that would leave no ACTIVE member able to manage users AND roles is refused and rolled back (serialised by the per-Company administration lock).
- *Delete:* refused while any member holds the role; unused custom/template roles are removed with their grants.
- *Inactive roles* cannot be newly assigned or offered (existing holders keep them).
- *Template lifecycle:* a higher template version is OFFERED with a business diff (+ added, ~ changed level, − removed-from-template shown as informational); apply all/selected or ignore (ignored version remembered, re-offered by a later version); a customised role is never touched; a template grant that disappears is never removed from a Company role; an upgrade that would introduce a critical grant needs an actor who holds it.

**Templates for the modules that had none (AZ-04):** procurement (manager, buyer, viewer), payroll, attendance, commission, targets (manager, viewer) and a treasury officer (`finance.treasury_officer`, existing nodes). They are created UNASSIGNED when a module is enabled or on demand from the screen; nothing is granted automatically. The 20 pre-F3 template titles had no terminology entry; all 34 are seeded now (`1790006000000`).

**`company_admin` (D17).** `seedCompanyAdministratorRole`: the system role with exactly the four `core.company.*` administration nodes (members, roles, backup, audit) and NO operational or critical capability; idempotent. `CompanyPackageService.syncCompanyRoles` extends only the legacy `admin` (as before — compatibility) and never `company_admin` (E2/A3). Provisioning gained `administratorRole: 'admin' | 'company_admin'` (see §8.1 for why the default is still `admin`).

**Frontend:** Company Roles screen (`/company-roles`): role table (type, members, permissions, critical badge, customised / inactive / template-update flags), create custom, create from template, clone, delete, editor by module with per-node level selectors, risk badges and bilingual titles, dormant notice, template-update diff with Apply all / Ignore; legacy/system roles open read-only. Server-driven sidebar entry gated by `core.company.roles.manage`. `/auth/me` reports role types from the same classification (`admin` is now `legacy`).

## 2. Files
Backend new: `permission/{permission-risk.ts, role-grant-math.ts, capability-catalog.ts, company-nodes.ts}`, `company/{company-role-management.service.ts, company-roles.controller.ts}`, migrations `1790005000000-RoleMetadataAndRolesManageNode`, `1790006000000-SeedRolesTerminology`. Modified: `role.entity.ts`, `role-templates.ts` (versioning, new templates, company_admin definition), `module-role-template.seeder.ts`, `company-role-seeding.ts`, `database-provisioning.service.ts`, `company-user-roles.ts` (risk-aware rule, error codes), `company-user-management.service.ts`, `company-invitation.service.ts`, `permission-catalog.ts`, `role-classification.ts`, `navigation-registry.ts`, `company.module.ts`.
Frontend: `pages/CompanyRoles.tsx`, `App.tsx`.

## 3. Tests
| Spec / check | Result |
|---|---|
| `company-roles.f3.real-pg.spec` (real PG, two Companies + control plane) | 13/13 |
| Mutation proof: with the critical-hold guard and the administration-remains guard disabled, the relevant tests FAIL (3 tests); restored | proven |
| `company-users.f2.real-pg.spec` updated to the risk-aware rule | 13/13 |
| `company-users.controller.spec` (route/permission wiring incl. `/company/roles`) | 5/5 |
| `company-admin-role-seeding.spec` (core node count 3 → 4: the roles node) | updated, pass |
| Real HTTP against the booted backend (`authz-tools/f3-http-verification.js`) | 27 PASS / 0 FAIL |
| Capability diff on the isolated bv Companies before/after the F3 migrations ("no user loses access") | 4 users, 3 Companies: **0 losses**, 4 gains = exactly `core.company.roles.manage` for the administrators; 1448 (user,node) pairs unchanged |
| Migration on a pre-F3 database (spec) | classified from the key only, one new admin grant, idempotent |
| Migration chain on the isolated main test DB (257 → 275 applied, incl. F2/F3) | clean |
| Browser (5601): sidebar entry, 29-role table, legacy admin row/read-only viewer, create → set grants (critical badge) → save → clone → delete | verified |

## 4. Regression (affected areas: foundation, procurement, accounting company-isolation, treasury, sales-orders, crm, inventory-warehouse)
Serial run on the final code: **106 suites, 726/743 first run after the isolated main test DB was migrated.** The only 17 failing tests are the 4 environment-guarded characterization suites (`provisioning-lifecycle`, `module-add-existing-company`, `limits-scope`, `ui-created-company-admin`) that refuse to start by design (they need the isolated HR instance on 127.0.0.1:5544, owned by another session) — identical to the pre-F1 build and to the F1/F2 gate runs; NOT executed here and NOT claimed as passing.
Honest history of this gate: the FIRST run of this code was 724/743 — the same 4 suites plus the two `grni-posting` tests, which failed with `column Role.type does not exist` because they run the full AppModule against the isolated main test database `d3verify_main` (ambient path), which was still at 257 applied migrations (it never received 1789960…–1790006). That is a test-environment gap, not a code defect; the F3 migration is additive and was applied (together with the 17 earlier pending core migrations, all clean — a useful rehearsal of the whole chain on an older database) and the suite then passed 2/2 alone and in the full run. Consequence for the standing baseline: `d3verify_main` is now at the current schema (isolated PG only; documented here because it changes the rehearsal baseline).
`company-admin-role-seeding.spec` was updated (the admin role now also gets `core.company.roles.manage`: 3 → 4 fixed core nodes); no assertion was weakened. The accounting/HR Protected-Baseline suites (D1–D10, T0, journal numbering, FA-02) are outside this area and are covered by the full-repo regression at the final release gate (standing rule); F3 touches no accounting or HR code.

## 5. Security / isolation evidence
Roles of Company A do not exist in Company B (a foreign role id is a plain 404; B lists its own); a delegated people-manager (members + roles manage only, no admin role) can list roles and create/assign NON-critical roles but gets 403 `ROLE_EXCEEDS_GRANTOR` for: a role that reaches a critical node, a module-wide grant that covers critical nodes, handing out `admin`, taking `admin` away from the administrator; the legacy admin is protected (409); a role held by a member cannot be deleted (409); an inactive role cannot be newly assigned (409); a platform token with no Company context is 403, unauthenticated 401. Every F3 change is in the Company's hash-chained audit (`role.created|updated|cloned|deleted|template_upgraded|template_ignored`, `role.assignment.denied`), chains verify.

## 6. Performance (interleaved A/B vs the pre-F1 build, 3 runs × N=100, zero non-200 — stricter harness)
| Endpoint | pre p50/p95 (ms) | F3 build p50/p95 (ms) | Δp50 | Δp95 |
|---|---|---|---|---|
| auth/me | 8.3/14.2 | 8.4/12.0 | +1% | −15% |
| me/navigation | 124.1/193.7 | 8.6/12.5 | −93% | −94% |
| memberships/mine | 6.6/9.6 | 7.4/11.0 | +12% | +14% |
| accounting/accounts | 12.6/17.3 | 14.9/20.7 | +18% | +20% |
| sales-orders | 12.1/15.8 | 13.0/18.1 | +7% | +15% |
| approvals/requests | 10.6/15.3 | 9.6/14.2 | −10% | −7% |
| purchase-orders | 13.2/17.3 | 11.6/16.0 | −12% | −7% |
| organization/units (F1 intentional boundary cost) | 6.3/8.8 | 9.2/11.9 | +45% | +35% |
| company/users (F2) | n/a | 10.6/15.5 | — | — |

F3 does not touch the request hot path (the AuthorizationContext loader selects `id`/`key` explicitly, so the new `roles` columns cost nothing there); the role endpoints are administration screens, not hot paths. `/auth/me` is at parity; every normal guarded route is inside the +25% budget (largest +20% p95; machine load was higher than in earlier campaigns — absolute times are up ~15%).

## 7. Status
**F3: IMPLEMENTED · INTEGRATED · VERIFIED (isolated environment) → UAT READY**, with the decisions in §8 (none is a red gate: no cross-company exposure, no privilege escalation — critical power can only be granted by an explicit holder, proven and mutation-tested —, no ability loss (capability diff ∅ except the one new administration node), no Protected-Baseline regression, no last-admin/administration lockout, audit chains verify, performance inside the budget).
AZ mapping: AZ-04 (template catalog gaps: procurement, payroll, attendance, commission, targets, treasury officer) closed · AZ-05-adjacent role type/metadata groundwork done · AZ-12 (granular node families) deferred to F5 by design (§8.3).

## 8. Decisions recorded, residual risks and CTO items
1. **D17 default for NEW Companies — please decide.** Everything for `company_admin` is built and tested, but the provisioning default stays `admin` until F5: ~89 backend call-sites still demand the role KEY `admin` (e.g. Organization writes `@RequireRole('admin')`), so a Company whose only administrator is `company_admin` would get 403 on them. Flip `administratorRole` to `company_admin` when F5 migrates those checks (recommended), or now, accepting those 403s for new Companies.
2. **First holder of critical power in a `company_admin`-only Company.** By design nobody can grant a critical capability they do not hold, so the first critical holder must come from the platform plane (installation membership route today; time-boxed support access in F4). Documented, not worked around.
3. **AZ-12 (new granular nodes: treasury actions, exports, reversal and read nodes) is NOT part of F3.** Introducing them means re-gating existing routes — a behaviour change that belongs to F5 with the legacy-compatibility shim ("no ability loss"). F3 delivers the structure that will carry them (catalog, risk, templates) and a treasury-officer template on existing nodes.
4. **Module administration nodes do not exist yet** (the catalog has no `*.settings` / `*.config` convention), so `company_admin` = the four `core.company.*` nodes and the "package upgrade grants only administration capabilities" rule holds trivially (it never extends). It becomes load-bearing when such nodes are introduced.
5. `customized` for pre-F3 template roles is evaluated on first read against the current catalog; if the catalog has already moved on, the role is treated as customised (conservative: never auto-touched). New roles record `customized=false` at creation.
6. Arabic business titles come from a verb/resource/module dictionary (reviewable content, 363 nodes); a few resource names fall back to the humanised English key.
7. A Company that wants to narrow the legacy administrator does it deliberately: clone `admin` (allowed for holders of its critical nodes), edit the clone, move the members.
8. D16 (second approver for critical grants) is still a Gate question; F3 enforces "only a holder grants critical" without it.
9. The four port-5544 characterization suites remain not executed by this session.

## 9. Gate evidence index
- Real PG: `company-roles.f3.real-pg.spec.ts` 13/13 + mutation proof; F2 spec 13/13 on the risk-aware rule; wiring spec 5/5.
- Real HTTP: `authz-tools/f3-http-verification.js` — 27 PASS / 0 FAIL on the final build (isolated 3601), archived with the capability-snapshot tool.
- "No user loses access": `authz-tools/capability-snapshot.js` before/after the F3 migrations on every READY bv Company: 4 users / 3 Companies, 0 losses, 4 gains = `core.company.roles.manage` for the administrators, 1448 pairs unchanged.
- Browser (5601): sidebar entry `/company-roles`; 29-role table with the legacy administrator ("مدير تشغيلي (قديم)", 19 critical nodes) and templates; legacy admin opens read-only (no Save, inputs disabled); create custom role → editor by module → set `sales.order.create` + the critical `accounting.journal.reverse` (critical badge shown, view dependencies auto-added: 4 grants, 1 critical) → saved → cloned → both deleted.
- Regression: §4. Performance: §6.
- Commit: see the git log entry `feat(authz): F3 …` (no push).

## 10. CTO items
1. D17 default for new Companies (§8.1) — recommend flipping at F5 exit.
2. Mail provider for invitations (F2 §8.2) — still open, not blocking.
3. D16 second approver for critical grants — still a Gate question.
4. Execution of the four port-5544 characterization suites, if you want them run before F4.
