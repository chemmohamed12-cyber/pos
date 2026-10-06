# Authorization & User-Management Architecture Audit — current source (2026-10-06)

**Status: ANALYSIS ONLY. No code, schema, migration, data or configuration was changed.** Requested by the CTO as an *Authorization Architecture Gate* ahead of the Release Candidate review; the output is the input to an Authorization Blueprint, which is not written here.
Evidence: source read of `backend/src/foundation/{admin,authentication,authorization,permission,scope,identity,company,module-registry,module-role-templates,organization,navigation}` and the controllers; a read-only scan of all 70 controllers (`AUTHORIZATION-PERMISSION-NODE-INVENTORY-2026-10-06.md`); read-only queries on the isolated environment (`bv_cp`, `bv_co`); three read-only GETs on the running isolated backend. Nothing was run against `daii_dev`.

## 0. Executive summary

1. **The Company boundary itself is sound.** Identity is global (control plane), *Membership* is the source of Company belonging, and every Company route runs `JwtAuthGuard → CompanyContextGuard → (Roles|Permission)Guard`: membership is checked on every request, the Company status is re-read on every request, the DataSource is the Company's own, and roles/permissions are then resolved from **that Company's** `roles` / `user_roles` / `role_permissions`. 58 of 70 controllers run `CompanyContextGuard`. A real saga (`CompanyMembershipProvisioningService`) grants/revokes membership and the Company-side role, with an operations ledger, a reconciliation scheduler, last-admin protection and audit records written in **both** databases.
2. **The CTO's observation is correct and it is architectural, not a UI bug.** The *Users / Assign-role* screen (`/admin`) talks to `AdminController`, which has **no `CompanyContextGuard`**: it lists the global `users` table, resolves roles from the **ambient (control-plane)** `roles`/`user_roles`, and writes role changes to the **ambient** catalog. The Company selected in the switcher is ignored by that screen end to end. A role assigned there does **not** change what the user may do inside Alpha.
3. **The Company-side machinery exists but has no usable front door.** `GET/POST/PATCH/DELETE /memberships` (Company-scoped, node `core.company.members.manage`) and `/installation/companies/:id/memberships` (platform, with a UI) already exist; there is **no Company user directory** (names), **no API or screen to create/edit Roles or role permissions**, no scope management beyond sales orders / customers, and no authorization audit for the `/admin/*` actions.
4. Several things the CTO's model asks for already exist in the engine (role = bundle of permission nodes; union of roles; deny-by-default; 404 anti-enumeration; maker ≠ checker; amount-threshold approval rules). The rest needs targeted change — see §4 and §5. **Nothing here requires throwing the foundation away.**

## 1. The 17 questions

### Q1. How do User, Membership, Role, UserRole and RolePermission exist?
| Concept | Table / entity | Where | Notes |
|---|---|---|---|
| User (identity) | `users` (`User`) + `credentials` | **Control plane (ambient)** | `UsersService` reads only the ambient repository. Email, name, status (`pending/active/disabled/suspended`). |
| Membership | `user_company_memberships` (`Membership`: `userId`, `companyId`, **one `roleKey`**) | **Control plane** | Unique `(userId, companyId)` — one row, **one role key**, per user per Company. |
| Membership operation | `membership_operations` | Control plane | saga ledger (grant / revoke / change). |
| Role | `roles` (`Role`: only `id`, **`key`**, `createdAt`) | **Both**: ambient *and* every Company DB | no display name, description, system/custom flag, owner. |
| UserRole | `user_roles` (`userId`, `roleId`) | **Both** | in a Company DB the FK to `users` is dropped (`company-authorization-schema-adjustment.ts`): `userId` is by value. |
| RolePermission | `role_permissions` (`roleId`, **`nodeKey`**, `access` ∈ `hidden|read-only|editable`) | **Both** | dotted node path; ancestor-walk inheritance; deny by default. |
| Org structure | `org_units` (`company/branch/department/team/warehouse`) + `org_memberships` | **Both tables exist**, but HTTP reads the **ambient** copy (see AZ-03) | |
| Scope | `scope_assignments` (`userId`, `resourceType`, `resourceId`) | Company DB | generic resource-id assignment. |

Verified live (isolated env): `bv_cp` has 2 users, 29 roles, 75 role-permission rows, 4 memberships; `bv_co` has the same 29 role keys with 78 grants, 2 `user_roles`, 1 scope assignment (`sales_order`). Production code never copies users into a Company DB (`users` exists there only through schema parity).

### Q2. What lives in XNEXUS / control plane vs Company DB?
- **Control plane:** users, credentials, refresh tokens, companies, memberships (+ operations), entitlement/installation/plans, configuration engine, release/backup, terminology, **platform** roles/user_roles/role_permissions (the "ambient" catalog), the ambient copy of org units.
- **Company DB:** business data, **Company** `roles`/`user_roles`/`role_permissions`, `scope_assignments`, audit records of the Company, approval engine data, numbering, etc.
- **Not a Company:** XNEXUS has no `companies` row. "Platform mode" is simply *a token without `companyId`* (before `select-company`): routes without `CompanyContextGuard` then resolve roles from the ambient tables.

### Q3. How is a User created today?
`POST /auth/register` (`auth.controller.ts`): open only while **no user exists** (first user becomes ambient `admin` automatically); afterwards requires an authenticated **ambient** `admin`. It creates a **global identity**, activates it immediately (no invitation, no e-mail verification), and sets a password supplied by the admin. It creates **no membership** and no role. The Admin screen's "new user" form uses this route.

### Q4. How is a Membership created?
Two paths, both through the same saga:
1. **Platform:** `POST /installation/companies/:companyId/memberships` — `@RequireRole('admin')` with no Company context ⇒ **ambient admin only**. Used by the Control-Plane screen `CompanyMembers.tsx`.
2. **Company:** `POST /memberships` — `CompanyContextGuard` + node `core.company.members.manage` (editable). Granted to the Company's `admin` role by `seedCompanyAdminRole`. **No frontend uses it.**

### Q5. How is the Company-side UserRole provisioned?
`CompanyMembershipProvisioningService.grantMembership`: create the membership → start an operation → `provisionUserRoleForMembership` in the **Company DB** (`RoleNotSeededError` if the role key is absent there; idempotent) → complete the operation → audit in the control plane **and** in the Company DB. `revokeMembership` blocks removal of the **last admin** (`LastAdminError`). `changeMembershipRole` replaces the single role. A scheduler reconciles stuck operations. (Strong; see §3.)

### Q6. How is the Company context determined?
`POST /auth/select-company` verifies membership + Company operational status and issues a token pair whose JWT carries `companyId`. `CompanyContextGuard` then, **on every request**: requires `companyId`, re-checks membership, re-reads the current Company status (suspension takes effect on the next request), and attaches the Company's own DataSource as `req.companyContext`. A non-member learns nothing about the Company.

### Q7. How are permissions loaded?
`PermissionGuard` → `PermissionService.hasAtLeast(userId, node, access, companyManager)` → role keys of the user (Company `user_roles`) → role ids → `role_permissions` rows for the node and every ancestor; most-specific per role, **most permissive across roles**, none ⇒ `hidden` ⇒ **404** (anti-enumeration). No caching: a few queries per guarded request. `RolesGuard` (hard-coded role keys, 403) coexists with it.

### Q8. Are the current permissions really Company-scoped?
**Yes on the Company path** (58/70 controllers; tests: `permission-path-company-isolation.acceptance.spec`, `area6-company-isolation.acceptance.spec`, plus the per-controller A/B specs). **No** on the 12 controllers without `CompanyContextGuard` — seven are legitimately installation-level (`configuration`, `entitlement`, `limit`, `release`, `terminology`, `navigation`, `health`), five are not obviously so (`admin`, `organization`, `media`, `integrations`, `integration-order-intake`) — see AZ-01/AZ-03.

### Q9. Is there global/default role leakage?
- **No cross-Company leakage on Company routes** (roles come from the Company DB).
- **Two leakage-shaped inconsistencies:** (a) `GET /auth/me` returns the **ambient** roles even when a Company is selected, and the frontend's `hasRole()` (99 uses in 41 files) trusts it — the UI can show/hide actions that the Company-resolved server decision does not match (AZ-02); (b) the Admin screen's role assignment lands in the ambient catalog (AZ-01).
- The ambient `admin` role carries module grants of its own (19 rows) and is also what authorises every platform route: a platform super-admin and a Company admin share the **key** `admin`, separated only by *which database* answers.

### Q10. Can an Alpha admin see Beta's users through any API?
- `/admin/users` (global `users` table + ambient roles): reachable **only** by ambient `admin`. A user who is *only* an Alpha admin gets **403**. A user who is **both** (like the account in the CTO's screenshot, and the bootstrap admin) sees **every identity regardless of the selected Company** — the switcher has no effect. *(Live check on the isolated env: the call returned the global set with ambient roles while Verify Co was selected; both test users happen to be members there, so the check shows the code path, not a cross-Company row.)*
- `/organization/units` and `/organization/units/:id/members`: `JwtAuthGuard` only — **any authenticated user** reads the ambient org tree and member user-ids, whatever Company they selected (AZ-03).
- `/installation/companies/:id/memberships` (all Companies' memberships): ambient admin only — correct for platform, but it is the same `admin` key.
- `GET /memberships` (Company path): only the selected Company's memberships, ids and role key — **no names**.

### Q11. All current permissions?
209 distinct nodes guard 399 of 584 routes (the other 185 are module/entitlement- or role-gated only). Per module: accounting 63, procurement 24, manufacturing 22, attendance 14, logistics 13, hr 11, inventory 11, sales 10, payroll 10, core 8, commission 6, system 5, finance 4, targets 3, reporting 2, + the three `core.company.*` nodes. Full list with the access level each route requires: **`AUTHORIZATION-PERMISSION-NODE-INVENTORY-2026-10-06.md`**.

### Q12. Modules / actions that exist in the ERP
Sales (customers, price lists, catalog, orders, deposits, reps), Procurement (suppliers, PR, RFQ, PO, GR, supplier invoice/payment, new-item request), Inventory/Warehouse (stock, movements, transactions, counts, fulfilment), Logistics/Shipping (shipments, returns, custody, collection), Finance/Customer-finance (invoices, payments, ledger, AR aging), Treasury, Accounting (COA, journals, ledger, financial events, AR/AP/cash/fixed-asset/inventory/GRNI reconciliation, fiscal periods, dimensions, tax, reports), HR, Attendance, Payroll, Commission, Targets, Manufacturing (BOM, routing, work centers, work orders), Reporting, Approvals, Configuration, Release/Backup, Audit, Organization, Integrations.

### Q13. Which actions need View / Create / Edit / Delete / Approve / Post / Reverse / Export / Manage?
Today's node vocabulary (route counts): `view` 146, `create` 75, `edit` 71, `approve` 16, `post` 8, `restore` 8, `adjust` 7, `deploy` 7, `export` 4, `assign` 3, `submit` 3, `delete` 3, `backup` 3, `cancel` 2, `reopen` 1, `reverse` 1, `reject` 1, `manage` 2 and domain verbs (`material_issue`, `finished_goods_receive`, …). So the verbs the CTO lists **already exist as node suffixes** in most modules. Gaps: `delete` (3) and `export` (4) are rare; `reverse` is 1 (accounting) — treasury reversal is gated by the hard-coded roles `admin`/`finance`, not a node; whole families of routes (customers/sales-order lists, invoices/payments/AR-aging reads, returns) have **no** permission node, only module entitlement. The *access level* (`hidden/read-only/editable`) is orthogonal to the verb: view nodes need `read-only`, mutating nodes need `editable`.

### Q14. How could Branch / Warehouse / Department scope be added?
What exists: `ScopeService` (assign/unassign/`filterAllowed`/`assertAccess`, 404 on denial) — generic `(userId, resourceType, resourceId)` — **consumed only by CRM customers and Sales Orders**; `admin` is hard-coded unrestricted; `org_units` already has the types `branch`, `department`, `team`, `warehouse` plus `org_memberships` and ancestor/descendant helpers; `orgUnitId` columns exist on many accounting/approval entities and `responsibleUserId` on warehouses. **Correction (2026-10-06, found while preparing the Blueprint):** an org-unit scope mechanism **does** exist — `ScopeResolver` + `SCOPE_DERIVATION_REGISTRY` (ADR-031: strategies `direct` / `org_unit` / `parent` / `unscoped`) — and it is enforced for **treasury accounts** (`treasury.service.ts` filters through `filterAllowedByOrgUnit`; a null `orgUnitId` = unscoped = visible to all). `supplier` is declared in the registry but no supplier code consumes it. Org-unit membership is read from the Company's own `org_memberships`, **but the only HTTP way to create org units/members is the ambient `OrganizationController`**, so in Company mode that scope has no management path. **Beyond treasury accounts, nothing enforces org-unit or warehouse scope on lists, writes, approvals, reports or exports.** To add it: (1) make Org Structure Company-scoped over HTTP (AZ-03); (2) define the scope dimensions and who carries them (user, membership or role); (3) enforce in the **service layer** (query filter + `assertAccess` on detail/write/approve), not the controller or the sidebar; (4) decide the resolution rule across multiple roles (union); (5) apply to reports/exports. This is new work in every domain that owns warehouse- or branch-keyed data.

### Q15. How does this interact with the Approval Engine and Option B?
The Approval Engine already provides: maker ≠ checker, per-request-type matrix rules (`minApprovers`, `requiredPermissionNode`, `valueThreshold`, optional `orgUnitId`), a central queue, expiry. Option B (PR/PO) was implemented **in the services**, with the existing permission node still required at the controller — i.e. *permission → maker recorded → maker ≠ checker → approver permission*, exactly the chain the CTO sketches, but as two separate mechanisms (Process-Engine transitions with service checks vs Approval Engine). **Scope does not participate** in either. A future "Business Policy" layer should be the single place that expresses amount thresholds and maker ≠ checker for both, not a third mechanism.

### Q16. What can be achieved with the current architecture without redesign?
- Company-scoped **user directory** (join Company memberships → ambient identities by id, expose only members) — new read endpoint + screen.
- Company-scoped **role assignment** through the existing membership saga (`PATCH /memberships/:userId`), with the Admin screen switched to the Company path.
- Platform vs Company **separation of screens**: Platform Users / Companies / Memberships (ambient admin) vs Company Users / Roles (Company admin).
- **Role editing UI/API** over the existing `roles` + `role_permissions` tables (they are already Company-owned and "the customer then owns and may edit" per the seeder's own note) — new controller + audit.
- **Role templates for the missing modules** (data in `MODULE_ROLE_TEMPLATES`; roles are bundles already).
- Authorization **audit** for role/user actions using the existing `AuditService` pattern (membership operations already do it).
- Making `GET /auth/me` (and nav) **Company-aware** by passing the Company manager that `RolesGuard`/`PermissionService` already accept.

### Q17. What needs a migration or an architectural change?
- **Multiple roles per Membership** (today: one `roleKey` on `user_company_memberships`; the engine already unions roles per user in the Company DB, so the bridge is the membership model and the saga).
- **Scope model** (branch/warehouse/department): new data model + enforcement in every domain (§Q14).
- **Org Structure per Company over HTTP** (controller + frontend route currently ambient).
- **Platform authorization layer** (`platform.*` nodes) — today a single ambient `admin` role.
- **Retiring / mapping the legacy role vocabulary** (AZ-05).
- **Business-policy layer** unifying thresholds and maker ≠ checker.
- Role display metadata (name, description, system/custom, template version) — schema change on `roles`.

## 2. Findings (ranked; none fixed here)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **AZ-01** | **High — release gate** | `/admin/*` (user list, role assign/revoke, status, reset-password, profile) is **platform-global and ignores the selected Company**: lists all identities, reads/writes the **ambient** role catalog. A role assigned on the screen does **not** alter Company authorization; a Company-only admin cannot use the screen at all (403) even though the navigation shows it. | `admin.controller.ts` (no `CompanyContextGuard`; `RolesGuard` without company manager); `Admin.tsx`; live GET |
| **AZ-02** | **High** | `GET /auth/me` returns **ambient** roles; the frontend's 99 `hasRole()` uses (41 files) therefore reflect platform roles, while the server authorizes by **Company** roles and `/me/navigation` already uses the Company manager. UI and server can disagree in both directions. | `auth.controller.ts` `me()`; `AuthContext`; `navigation.service.ts` |
| **AZ-03** | **High** | `OrganizationController` is not Company-scoped: `GET /organization/units` and `/units/:id/members` need only a valid JWT and read the **ambient** org tables; create/rename/assign are ambient-admin. The Company DB has the tables and the service accepts a manager, but the controller never passes one. The natural home of Branch/Department scope is platform-global today. | `organization.controller.ts` |
| **AZ-04** | Medium–High | **No Role / permission management API or UI.** Roles are bare keys, created only by seeding code. Templates exist for 8 modules (sales, inventory, logistics, finance, reporting, hr, manufacturing, accounting) — **none for procurement (24 nodes), payroll, attendance, commission or targets**; treasury has no permission nodes at all (its controller is gated by the hard-coded roles `admin`/`finance`). For those areas only `admin` (module-wide `editable`) can act. `accounting.manager` is the whole module — no Accountant / Finance-manager split. | `role-templates.ts`; `role.entity.ts`; DB role list |
| **AZ-05** | Medium–High | **Two role vocabularies.** Business logic hard-codes legacy keys (`sales_rep`, `sales_supervisor`, `sales_manager`, `warehouse_*`, `finance`, `admin`; ~30 literal checks in sales-orders, fulfilment, returns, shipment, warehouse-transactions, media, auth; `ORDER_ACTION_REQUIRED_ROLES`) while the module templates use different keys (`sales.manager`, …). A template "Sales Manager" cannot perform `manager_approve`. | `order-action-roles.ts`; `sales-orders.service.ts`; `role-templates.ts` |
| **AZ-06** | Medium | Membership carries **one** role key; the engine supports several. | `membership.entity.ts`; `changeMembershipRole` |
| **AZ-07** | Medium | **Authorization audit gap**: `/admin/*` actions (assign/revoke, status, reset password, profile edit) write **no audit record**; there is no role/permission change to audit because no API exists. Membership grant/revoke **is** audited in both DBs. | `admin.controller.ts`, `authorization.service.ts` (no audit calls) |
| **AZ-08** | Medium | **Scope**: record-level assignments only for customers and sales orders; org-unit scope enforced only for treasury accounts (ADR-031 `ScopeResolver`, with no Company-side management path — see AZ-03); admin unrestricted by hard-coded key; no branch/warehouse/department enforcement elsewhere. | `scope.service.ts`; grep of consumers |
| **AZ-09** | Medium | **Platform authorization = one role.** No `platform.*` permission nodes; ambient `admin` is a super-user and shares its key with the Company admin role. Separation is structural (DB), not nominal. | `company-registry.controller.ts`, `installation-membership.controller.ts`, `plans.controller.ts` |
| **AZ-10** | Medium | **No Company user directory**: `/memberships` returns `userId` + `roleKey` only; names exist only in the ambient identity table. | `company-membership.controller.ts` |
| **AZ-11** | Low–Medium | User onboarding is admin-set password, instant activation, no invitation/verification; identity creation and membership are separate manual steps. | `AuthService.register` |
| **AZ-12** | Low | Several routes have no permission node (reads of customers, sales orders, returns, invoices, payments, AR aging, reports overview): module-gated only (this is the NAV-11 / ESC-4 finding seen from the API side). | NAV report ESC-4 |

**What is good and should be kept:** membership-first Company boundary and per-request status re-check; Company-owned `roles`/`user_roles`/`role_permissions`; deny-by-default with 404; ancestor-walk node inheritance; the membership saga (operations ledger, reconciliation, last-admin guard, dual-DB audit); module-entitlement-driven template seeding; `PermissionGuard`/`RolesGuard` `getAllAndOverride` fix; A/B isolation tests.

## 3. Mapping to the CTO's proposed model

| Proposal | Today | Gap |
|---|---|---|
| XNEXUS = Installation/Control plane, not a Company | ✔ (token without `companyId`; no Company row) | the *screens* don't present it as a distinct "Platform Administration" mode |
| Identity ≠ Membership; membership is the source | ✔ | Company user directory missing (AZ-10) |
| Company screens Company-scoped, backend decides | ✔ for ~58 controllers | AZ-01, AZ-03 |
| Platform authorization layer (`platform.*`) | one ambient `admin` role | AZ-09 |
| Company authorization at action level (view/create/edit/post/reverse…) | node vocabulary ✔ (209 nodes) | role grants are mostly module-wide; missing verbs/families; AZ-12 |
| Permission **+ Scope + Business policy** | Permission ✔; Scope partial; policy partial (approval matrix, maker ≠ checker) | AZ-08, §Q15 |
| Roles as bundles; multi-role users (union) | ✔ in the engine | membership single-role (AZ-06) |
| Role Management tree UI, search | ✗ | AZ-04 |
| Role templates per Company, then Company-owned | ✔ mechanism (seeded, owned) | 8 modules only; no editing surface |
| Company Admin ≠ God mode / Platform Admin ≠ ERP rights | ✔ structurally (platform actions need ambient `admin`; Company data needs membership) | same key `admin`; Admin screen conflates (AZ-01); `admin` = unrestricted scope + all module grants |
| Authorization audit (who/what/when/company/before/after/reason/IP) | membership ops ✔ | `/admin/*` none; no role/permission/scope changes to audit; IP/session not captured by these records |

## 4. Decisions the Blueprint needs from the CTO (not taken here)

1. **Where Company users are listed and how** — recommended: a Company-scoped endpoint that joins that Company's memberships to ambient identities by id and returns *only members* (no new identity copy in the Company DB).
2. **One role or many per membership** (engine already unions).
3. **Platform authorization shape** — keep one `admin` or introduce `platform.*` nodes / platform roles.
4. **Role editing semantics** — which template roles are locked vs editable, what happens to Company roles when a template changes, who may edit (Company admin) and what is forbidden even to them.
5. **Scope model** — dimensions (branch, warehouse, department, own records), carrier (user / membership / role), default for existing users, behaviour of `admin`.
6. **Fate of the legacy role keys** (`sales_rep` … `admin` literals) — map to node permissions, or keep as workflow-role designations separate from permission roles.
7. **`/auth/me` / frontend gating contract** — Company-aware roles *and* a permission summary, so the UI stops inferring authority from platform roles.
8. **Org Structure ownership** — per Company over HTTP (recommended) vs installation-level.
9. **Business-policy layer** — how amount thresholds and maker ≠ checker (PR/PO Option B, Approval Engine, future payments/treasury governance) are expressed once.

## 5. Suggested sequencing for the Blueprint (for discussion, not authorized)

Platform Users (ambient, ambient-admin) → Company Users (Company-scoped directory) → Roles & Templates (incl. missing modules, role editing, audit) → Multi-role membership → Scopes (Org Structure first) → Approval/Business-policy alignment → Authorization audit completion → UI gating contract. Items AZ-01/02/03 are the release-gate candidates; AZ-04…AZ-10 shape the Blueprint.

## 6. Not done, by instruction

No implementation, no migration, no data change, no change to the isolated or shared environments; no push. The two evidence files are the only artifacts of this audit.
