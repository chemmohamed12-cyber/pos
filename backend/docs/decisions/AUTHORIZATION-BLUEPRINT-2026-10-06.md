# AUTHORIZATION & USER MANAGEMENT BLUEPRINT — 2026-10-06

**Status: DRAFT FOR CTO ARCHITECTURE GATE — "Architecture Direction: APPROVED IN PRINCIPLE", not closed.**
**This document is design only. No code, schema, migration or data was changed in preparing it. No push. Production = HOLD.**

Inputs: `AUTHORIZATION-AND-USER-MANAGEMENT-ARCHITECTURE-AUDIT-2026-10-06.md` (findings AZ-01…AZ-12), `AUTHORIZATION-PERMISSION-NODE-INVENTORY-2026-10-06.md` (209 nodes), the CTO directives of 2026-10-06 (target architecture, five non-negotiable principles, the XNEXUSTECH naming instruction), and a further read-only pass over `plans/company-package.service.ts`, `entitlement/*`, `audit/audit-record.entity.ts`, `scope/*`, `organization/*`, `authentication/*`.

Convention: **[KEEP]** = exists and is sound, not redesigned. **[CHANGE]** = new or modified in this Blueprint. **[DECISION]** = needs the CTO Gate (collected in Addendum B with a recommendation). Everything marked [CHANGE] is a *proposal*.

> **One-line architecture.** *Complexity belongs inside the engine; simplicity belongs in the UI.* One decision function, six inputs, one audit trail:
> `ALLOW/DENY = Identity ∧ Membership ∧ CompanyReady ∧ Entitlement ∧ Role-grant ∧ Scope ∧ Policy` → reason code → audit.

---

## 1. Executive Architecture

```
                    XNEXUSTECH  (platform / control plane — not an operating Company)
        Platform Admin ── platform.* permissions ── Platform audit
        Identity · Companies · Memberships · Packages/Entitlements · Lifecycle · Release
                                   │
              ┌────────────────────┴─────────────────────┐
           Company A                                   Company B        (… DAII becomes one of these)
   own DB: roles · role_permissions · user_roles · scopes · org tree · policies · business data · audit
```

**What the end user sees:** *Company → Users → Roles → Scope → "what can this person do".*
**What the engine does, per request (target pipeline):**

```
JWT ─► CompanyContext ─► Entitlement ─► Permission ─► Scope ─► Policy ─► handler ─► Audit
 (who) (membership,      (module/       (role grants   (which   (when /     (domain   (every sensitive
       company ready)     feature on)    node@level)    records) approval)   service)  decision)
```

| Layer | Today | Target |
|---|---|---|
| Identity | global `users`+`credentials` (control plane) **[KEEP]** | unchanged; lifecycle fields (invited/active/disabled) **[CHANGE]** |
| Membership | one row, one `roleKey` | existence + status only; roles move to the Company DB **[CHANGE]** (§4, §5) |
| Roles | bare `roles.key`, no UI | typed (system/template/custom), versioned, Company-owned, editable **[CHANGE]** |
| Permissions | 209 dotted nodes × `hidden/read-only/editable`, ancestor walk, deny-by-default **[KEEP]** | same engine; taxonomy completed; business "capabilities" on top **[CHANGE]** |
| Scope | record assignment (customer, sales order); org-unit only for treasury accounts | one `AccessScope` resolved once per request, enforced in services **[CHANGE]** |
| Policy | Approval Engine matrix **[KEEP]** + PR/PO maker ≠ checker in services | one `PolicyService` facade over both; no 3rd mechanism **[CHANGE]** |
| Platform authz | single ambient `admin` role | `platform.*` nodes + 4 platform roles **[CHANGE]** |
| Audit | hash-chained `audit_records`; membership ops audited | complete authorization event catalog + request context **[CHANGE]** |

**Kept as-is (proven; not redesigned):** membership-first Company boundary; per-request Company status re-check; Company-owned role tables; deny-by-default + 404 anti-enumeration; ancestor-walk node inheritance; the membership saga (operation ledger, reconciliation, last-admin guard, dual-DB audit); module-entitlement enforcement from the platform DB; signed licence manifest + installation fingerprint; Approval Engine; A/B isolation test discipline.

**Scope of the first release.** Foundation (Platform/Company separation, Company Users, multi-role, Roles, Permissions, `/auth/me`, Platform authorization, Organization ownership, **basic** Scope, Audit) → Expansion (advanced Branch/Warehouse scope, Department scope, advanced policies, threshold governance, advanced approval matrix). Section 23.

---

## 2. Platform vs Company Boundary

### 2.1 Two planes, two token modes
| | Platform plane | Company plane |
|---|---|---|
| Token | JWT **without** `companyId` | JWT **with** `companyId` (issued only by `select-company`, which re-verifies membership + Company READY) |
| Data | control-plane DB | the Company's own DB (`req.companyContext.dataSource`) |
| Authority | `platform.*` permissions (§11) | Company roles → node grants (§12) |
| Users shown | platform identities, memberships across Companies | **only** the current Company's members |
| Unit | "XNEXUSTECH" (not a Company row, no ERP data) | Company A, Company B, … |

### 2.2 Rules (invariants — see §21)
1. Platform authority **never** implies ERP authority: a platform admin reaches a Company's data only through an explicit, audited membership (including support access, §11.3).
2. Company authority **never** implies platform authority: Company Admin cannot create/suspend/decommission Companies, change entitlements/packages, read other Companies, or manage platform roles.
3. A route belongs to exactly one plane. No route resolves authority from the other plane's tables (this is what AZ-01/02 violate today).
4. The ambient (control-plane) copies of ERP role templates are not an authority source for Company routes (§11.4).

### 2.3 DAII becomes a Company
DAII is the **product/company identity that today also acts as the platform brand**. Target: **XNEXUSTECH is the platform; DAII is a tenant Company with its own database and its own admin, no different from Alpha/Beta.** Consequences designed here, executed in the naming workstream (Addendum A): platform branding and tenant branding are separated; no tenant document ever carries the platform brand as if it were the issuer; DAII's data lives in a Company DB reached only by membership. Open items: D13/D14.

---

## 3. Identity Model

* **[KEEP]** Global identity = `users` + `credentials` (+ refresh tokens) in the control plane. One person = one identity regardless of how many Companies. **No copy of the user inside a Company DB** (CTO directive). The `users` table that exists in each Company DB through schema parity is unused by production code and is to be deprecated (never read for authority/identity) — verified: no production code inserts into it.
* **[CHANGE]** Lifecycle: `invited → active → disabled` (today `pending/active/disabled/suspended`, instant activation, admin-set password). Onboarding path (proposal): Company Admin **invites by e-mail**; the identity is created or reused internally; the user sets their own password / accepts the invitation. Platform "create user" remains for support and bootstrap.
* **Who may disable what.** *Identity* disable/reset is a **platform** action (`platform.user.disable`, `platform.user.reset_password`). A *Company* can only suspend or remove **its own membership** — it can never disable a person across Companies.
* **No identity enumeration** (§21): a Company screen never reveals whether an e-mail exists elsewhere.
* Referencing identity from Company data stays **by value** (`userId` uuid columns, FKs already dropped in Company DBs — `company-authorization-schema-adjustment.ts`). Display names are resolved at read time by id through the membership join (§4.3), never stored as an authority.

---

## 4. Membership Model

### 4.1 Source of truth
| Fact | Where | Why |
|---|---|---|
| "Identity U belongs to Company C" + its status | control plane `user_company_memberships` **[KEEP, extended]** | needed before any Company DB is touched (CompanyContextGuard) |
| "U holds roles R1,R2 in C" | **Company DB `user_roles`** **[CHANGE: single source of truth]** | the Company owns its authority; authorization reads only the Company DB |
| `membership.roleKey` | kept as a **read-only compatibility mirror** (= the highest-ranked/primary role) until the contract phase | existing `/memberships`, platform screen and last-admin logic keep working during transition |

### 4.2 Membership record (proposed additions, additive)
`status` ∈ `invited | active | suspended | removed`, `joinedAt`, `invitedBy`, `lastAccessAt` (updated at `select-company`), `authzVersion` (integer bumped on any change to the member's roles/scope; used by the cache, §22). `roleKey` retained (mirror).

### 4.3 Company user directory (security requirement, not UX)
```
current Company (from validated JWT) → CompanyContextGuard (membership active, Company READY)
  → Company DataSource → membership list for THIS company (control-plane read keyed by companyId from the guard — never from the client)
  → identity lookup BY THOSE userIds → role/scope summary from the Company DB
  → response contains Company members only
```
`GET /company/users` (new) takes **no** companyId parameter. Frontend filtering is never relied upon. A/B isolation spec is part of the definition of done (§24).

### 4.4 Saga
The existing `grantMembership / revokeMembership / changeMembershipRole` saga **[KEEP]** is generalised to *role set* operations (`addRole`, `removeRole`, `setRoles`) with the same operation ledger, reconciliation and audit. Last-admin protection moves to count `company_admin` holders in the **Company DB** (no longer from the mirror).

---

## 5. Multi-Role Model

* A membership carries **0..n roles**. Effective grants = **union**; for one node the most permissive level wins (this is exactly today's `PermissionService.resolve` across roles — **[KEEP]**). **No composite role per combination.**
* **No explicit deny grants** in the Foundation (a role either grants a node or does not). Rationale: deny-overrides make "effective access" unexplainable to the target user. (Expansion option if ever required.)
* Scope with multiple roles: **Foundation** — scope is attached to the *membership* (one scope set per user per Company): effective access = union-of-grants ∩ membership scope. **Expansion** — scope per *role assignment* (e.g. Finance Manager @ Cairo, Branch Manager @ Giza); the data model in §9 already carries `roleId` nullable to allow it without redesign.
* Default for a new member: **no roles, no scope ⇒ sees nothing** (least privilege). Assigning a role is an explicit act.
* A member can hold different role sets in different Companies (Ahmed: Finance Manager in Alpha, Sales Manager in Beta) because roles are Company-owned and resolved only from the active Company's DB.
* Last-admin rule: a Company must always keep ≥ 1 active `company_admin`.

---

## 6. Role Types

| Type | Meaning | Editable by Company? | Origin |
|---|---|---|---|
| **System** | structural roles the platform needs to function: `company_admin` (see §6.2) | **No** for key/deletion; grants auto-managed by entitlement (§16) | seeded at provisioning |
| **Template** | a standard starting point (Finance Manager, Sales Manager, Procurement Manager, Warehouse Manager, HR Manager, Accountant, …) | **Yes** — once cloned it is Company-owned | cloned from the XNEXUSTECH template catalog at provisioning / module enable |
| **Custom** | created by the Company | Yes (within delegation limits, §21) | Company Admin |

Proposed `roles` metadata (additive columns): `name_ar`, `name_en`, `description_ar/en`, `type` (`system|template|custom|legacy`), `templateKey`, `templateVersion`, `customized` (bool, set when grants diverge from the cloned version), `isActive`, audit stamps. `legacy` marks the pre-existing flat keys during transition (§14).

### 6.1 Role description in business language
Every role has a human description ("إدارة العمليات المالية والمحاسبية للشركة") and its capabilities are shown in business groups (§18), never as raw nodes.

### 6.2 Company Admin is not "God mode"
`company_admin` may: manage the Company's users, memberships, roles, scopes, organization, authorization audit, operational permissions. It may **not**: create/suspend/decommission Companies, change package/entitlements, access another Company, manage platform roles/users, or edit its own protected core (cannot remove its own last-admin status). Today's `admin` additionally carries an unrestricted-scope bypass and module-wide grants; in the target the *unrestricted scope* becomes an explicit property of the role (`grantsAllScope`), not a hard-coded key (`ScopeService.UNRESTRICTED_ROLES`).

---

## 7. Role Template Lifecycle

**Catalog.** `MODULE_ROLE_TEMPLATES` (code) → versioned catalog: each template `{key, version, module, titleCode, descriptionCode, capabilities[]/grants[]}`. Missing modules get templates (procurement, payroll, attendance, commission, targets, treasury) — closes AZ-04.

**Clone behaviour.** A template becomes a Company role by **cloning at a version** (`templateKey`, `templateVersion` recorded). From then on the Company owns it.

**Upgrade strategy (the rule the CTO asked for: no silent change).**
1. A new template **version never modifies Company roles automatically.** The system computes a diff per Company role and raises **"Template update available"** to the Company Admin (permission diff in business language: *+ Post journals*, *– Edit suppliers*).
2. Admin chooses *Apply all / Apply selected / Ignore*. Ignored versions are remembered.
3. Only two things are automatic: (a) a **new role** from a template for a **newly enabled module** is *created but unassigned*; (b) `company_admin` receives the new module's grants (§16) — documented, audited.
4. **Customized** roles (`customized = true`) are never touched; the diff is shown as informational.
5. Removal of a grant from a template is **never applied automatically**.

**Existing-Company impact (migration).** Today's 29 roles per Company are classified (§19): template keys → `template`@v1 (`customized` computed by comparing grants), legacy flat keys → `legacy`, `admin` → `system` (`company_admin`, key alias kept).

**Versioning.** Semver on the catalog; every Company role stores the version it was cloned/last upgraded from; every change is an audit event (`role.template.upgraded`).

---

## 8. Permission Taxonomy

**[KEEP]** the 209 existing nodes and the `hidden | read-only | editable` access levels (independent of the action). **[CHANGE]** (additive only):

1. **Naming rule** `module.resource.action` (e.g. `accounting.journal.view|create|post|reverse`). Existing nodes already follow it; nodes that don't are normalised with an alias map (no breaking rename).
2. **Complete the verb families** the audit found missing: treasury (today *no nodes* — hard-coded `admin`/`finance`): `treasury.account.view|create|edit`, `treasury.cash_in`, `treasury.cash_out`, `treasury.transfer`, `treasury.reverse`; `export` on reports/lists; `reverse` where the domain allows reversal; read nodes for the families that today have none (customers/sales-orders/returns/invoices/payments/AR-aging/reports overview — AZ-12), introduced **with a compatibility default** (§20) so no current user loses access on day one.
3. **Permission Catalog** (metadata, in code, versioned with the templates): every node → `{module, resource, action, group, titleCode, risk (low|sensitive|critical), requires[]}`. `requires` encodes dependencies (post ⇒ view+create) so the UI cannot produce an unusable role.
4. **Capabilities.** A *capability* is a named bundle of nodes in business language ("Post journals" = `accounting.journal.view` + `.create` + `.post`). Roles are authored from capabilities; the engine still stores node grants (no engine change). Risk flags drive warnings (e.g. `critical`: reverse, user management, period reopen).
5. **Module-wide grants** (e.g. `accounting.manager` = node `accounting` editable) stay valid (ancestor-walk) but templates are refined into finer roles (Accountant, Finance Manager, Treasury Officer, Auditor-read-only).
6. **Legacy role checks** are inventoried and mapped (§14); `RolesGuard` stays only for platform-bootstrap compatibility.

---

## 9. Scope Model

**Principle:** *Permission = what; Scope = where/on which records; Policy = under which conditions.* Scope is Company/Membership-scoped — never a global user scope.

### 9.1 Dimensions
Company (implicit boundary) · **Branch** · **Warehouse** · **Department** (Expansion) · **Own records** (rule flag on a role/node: `ownOnly` → `createdByUserId = me`).

### 9.2 Data (Company DB, proposed)
`access_scopes(id, userId, roleId?, orgUnitId, includeDescendants, createdBy, createdAt)` — one row per granted unit (branch/warehouse/department are `org_units`, §10). `roleId` nullable = membership-level (Foundation); non-null = per-role-assignment (Expansion). The existing `scope_assignments` (record-level, e.g. rep ↔ customer/sales order) is **kept unchanged** as *record ownership/assignment*, a different concept.

### 9.3 Resolution — once per request
`AccessScope = { unrestricted | { orgUnitIds:Set, warehouseIds:Set, ownOnly } }`, memoised in the request's `AuthorizationContext` (§22). Unrestricted ⇔ role flag `grantsAllScope` or an explicit "All company" grant. Descendants expand through `OrganizationService.getDescendantIds` (**[KEEP]** helper).

### 9.4 Enforcement — service/domain layer
Reuse and extend the **existing** `ScopeResolver` + `SCOPE_DERIVATION_REGISTRY` (ADR-031: `direct | org_unit | parent | unscoped`; already enforced for treasury accounts). Each domain entity declares its derivation (warehouse-keyed: stock, movements, warehouse transactions, PR/PO/GR warehouse; branch-keyed: sales orders via `orgUnitId`, treasury accounts, GL dimension values; parent-derived: invoices → sales order). Enforcement points: **list** (filter), **detail** (404), **create** (target must be in scope), **edit/approve/post/reverse** (assert), **reports and exports** (filter before aggregation). Never in the controller only, never in the sidebar. A null `orgUnitId` = unscoped = visible (ADR-031's "zero behaviour change by default" posture is kept so existing single-branch Companies are unaffected).

### 9.5 Foundation vs Expansion
Foundation: Company-wide vs warehouse/branch sets on three pilot domains (inventory/warehouse transactions, procurement PR/PO/GR, sales orders) + treasury accounts (already) + management UI + effective-access preview. Expansion: all domains, department, per-role-assignment scope, reports/exports everywhere.

---

## 10. Organization Model

* **[CHANGE] Company-scoped over HTTP.** `OrganizationController` passes the Company manager; reads require Company membership + a node (`org.unit.view`), writes `org.unit.manage`. Today it is ambient and readable by any logged-in user (AZ-03). The Company DB already has `org_units` / `org_memberships` and `OrganizationService` already accepts a manager.
* Tree: `Company → Branch → {Department, Warehouse} → Team` (`OrgUnitType` already: company, branch, department, team, warehouse). It is the **official source of scope** (§9).
* **Warehouse master link.** Warehouses (inventory master data) get an optional `orgUnitId` to an org unit of type `warehouse` — *link, not duplicate* (decision D12).
* **Ambient org rows.** Any rows in the control-plane `org_units`/`org_memberships` are data audited in Phase 0 and either moved to the intended Company or archived — never silently dropped (D13 data question).
* Default seeded tree for a new Company: root + "Main branch" (so Company-wide scope is expressible without configuration).

---

## 11. Platform Authorization

### 11.1 Namespace (CTO-directed)
`platform.company.{view,create,update,suspend,reactivate,decommission}` · `platform.user.{view,create,disable,reset_password}` · `platform.membership.{view,grant,revoke}` · `platform.entitlement.{view,manage}` · `platform.plan.{view,manage}` · `platform.role.{view,manage}` · `platform.audit.view` · `platform.release.{view,backup,restore,deploy,rollback}` · `platform.config.{view,edit}` (existing `system.release.*`, `core.config.*`, `core.entitlement.*` are mapped, not duplicated).

### 11.2 Platform roles (proposed)
**Platform Super Admin** (everything platform.*), **Company Manager** (company lifecycle, membership, packages; no release/roles), **Support / Operations** (read + time-boxed support access, §11.3; no entitlement changes), **Audit / Read-only**. Stored in the control-plane `roles`/`role_permissions` (existing tables) with `platform.*` nodes — *no new engine*, only a namespace and `PermissionGuard` on the platform controllers.

### 11.3 Support access
A platform user reaches a Company only via a **support membership**: explicit, role-limited, time-boxed (`expiresAt`), reason-required, listed in the Company's audit and visible to the Company Admin. No standing back door.

### 11.4 Transition
Current ambient `admin` → `platform_super_admin` (key alias kept). Platform controllers move from `@RequireRole('admin')` to `@RequirePermission('platform.*')` **behind the compatibility shim** (§14): both accepted until contract. The seeder that writes ERP templates into the *ambient* catalog at boot is stopped once nothing reads them (D12).

---

## 12. Company Authorization

Guard order for every Company route (**[KEEP]** order, extended):
`JwtAuthGuard → CompanyContextGuard → ModuleEntitlementGuard (RequireModule/feature) → PermissionGuard (node@level) → [service] ScopeEnforcement → PolicyEvaluation → handler → Audit`.

* **Deny semantics [KEEP]:** missing node ⇒ **404** (anti-enumeration).
* **"Why denied" [CHANGE]:** when the caller can already *see* the resource (read access) and the action is refused, the response carries a safe structured reason — `error.code`, `error.reason` ∈ `PERMISSION_MISSING | MAKER_CHECKER | SCOPE_OUT_OF_RANGE | POLICY_THRESHOLD | MODULE_NOT_ENTITLED | STATE_NOT_ALLOWED`, `error.requiredCapability` (business name). When the caller cannot see the resource, behaviour stays 404. The backend decision is authoritative; the message only explains it. PR/PO "maker cannot approve" already returns such a reason in text.
* Company routes never read the ambient role tables.
* Every new Company endpoint requires: Company guard, entitlement, node, scope where applicable, audit, A/B isolation spec.

---

## 13. `/auth/me` Contract (Company-aware)

`GET /auth/me` returns (additive first; see §20):
```jsonc
{
  "identity":   { "id", "email", "fullName", "status" },
  "platform":   { "roles": ["platform_super_admin"], "capabilities": ["platform.company.view", …] },   // empty for non-platform users
  "company":    { "id", "name", "status" } | null,
  "membership": { "id", "status", "roles": [{ "key", "type", "name" }] } | null,
  "capabilities": ["accounting.journal.post@editable", …],     // effective, entitlement-filtered, union of roles
  "scopes":     { "unrestricted": false, "branches": [...], "warehouses": [...], "departments": [...], "ownOnly": false },
  "entitlements": { "modules": [...] },
  "policyFlags": { "makerChecker": ["purchase_request","purchase_order"] },
  "authzVersion": 17,
  "legacy":     { "roles": [...], "rolesSource": "platform|company" }       // compatibility field
}
```
* Frontend uses `can(capability)` / `inScope(...)`; `hasRole('admin')` is deprecated as an authority source. Backend remains the authority.
* Compatibility: the existing top-level `roles` field is **kept** with unchanged semantics during transition and flagged by `legacy.rolesSource`; it is re-pointed to Company roles only at the contract phase after the UI no longer depends on it (99 uses in 41 files must be migrated first). Navigation already resolves with Company roles **[KEEP]**.
* `authzVersion` lets the client refresh when roles/scope change; no roles are embedded in the JWT (the JWT keeps only `sub` + `companyId`) so changes take effect on the next request **[KEEP]**.

---

## 14. Legacy Role Compatibility

Legacy keys: `admin`, `sales_manager`, `sales_rep`, `sales_supervisor`, `warehouse_worker`, `warehouse_supervisor`, `inventory_controller`, `finance`, `driver` (+ the ~30 literal checks in sales-orders, fulfilment, returns, shipment, warehouse transactions, media, auth; `ORDER_ACTION_REQUIRED_ROLES`; `MANAGER_PRICE_ROLES`; `STAGE_EDIT_ROLES`; navigation `roles:[…]`).

Strategy — **never delete, map, dual-check, then retire**:
1. **Map** each legacy key to (a) a template role and/or (b) **workflow capabilities** for stage/approval duties that are not node-shaped today (e.g. `sales.order.supervisor_approve`, `sales.order.manager_approve`, `sales.order.price_override`, `inventory.transaction.approve`). Mapping table is a Phase-0 deliverable, signed off per key.
2. **Dual-check shim:** a check passes if the user has the legacy key **or** the mapped capability (single helper `hasLegacyOrCapability`). Behaviour is identical to today; new roles start working immediately.
3. **Migrate call sites** one domain at a time to the capability (verification matrix per domain, §24).
4. **Retire** the legacy key only when its call-site count is zero and the matrix passes; keep the key row (type `legacy`) for one release for rollback.
5. Backward compatibility is mandatory: no existing user loses an ability at any step (§20).

---

## 15. Approval / Business Policy Boundary

* **[KEEP]** the Approval Engine (maker ≠ checker, matrix rules with `minApprovers`, `requiredPermissionNode`, `valueThreshold`, optional `orgUnitId`, queue, expiry). **[KEEP]** CTO decision ESC-3: **PR/PO maker ≠ checker**; **payments/treasury: no additional approval now.**
* **[CHANGE]** A single **`PolicyService.evaluate(subject, action, context) → { requiresApproval, requiredPermission, minApprovers, makerCheckerRequired, reasons[] }`** that *reads* the existing sources (approval matrix + the PR/PO maker-checker rule, expressed as policy data keyed by document type). It does not add a mechanism: it is the one place future thresholds (payments > X), org-scoped approvals and maker ≠ checker flags are *configured*, so no third/fourth authorization mechanism appears.
* **Boundary:** Permission answers "may this role ever do X"; Scope "on which records"; **Policy "under what conditions, now"** (amount, state, maker, unit). A payment permission is not blocked by a threshold at the permission layer — it routes to approval at the policy layer.
* Foundation: facade + `/auth/me.policyFlags` + "why denied" codes. Expansion: threshold governance for payments/treasury (policy *data*, CTO-decided later), advanced matrix.

---

## 16. Entitlement Integration (Packages)

**Existing chain [KEEP]:** signed licence manifest + installation fingerprint (`EntitlementService`) → Plan/Package per Company (`CompanyPlanAssignment`/`PlanModule`) → `CompanyEntitlementService.resolve(companyId)` = installation licence ∩ package → `RequireModule` guard on routes. `CompanyPackageService.assign` already (a) additively seeds role templates for the package's modules into the Company DB and (b) extends the Company's `admin` module-wide grants.

**Rules (Entitlement ≠ Permission):**
* **E1** Effective capability = role grant ∧ module entitled. `/auth/me.capabilities`, the Role editor and the Effective Access Preview **exclude** non-entitled modules (today only the route guard does).
* **E2** Upgrade (module ON): its templates become *available* (created, unassigned); `company_admin` gains the grants (documented, audited); **no other user's access changes** unless the Company Admin assigns it.
* **E3** Downgrade (module OFF): grants are **kept dormant**, not deleted; the module is unusable (guard) and shown as *not in package* in the editor; re-enabling restores access exactly as before.
* **E4** Platform cannot grant a permission for a non-entitled module; a Company Admin cannot either.
* **E5** Packages decide *module availability*; they never assign users or roles.

---

## 17. Audit Model

Existing **[KEEP]**: `audit_records` (append-only by convention, **hash-chained** `prevHash/hash`, `result ∈ success|failure|denied`, `before/after` JSON, `correlationId`), written to the control plane for platform events and to the Company DB for Company events; membership grant/revoke already dual-written. **[CHANGE]**:
* **Request context** (`ip`, `userAgent`, `sessionId`/token family, `reason`) stored in a new nullable `context` JSON column (additive; hash input rule decided in Phase 0 so the chain stays verifiable).
* **Event catalog (complete):** `user.created/disabled/enabled/password_reset/profile_changed`, `membership.invited/accepted/granted/suspended/removed`, `role.created/updated/deleted/cloned/template_upgraded`, `role.assigned/removed`, `permission.changed`, `scope.granted/revoked/changed`, `org.unit.*`, `company.package.assigned`, `support_access.granted/expired`, `authz.denied` (sensitive actions only: avoid noise; Option-B style failure records already exist), `auth.login/failed/select_company`.
* Every event: **actor, company (or platform), action, target, before, after, timestamp, result, correlationId, context.**
* **Gaps closed:** `/admin/*` writes no audit today (AZ-07); role/permission/scope changes have no API to audit yet — they are audited at birth.
* Visibility: Company Admin sees the Company's authorization audit; Platform Audit sees platform events; neither sees the other's tables.

---

## 18. UX Model

Three levels over **one** engine:

| Level | Audience | Sees |
|---|---|---|
| Basic | owner/small company | Users · Roles · Branches |
| Manager | department/company manager | *Who can do what, where, under which rules* — role capabilities, scopes |
| Security/Admin | auditor/IT | Effective access · scopes · policies · audit |

**Screens.** *Platform Administration* (XNEXUSTECH): Companies, Platform Users, Memberships, Packages, Platform Roles, Platform Audit. *Company → Administration:* **Users**, **Roles**, **Organization**, **Authorization Audit**.

**Users.** Directory of the current Company's members only; invite by e-mail; filters by role/scope/status. **User profile:** Identity · Membership (status, joined, last access) · Roles (chips; add/remove) · Scope (branches/warehouses/departments pickers) · **Effective Access Preview** · Security actions (reset password via platform-governed flow, suspend membership, revoke sessions).

**Effective Access Preview (core feature).**
```
Ahmed — Alpha Trading Co
Roles:   Finance Manager · Reporting Viewer
Scope:   Cairo Branch · Main Warehouse
Can:     ✓ Create invoice  ✓ Post invoice  ✓ Record payment  ✓ View treasury  ✓ Create / post journal  ✓ Export reports
Cannot:  ✕ Reverse journal  ✕ Manage users
Rules:   • Maker ≠ Checker   • Approval required above the approved limit
```
Computed server-side from the same decision functions the guards use (so it cannot drift); each ✕ carries its *why* (missing capability / out of scope / policy).

**Role editor.** Role header (name, description, type badge, template version, "update available" banner) → capabilities grouped by module in business language with search + module filter + risk badges + dependency auto-completion + "permission summary" → **Scope pickers** → **Effective-access preview for a sample user** → Save (audited). Never a 209-checkbox matrix; the node view exists only in an "advanced" drawer for Security/Admin.

**"Why denied" UX.** Inline, translated reason + the capability needed (§12), only where safe.

---

## 19. Migration Strategy

**Expand → migrate → contract; every step additive and reversible; per-Company canary.**
* **Phase 0 (read-only):** inventories — legacy call-sites, ambient org rows, ambient vs Company role/grant drift, users without membership, memberships whose Company role differs from `roleKey`, role-key usage per Company; baseline metrics (§22); mapping tables signed off.
* **Expand:** add nullable/defaulted columns and new tables (`roles` metadata, `access_scopes`, membership status/`authzVersion`, `audit context`); no behaviour change.
* **Migrate (data, idempotent, per Company, backup first):** classify roles (system/template/legacy/custom), set `templateKey/version`, backfill membership status, copy `roleKey` into the Company `user_roles` where missing (reconcile, never overwrite), seed default org tree, create `platform_*` roles and map ambient `admin`.
* **Dual-run:** shims and flags (`authz.v2.*` per Company via the Configuration Engine) — new reads shadow old decisions and log disagreements before any switch.
* **Contract (later release):** flip `/auth/me.roles`, retire legacy keys with zero call-sites, remove the membership `roleKey` mirror, stop ambient ERP-template seeding, deprecate `/admin/*` aliases.
* Production data: nothing is applied until the CTO releases the HOLD; the isolated `bv_*` environment is the rehearsal target.

---

## 20. Backward Compatibility (hard requirements)

1. No user loses any ability at any step; new read nodes introduced for currently-ungated routes default to "granted to whoever can use the module today" until an admin narrows them.
2. `/auth/me` keeps `roles`; JWT shape unchanged (`sub`, `companyId`); 404 deny semantics unchanged.
3. `/admin/*`, `/memberships`, `/installation/companies/:id/memberships` keep working (re-pointed or aliased) for at least one release; `RolesGuard` keys keep working through the shim.
4. Permission node names are never renamed in place (alias map only).
5. The existing test suites for approvals, procurement, accounting, isolation, navigation stay green at every phase (Protected Baseline).
6. Existing Companies keep their current roles/assignments verbatim after migration; classification only adds metadata.

---

## 21. Security & Isolation

**Invariants** (each has a test in §24): **I1** Company identity comes only from the validated JWT/guard, never from a client parameter (except `select-company`, which re-verifies membership). **I2** The Company user directory is derived server-side from membership; no frontend filtering. **I3** No Company route reads control-plane role tables; no platform route reads Company role tables. **I4** No cross-Company id lookup returns data. **I5** Platform authority ≠ ERP authority; Company authority ≠ platform authority. **I6** Least privilege by default (new member = no role, no scope). **I7** *Delegation limit:* a Company role editor cannot grant a permission/scope they do not hold themselves (except `company_admin` within the Company's entitled modules). **I8** *No identity enumeration:* invite-by-e-mail returns the same response whether or not the identity exists elsewhere. **I9** Last-`company_admin` and last-platform-super-admin cannot be removed. **I10** Sensitive/critical capabilities are flagged in the catalog and audited with before/after.
Other: break-glass/support access is explicit, time-boxed and visible to the Company (§11.3); privilege-changing endpoints are throttled; role/membership changes bump `authzVersion` so caches invalidate; platform support cannot read Company data without a membership.

---

## 22. Performance / Caching Rules

* **Today:** authorization is uncached — roughly three indexed queries per guarded request (roles → role ids → grants). Scope and policy would add more.
* **Rule 1:** one lazily-resolved, **request-scoped `AuthorizationContext`** (roles, grants map, `AccessScope`, entitled modules) memoised for the duration of the request — guards, services and the preview all read it; no repeated queries.
* **Rule 2:** optional short-lived cache keyed `(companyId, userId, authzVersion)`; validity checked by a single indexed read of `authzVersion`; invalidated immediately in-process on any authorization write; **fail-closed** (any cache/DB error ⇒ recompute or deny, never stale-allow).
* **Rule 3:** the Permission Catalog and template catalog are in-memory immutable data.
* **Rule 4:** scope filters are compiled into SQL predicates (set-based), never post-filtered in application memory on large lists.
* **Budget:** measure the Phase-0 baseline (queries/request, p95 latency on representative endpoints) and set the acceptance budget from it — no invented numbers here. Regression gate: no endpoint exceeds baseline + the agreed margin.

---

## 23. Implementation Phases

**Phase 0 — Preparation (read-only, no behaviour change):** inventories & mapping tables (§19), baseline measurements, decisions D1–D15 closed, verification matrix fixed, `bv_*` rehearsal environment ready. *Exit:* signed mapping tables + CTO Gate approval.

### Foundation Release
| Phase | Scope | Closes | Exit criteria |
|---|---|---|---|
| **F1 — Boundary & `/auth/me`** | Organization controller Company-scoped; additive Company-aware `/auth/me`; `can()` helper; platform vs Company screen split (shell only) | AZ-02 (additive), AZ-03 | A/B isolation specs; `/auth/me` contract tests; no regression |
| **F2 — Company Users & multi-role membership** | `GET/POST /company/users…`, invitation, role-set saga, membership status, audit events | AZ-01, AZ-06, AZ-07 (user/membership part), AZ-10, AZ-11 | "Alpha admin manages Alpha users without seeing Beta" proven; one user, two Companies, different roles |
| **F3 — Roles, Templates, Taxonomy** | role metadata, role CRUD + clone, template catalog + lifecycle, new nodes (treasury, exports, reversals), Permission Catalog & capabilities, missing-module templates, audit events | AZ-04, AZ-12 | role editor works on capabilities; template upgrade diff; no user loses access |
| **F4 — Platform authorization** | `platform.*` nodes, 4 platform roles, platform controllers on `PermissionGuard`, support access | AZ-09 | Company Admin cannot call any platform route; platform admin cannot read Company data without membership |
| **F5 — Legacy compatibility** | mapping + `hasLegacyOrCapability`, workflow capabilities, domain-by-domain call-site migration (sales-orders first) | AZ-05 | zero behaviour change; per-domain matrix green |
| **F6 — Basic scope + Effective Access Preview** | `access_scopes`, `AccessScope` resolution, pilot domains (inventory/warehouse tx, PR/PO/GR, sales orders, treasury), Organization UI, preview | AZ-08 (basic) | list/detail/create/edit/approve/report enforcement on pilots; preview matches guards |

### Expansion
E1 advanced Branch/Warehouse scope across all domains + reports/exports; E2 Department scope; E3 per-role-assignment scope; E4 `PolicyService` thresholds (payments/treasury — CTO decides policy data); E5 advanced approval matrix; E6 contract phase (retire legacy keys, flip `roles`, remove mirror); E7 MFA / session management hardening.

**Naming workstream N (parallel, see Addendum A):** N0 decisions & inventory → N1 visible platform branding → N2 technical identifiers (compatibility-controlled) → N3 DAII as a Company.

Each phase ships behind per-Company flags, is verified on the isolated environment (browser + real-PG A/B), documented, and individually reversible (§25). **No phase starts before CTO approval of this Blueprint.**

---

## 24. Verification Matrix

| # | Scenario | Layer | Evidence type |
|---|---|---|---|
| V1 | Alpha admin lists/changes only Alpha users; Beta members never returned (API + UI) | isolation | real-PG A/B spec + browser |
| V2 | One identity, Alpha=Finance Manager, Beta=Sales Manager; each Company authorizes by its own role set | multi-role | real-PG + browser (two sessions) |
| V3 | Union semantics; most-permissive level; no deny grants | permission | unit |
| V4 | Company Admin cannot create/suspend Companies, edit packages, read another Company | boundary | real-PG + browser |
| V5 | Platform admin without membership cannot read Company data; with support access can, time-boxed, audited | boundary | real-PG |
| V6 | Entitlement: module OFF ⇒ capability absent in `/auth/me`, editor and preview and route denied; ON ⇒ templates available, existing users unchanged; downgrade keeps grants dormant | entitlement | real-PG + browser |
| V7 | Scope: list/detail/create/edit/approve/post/reverse/report/export for each pilot domain, in-scope vs out-of-scope, multi-unit, descendants | scope | real-PG + browser |
| V8 | Maker ≠ Checker (PR/PO) and approval matrix still enforced; `PolicyService` returns the same decisions as the legacy paths (shadow comparison) | policy | real-PG |
| V9 | `/auth/me` contract schema; frontend `can()` parity with backend decisions; legacy `roles` unchanged | contract | contract tests |
| V10 | Legacy compatibility: every legacy key behaves identically through the shim; no user loses an ability (before/after capability diff = ∅) | compat | per-domain regression + diff report |
| V11 | Audit completeness: every catalog event written with actor/company/target/before/after/context; hash chain verifies | audit | real-PG |
| V12 | Template lifecycle: upgrade offered, never auto-applied; customized role untouched; new-module role created unassigned | lifecycle | real-PG |
| V13 | Role editor: dependency auto-completion; delegation limit (cannot grant what you lack); last-admin protection | security | real-PG + browser |
| V14 | Effective Access Preview equals the decisions of the guards for a generated sample of (user, action, resource) | consistency | property test |
| V15 | No identity enumeration through invite flow | security | API test |
| V16 | Performance: queries/request and latency vs Phase-0 baseline | performance | benchmark |
| V17 | Branding: no platform brand on tenant documents; platform brand configurable | naming | browser |

Acceptance mapping to the CTO's 12 questions: Addendum C.

---

## 25. Rollback / Recovery

* **Schema:** additive only until the contract phase ⇒ rollback = turn the per-Company flag off + redeploy previous code; new tables/columns are ignored.
* **Data migrations:** idempotent, per Company, preceded by the existing backup facility (`core.company.backup.manage`); each has a documented inverse; originals (`roleKey` mirror, legacy role rows, ambient role rows) are **retained** until the contract release.
* **Decision shadowing:** new decisions run in shadow beside old ones with disagreement logging before any flip; a flip is a flag, not a deploy.
* **Audit** is never rolled back or deleted.
* **Lock-out recovery:** a Company left without an admin or an admin who locked themselves out is recovered through the platform's audited support-access path (§11.3) or the reconciliation tool; the last-admin guard prevents the common cause.
* **Failed canary:** stop at the canary Company, keep legacy path active, no other Company is touched.

---

## 26. STOP Conditions (halt and report; do not work around)

1. Any evidence of cross-Company data exposure in any phase (directory, org, roles, audit, reports).
2. Any step that would remove an ability from an existing user (compat diff ≠ ∅).
3. A required change to the Company isolation model, the JWT/session model, or the membership-first boundary.
4. Conflict with the Approval Engine or with a Protected-Baseline item (D1–D10, T0, PRC-01, D7, D8, D9, CUS-01, FA-02, INV-03, journal numbering, NAV-02…NAV-14, ESC-3).
5. Need to touch `daii_dev` or production data.
6. Unclear business policy (thresholds, who may approve) — escalate, do not invent.
7. Last-admin / lock-out risk detected during migration.
8. Hash-chain verification failure after the audit-context change.
9. Performance regression beyond the agreed budget.
10. Any need to change the permission-node naming in place.

---

## 27. Release Impact

* **Release gate:** F1 + F2 (AZ-01/02/03 and the Company user directory) are **Release-Candidate blockers** per the CTO's direction. F3–F6 are scheduled Foundation work; ideally F3 (roles/templates) precedes RC because role management is part of "professional user management". Expansion is post-RC.
* **Risk:** highest on F5 (legacy call-sites in sales/warehouse/shipment) and F6 (scope enforcement correctness); mitigated by dual-check, shadow comparison, per-domain matrices and per-Company flags.
* **Effect on current work:** NAV-02…NAV-14 and ESC-3 are not reopened. The `/admin` screen is *replaced* by Company Users (F2) and Platform Users (F4 UI), not patched.
* **Naming:** the visible XNEXUSTECH rebrand (N1) is low-risk and can ship independently; technical identifier renames (N2) are compatibility-controlled and scheduled with a forced re-login window.
* **Production = HOLD. Nothing pushed.**

---

# Addendum A — Platform identity, naming (XNEXUSTECH) and packaged distribution

**Instruction received:** the platform name is **XNEXUSTECH** in all places and screens; DAII will later be a **Company with its own database**, not the platform owner; lay the foundation to later turn the platform into a **"PC program"**.

**Interpretation to confirm (D15):** "PC program" is read as a **packaged/installable distribution (on-premises/desktop-installable edition)** of the platform. The Blueprint therefore avoids cloud-only assumptions. Evidence that the foundation already points that way: a **signed licence manifest bound to an installation fingerprint** (`manifest-verify.ts`, `installation-fingerprint.ts`) and an `Installation` singleton — i.e. licensing already works per installation, offline-verifiable. If "PC program" means something else, only N-phase packaging items change.

**Three name layers (proposed rule):**
| Layer | Name | Where it appears |
|---|---|---|
| Platform | **XNEXUSTECH** | login screen, platform shell/sidebar brand, control-plane screens, installer/product name, API title, emails sent by the platform |
| Company (tenant) | its legal/trade name from the Company profile (e.g. "DAII", "Alpha Trading Co") | tenant documents (invoices, receipts, waybills, statements, prints) as *issuer*, Company switcher, screens' Company header |
| Technical identifiers | neutral/platform-based | storage keys, package names, env defaults, DB name prefix — see N2 |

**Current occurrences (read-only inventory):** visible — sidebar brand `Daii` (`Layout.tsx`), login title `منصة دائي / Daii Platform` (`Login.tsx`), print header `منصة دائي / Daii Platform` and footer `Daii Platform — <year>` (`PrintDocument.tsx`, applied to **tenant documents** — wrong issuer once DAII is a tenant), browser tab title `frontend`; comments/labels `XNEXUS Control Plane` in 7 control-plane files (the existing control-plane uses the prior name "XNEXUS"); technical — `daii_*` localStorage keys (e.g. `daii_access_token`, `daii_nav_open_group`), `daii-backend` package name, `daii_dev_*` development secret defaults and `daii_dev` database names, folder/domain names. 136 source files mention DAII/Daii/XNEXUS in some form (mostly comments).

**Work items (design):**
* **N0** — decisions D13/D14/D15; full inventory (UI strings via terminology, print templates, emails, docs, installers, env/DB names).
* **N1 Visible branding** — platform brand becomes **one configurable value** (Configuration Engine, installation scope: `platform.brand.name` = `XNEXUSTECH`, with ar/en), used by login, shell, control-plane screens, page title. **Tenant documents stop using the platform brand** and print the Company profile (name, logo, address, tax id) — this needs a Company profile source (Company settings screen) and is the real functional part of the rename. Terminology keys, not hard-coded strings.
* **N2 Technical identifiers** — rename only with compatibility: storage keys migrated by a read-old-write-new shim (no forced logout beyond a planned window), package/product names changed at packaging time, DB name prefix is a *convention* for new installations (existing DB names are not renamed in place), env defaults keep accepting old variable names for one release. Never done in the same release as authorization phases F4/F5 (avoid coupled risk).
* **N3 DAII as a Company** — create the DAII Company record with its own provisioned database; plan the move of current DAII operational data from the platform DB/`daii_dev` into it (a data-migration project of its own, rehearsed on `bv_*`, under HOLD rules); DAII's admin becomes a normal `company_admin` (not platform authority); the bootstrap/ambient `admin` becomes `platform_super_admin` of XNEXUSTECH.
* **Packaged distribution readiness (design constraints only):** no hard dependency on external SaaS services for authorization/licensing; per-installation configuration; offline-verifiable entitlements; installer/first-run creates the platform super admin and optionally the first Company; backup/restore facility (exists) included. No packaging work is started here.

---

# Addendum B — Decision register (for the CTO Gate)

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Multi-role per membership | **Yes** (CTO-directed); roles live in the Company DB; membership `roleKey` = mirror until contract |
| D2 | Platform permission model | `platform.*` namespace + 4 platform roles on the existing role tables (CTO-directed); keep `admin` as an alias during transition |
| D3 | Template lifecycle | Clone-at-version; upgrades are *offered, never forced*; only new-module roles (unassigned) and `company_admin` grants are automatic |
| D4 | Scope ownership/model | Membership-level scope in Foundation (per-role-assignment in Expansion); data in the Company DB; reuse `ScopeResolver`/registry; org units as the dimension source |
| D5 | Legacy role transition | map → dual-check → migrate call-sites → retire; workflow capabilities for stage roles |
| D6 | `/auth/me` | additive Company-aware contract first; `roles` re-pointed only at the contract phase |
| D7 | Organization ownership | Company-scoped over HTTP; ambient rows audited then moved/archived |
| D8 | Business-policy boundary | `PolicyService` facade over Approval Engine + maker ≠ checker; thresholds for payments/treasury are later *data*, CTO-decided |
| D9 | Source of truth for role assignment | Company DB `user_roles` (membership = existence/status) |
| D10 | `company_admin` auto-extension on module enable | Keep auto-extension (today's behaviour) — documented and audited; all other roles never auto-extended |
| D11 | Invitation flow + identity-enumeration rule | invite-by-e-mail with uniform response; platform keeps direct create for support/bootstrap |
| D12 | Warehouse ↔ org unit; stop seeding ERP templates in the ambient catalog | link via `orgUnitId` (no duplication); stop ambient seeding once no reader remains |
| D13 | Ambient org data and brand/identifier rename policy | audit then move/archive; visible rebrand first, technical identifiers compatibility-controlled |
| D14 | DAII-as-Company data migration | separate rehearsed project on `bv_*`; no production data before HOLD release |
| D15 | Meaning of "PC program" | confirm: installable/on-prem edition (Blueprint assumes this) |

---

# Addendum C — Acceptance criteria: does the Blueprint answer them?

| Question | Answer in this Blueprint |
|---|---|
| Alpha manager manages Alpha users without seeing Beta? | §4.3 server-side directory from membership; V1 |
| One user in Alpha and Beta with different roles? | §5, §4.1 (roles per Company DB); V2 |
| What can the user do? | §8 capabilities, §18 Effective Access Preview; V14 |
| Where can the user do it? | §9 scope, enforced in services (§9.4); V7 |
| When does it need approval? | §15 policy facade over Approval Engine + maker ≠ checker; V8 |
| Company Admin without platform authority? | §2.2, §6.2; V4 |
| XNEXUSTECH manages Companies without becoming an ERP Company? | §2, §11, §11.3; V5 |
| Compatible with packages/entitlements? | §16 E1–E5; V6 |
| Ordinary user manages permissions without understanding the engine? | §18 business-language editor, capabilities, preview |
| Security/Admin can see effective access? | §18, §13, V14 |
| Every authorization decision auditable? | §17 event catalog + context; V11 |
| Scales to tens/hundreds of Companies without redesign? | per-Company DB + per-Company flags (§19), request-scoped context and versioned cache (§22), template lifecycle (§7), platform roles (§11) |

**Not done, by instruction:** no code, schema, migration or data change; no implementation started; no push; Production = HOLD. Next step: CTO Architecture Gate on this Blueprint (decisions D1–D15), then Phase 0.
