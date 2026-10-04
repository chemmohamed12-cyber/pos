# DAII SaaS Control Plane & Tenant Lifecycle — Phase 0 Study

**Status: PHASE 0 — STUDY ONLY. DECISIONS PENDING.** No code, migration, schema,
ADR, or blueprint is created or modified by this document. It is a new file;
every file it cites is unmodified. Production remains HOLD. Implementation
Contract is NOT authorized until the Decision Packages in §5 are ratified.

**CTO review (recorded):** APPROVED FOR DOCUMENT REVIEW — direction accepted; DP-1 Option C
and DP-9 are NOT approved (still DECISION REQUIRED); implementation NOT authorized. Four
review notes (F1 evidence levels and Suspend/Decommission separation; F3 NOT VERIFIED
permission-database boundary; DP-1 as a Runtime Resolution Architecture decision; P-1
conditional on an explicit Area 21 boundary ruling) are incorporated below. Next step after
commit: review the Decision Packages, starting with DP-9 and DP-1.

**ملخص تنفيذي (ar):** دراسة Phase 0 فقط لطبقة SaaS Control Plane ودورة حياة العميل.
الخلاصة: لا يوجد Plan Catalog ولا Subscription ولا Billing في الكود. الموجود فعلًا:
Company Registry + Provisioning + Lifecycle + Membership (Model B). وجدنا فجوات
مثبتة على مستوى قراءة الكود (لم تُختبر وقت التشغيل) لا تتعلق بالباقات نفسها لكنها
تؤثر على أي باقة: (1) لا يوجد فحص لـ Company.status في مسار الوصول عند Suspend
(المثبت: مسار الكود؛ المستنتج: إمكانية الاستمرار في العمل؛ غير مثبت: السلوك عبر
HTTP/DB؛ وDecommission حالة منفصلة لم تُحلَّل)، (2) الاستحقاق per-Company مكتوب ولا
يقرأه كود غير الاختبارات، (3) الحدود لا تُزرع عند إنشاء الشركة. ولا نقترح تعديل D1 أو
Model B أو ADR-015/019 ضمنيًا. لا شيء هنا قرار؛ DP-1 وDP-9 ما زالا قرارين مطلوبين.

## 0. Classification legend (used on every point)

- **VERIFIED** — established by reading the cited source in this study. "Verified"
  means *code/ADR reading*; nothing was executed at runtime unless stated.
- **PROPOSED** — a design option offered here; not a decision.
- **DECISION REQUIRED** — needs an explicit CTO/business ruling; not defaulted here.
- **NOT VERIFIED** — could not be established from the repo; stated so rather than assumed.

---

## 1. VERIFIED CURRENT STATE

### 1.1 What exists (reuse candidates)

| # | Capability | Evidence | Class |
|---|---|---|---|
| 1 | Company entity (`companies`: id, installationId, name, status, createdAt) | `foundation/company/company.entity.ts` | VERIFIED |
| 2 | Company state machine `PROVISIONING→READY→DEGRADED/SUSPENDED/MIGRATING/FAILED→DECOMMISSIONED`; `READY→DECOMMISSIONED` deliberately not allowed | `company-status.ts` | VERIFIED |
| 3 | Lifecycle triggers suspend / reactivate / decommission | `company-activation.service.ts` | VERIFIED |
| 4 | HTTP surface `installation/companies` (list, get, create, suspend, reactivate, decommission), gated by `JwtAuthGuard + RolesGuard + @RequireRole('admin')` | `company-registry.controller.ts` | VERIFIED |
| 5 | Provisioning pipeline: Company row → `CREATE DATABASE` → migrations → authorization-schema adjustment → role seeding → entitlement (optional) → initial admin (mandatory) → health check → READY | `database-provisioning.service.ts`, controller `create()` | VERIFIED |
| 6 | Model B: one DB per Company; `Membership(userId, companyId, roleKey)` in the platform DB; `Role/RolePermission/UserRole` inside each Company DB | `membership.entity.ts`, `company-context.guard.ts`, ADR-073 §2 | VERIFIED |
| 7 | Company-context request path: JWT `companyId` is transport only; Membership re-validated on every request; Company DataSource resolved only after | `company-context.guard.ts`, `auth.service.ts selectCompany` | VERIFIED |
| 8 | Signed Entitlement Manifest (Ed25519, `kid`, `installation_fingerprint` anti-clone, module_codes, feature_codes, limits, term_start/end, grace_days) | `entitlement/manifest.type.ts`, `manifest-verify.ts` | VERIFIED |
| 9 | Entitlement enforcement: `RequireModuleGuard` → 404 for an un-entitled module (anti-enumeration); Entitlement ≠ Permission, two guards | `module-registry/require-module.decorator.ts` | VERIFIED |
| 10 | Per-Company manifest apply: `applyEntitlementManifestToCompany` writes the manifest into that Company DB's own `installation` singleton row (verify signature + dependency closure) | `company/company-entitlement-provisioning.ts` | VERIFIED |
| 11 | Module-enable/downgrade lifecycle at *installation* level: `modulesAdded` / `modulesRemoved` ("a downgrade. Data is retained (ADR-023 O-5)") | `module-lifecycle/module-lifecycle.service.ts` | VERIFIED (code); ADR-023 document itself NOT located in repo |
| 12 | Limit engine: `check/consume`, profile absent = unlimited, `manager?` for Company counters; `limit_profiles`/`limit_usage_counters` are Company-owned entities | `limit-engine/limit.service.ts`, `company/core-company-entities.ts` | VERIFIED |
| 13 | Control Plane UI: sidebar section "Control Plane" with ONE link (Company Registry); pages CompanyRegistry, CreateCompany, CompanyDetails | `Layout.tsx:101-118`, `frontend/src/pages/control-plane/` | VERIFIED |
| 14 | Company-scoped audit (Area 14) separate from platform audit; entitlement application is deliberately NOT in the Area 14 taxonomy | `company-entitlement-provisioning.ts` doc comment | VERIFIED |

### 1.2 What does not exist

| Capability | Evidence | Class |
|---|---|---|
| Plan / Package / Edition catalog UI or API (the `editions`, `edition_modules`, `edition_features`, `edition_limits` tables exist but are described as "kept for the admin UI"; only `DAII_STANDARD` is seeded; no controller or UI uses them) | `entitlement/edition.entity.ts`; zero `edition` hits in `frontend/src` | VERIFIED |
| Subscription entity, term, renewal, grace, upgrade/downgrade API | repo-wide search | VERIFIED (absent) |
| Billing / invoicing / payment of the SaaS subscription. (`Invoices`/`Payments` in the repo are the *tenant's customer* finance, a different concern.) | repo-wide search | VERIFIED (absent) |
| Platform roles other than the single `admin` | search for super/platform admin: none | VERIFIED (absent) |
| Plan selection in `CreateCompanyDto` or the Create Company UI (fields: `name`, `initialAdminUserId`, `tags?`, `roleModuleCodes?`) | `company-registry.controller.ts`, `CreateCompany.tsx` | VERIFIED |
| Invitation / user-creation flow for a Company Admin | D1 comment in `company-membership-provisioning.service.ts` | VERIFIED (absent) |

### 1.3 Findings that affect any Plan feature (new — not about plans themselves; code-reading level, none runtime-tested)

**F1 — Suspend: no `Company.status` check found in the access path.**
Three separate claims, deliberately not merged:
- **VERIFIED (code path):** `CompanyActivationService.suspend()` only updates
  `companies.status`. The access path checks (a) `Membership` (`CompanyContextGuard`) and
  (b) `DatabaseRegistry.status === 'ACTIVE'` (`company-connection-manager.service.ts:59`).
  `DatabaseRegistry.markStatus` is called only inside provisioning (`FAILED`/`ACTIVE`); no
  caller sets it on suspend. `Company.status` is read only by `listVisible` (hides
  PROVISIONING). No explicit check of `Company.status` exists in the access path.
- **INFERRED:** a member of a SUSPENDED Company can still select it and perform operations.
  This follows from the code path above but was **not demonstrated**.
- **NOT VERIFIED:** actual behavior over HTTP and against a database (no request was sent,
  no test run). Other enforcement points not found by this search cannot be ruled out.

**Suspend and Decommission are separate cases.** The above concerns `suspend()` only.
`decommission()` (reachable only from DEGRADED/SUSPENDED/MIGRATING/FAILED) takes the same
`transitionTo` path and also sets only `companies.status`, but its effect on access, data
retention and database handling was **not analysed** here; the Suspend finding does not
establish Decommission behavior. NOT VERIFIED.
Impact: until runtime behavior is confirmed, "Suspend company" in the proposal should be
treated as a status label with no *demonstrated* access-control effect.

**F2 — Per-Company entitlement is write-only.**
`EntitlementService` is an in-process singleton reading one `installation` row through its
own injected DataSource ("The installation is a singleton, so `resolve()` returns an
in-process cached value"). The manifest written into a Company DB is not read by any
non-spec code. `CompanyContextGuard` does not reference entitlement. Therefore two Companies
cannot currently have different module sets at runtime. VERIFIED (code).

**F3 — Limits are not provisioned per Company.**
`database-provisioning.service.ts` and `company-entitlement-provisioning.ts` contain no
limit seeding; `LimitRegistrySeeder` seeds through the ambient DataSource. Under the limit
engine's own rule (no profile = unlimited), a new Company's limits are by-code unlimited.
VERIFIED (code); NOT VERIFIED (runtime). Correction to an earlier answer in this session:
a Company Admin does **not** hold `core.limit.edit` — the seeded Company `admin` role gets
module nodes plus three literal core nodes (members.manage, backup.manage, audit.view) —
and `LimitController` has no `CompanyContextGuard`: it uses `JwtAuthGuard + RolesGuard`
(no required role declared) plus a per-route `PermissionGuard` on `core.limit.view` /
`core.limit.edit`. It therefore acts on the ambient (platform) DataSource, and the node is held
by the platform `admin` role.
**NOT VERIFIED — Permission evaluation database and tenant boundary:** which database
`PermissionGuard` evaluates for this non-Company-scoped route, and therefore where the tenant
boundary of `/limits` lies, was not established. "Limit editing is a platform action, not a
Company one" is an INFERENCE from the absence of Company context plus the Company admin
role's seeded nodes; it is not a verified fact. **Consequence (stop condition):** `/limits`
must not be used as a commercial-management or Tenant-configuration interface until this is
resolved.

**F4 — A UI-created Company's admin receives no module permissions.**
`CreateCompany.tsx` sends only `name` + `initialAdminUserId`; `roleModuleCodes` defaults to
`[]`; `seedCompanyAdminRole(database, [])` then grants the `admin` role only the three core
nodes. VERIFIED (code); NOT VERIFIED (runtime). Impact: a plan→module mapping is the missing
input that would populate this; today it is silently empty.

**F5 — Platform `admin` is also the operational admin.**
`@RequireRole('admin')` guards the Control Plane, installation memberships, entitlement apply,
limits, and `admin/*`. There is no separation between platform operator and operational
administrator. VERIFIED (code).

---

## 2. EXISTING DECISIONS (not to be overridden by this study)

| Decision | Source | Study stance |
|---|---|---|
| **Model B** — one DB per Company; Membership as source of Company belonging; RBAC inside the Company DB; JWT `companyId` is transport only | `AuthorizationService` doc (via ADR-073 §2), `company-context.guard.ts` | Preserved. Not reopened. |
| **D1** — Membership Management never creates a `User`; `initialAdminUserId` must be an existing User | `company-membership-provisioning.service.ts`; `CreateCompanyDto`; ADR-073 §7 | Preserved. §5 DP-3 studies an *additive* extension only. |
| **D7** — no READY Company without an administrator | `database-provisioning.service.ts` | Preserved. |
| **ADR-073 (Option D)** — Company DB user-identity FK adjustment | ADR-073 header: APPROVED/IMPLEMENTED/CLOSED | Preserved. |
| **ADR-074 (Hybrid B)** — Company entity registry | ADR-074 header | Preserved. |
| **ADR-055** — Entitlement ≠ Permission; Package Builder composes the edition; backend is final authority; hiding a menu is not entitlement | `ADR-055-…md`, `architecture/DAII_MODULAR_PACKAGE_ENTITLEMENT_PERMISSION_CONTRACT.md` | Preserved; this study is the first design of the "Package Builder" it names. |
| **ADR-015** (PROPOSED) / **ADR-019** (ACCEPTED) — deployment-model independence; on-prem must not require internet; on-prem licensing question explicitly left open | ADR-015, ADR-019 | Preserved. The on-prem licensing question stays open; DP-1 must not close it implicitly. |
| **Area 21 / ADR-075** — controller retrofit under STOP; Event Engine Company context under CTO review | `AREA21-RETROFIT-MATRIX.md`, memory of CTO directive | Out of scope; this study changes nothing there. §4 flags the dependency. |
| **Company lifecycle table** — `READY→DECOMMISSIONED` not allowed; recorded as explicit decision | `company-status.ts` | Preserved. |

NOT VERIFIED: the "Multi-Company Phase 3 V7" source document and a stand-alone "Model B"
ADR are referenced throughout code comments but are not present in the repository
(`backend/docs/decisions/`, `backend/docs/blueprints/`, `architecture/`). ADR-023, -024,
-028 are likewise cited by code but not located. This study relies on the code comments
and ADR-073 §2 for those decisions, and says so.

---

## 3. PROPOSED TARGET ARCHITECTURE (PROPOSED)

### 3.1 Layers

```
XNEXUS (SaaS Owner)
 └─ DAII SaaS Control Plane            (same product at first; separate security boundary)
     ├─ Company Registry               ── EXISTS (reuse as-is)
     ├─ Company Provisioning           ── EXISTS (reuse; add plan input)
     ├─ Plan & Package Catalog         ── NEW
     ├─ Subscription                   ── NEW (commercial state, term, grace)
     ├─ Entitlement Resolution         ── NEW per-Company reader; manifest artifact kept
     ├─ Platform Identity & Roles      ── NEW (separate axis from Company roles)
     ├─ Platform Audit                 ── EXISTS (AuditService) + new event types
     └─ Billing (deferred)             ── architectural seam only
 └─ DAII ERP Tenant Layer (one DB per Company, Model B)  ── EXISTS
```

### 3.2 Separation of concerns (PROPOSED)

| Concern | Owner | Store |
|---|---|---|
| Plan definition (modules, features, limits) | Control Plane | Platform DB |
| Subscription (which plan, term, status, grace) | Control Plane | Platform DB |
| Resolved entitlement of a Company | derived from Subscription; materialized per Company | see DP-1 |
| Company membership | Control Plane | `user_company_memberships` (exists) |
| Company roles/permissions | Company DB | `roles/role_permissions/user_roles` (exists) |
| Platform operator authority | Control Plane | NEW platform-role store (DP-4) |

### 3.3 Provisioning with a plan (PROPOSED, extends the existing flow)

Create Company → **select Plan** → **create Subscription** → provision DB (existing) →
**derive** `tags`/`roleModuleCodes`/limits/manifest **from the Plan** (these three are
already the seams `DatabaseProvisioningService` documents as "explicit provisioning
input") → create/assign initial admin (D1 path; DP-3) → READY.

The existing doc comment states the intended seam exactly: *"provisioning consumes a resolved
package/entitlement profile, it does not compute one."* The Plan Catalog becomes the missing
resolver; provisioning itself need not change shape.

---

## 4. CONFLICT & IMPACT MATRIX

| Proposal element | Existing artifact touched | Conflict? | Impact / note |
|---|---|---|---|
| Plan Catalog in Platform DB | `editions*` tables (exist, unused by UI) | **No conflict; reuse candidate** | The `editions/edition_modules/edition_features/edition_limits` tables already model plan→module/feature/limit. Decision whether to reuse or supersede is DP-1. |
| Per-Company runtime entitlement | `EntitlementService` singleton, `RequireModuleGuard` (sync, no request context) | **Yes — structural** | Guard is synchronous and context-free. A per-Company check needs request-scoped Company context. Interacts with Area 21 (Company-aware guards) which is under CTO STOP. |
| Manifest generated from a Plan | Manifest is signed by an external issuer; fingerprint bound to the customer machine | **Yes — signing authority** | Who holds the private key; one fingerprint is shared by all Companies of an Installation (`company-entitlement-provisioning.ts`). |
| XNEXUS as a Tenant | Comment in `Layout.tsx`: "XNEXUS is not an operational Company tenant" | **Yes — implicit decision (not an ADR)** | DP-2. A code comment, not a ratified ADR; still must be superseded explicitly. |
| Create/invite Company Admin | D1 ("never creates a User") | **Yes — touches D1** | DP-3. Study treats as additive extension; D1 stands until ruled. |
| Platform roles | `@RequireRole('admin')` everywhere; platform `roles`/`user_roles` also hold the operational `admin` | **Yes — SoD** | DP-4. Today platform operator ≡ platform admin ≡ any user holding `admin`. |
| Subscription suspension | No `Company.status` check found in the access path (F1; code-path VERIFIED, runtime NOT VERIFIED) | **Probable gap in a ratified feature (to be confirmed)** | Likely prerequisite for any Subscription lifecycle, pending runtime confirmation. |
| Plan limits | Company-owned `limit_profiles`, unseeded (F3) | **Gap** | DP-6. |
| Plan→module → Company admin permissions | `roleModuleCodes` default `[]` (F4) | **Gap** | Plan input fixes it. |
| Billing | nothing | **None** | DP-7: seam only. |
| On-prem install | ADR-015/019; Entitlement is installation-local, works offline | **Potential** | A SaaS Plan Catalog must not become mandatory for an on-prem install (DP-8). |
| Area 21 retrofit (43 controllers) | Approval/Event/Config engines still ambient | **Dependency** | Company-scoped entitlement and limits rely on the same Company-context plumbing. Do not sequence ahead of the CTO's Area 21 rulings. |

---

## 5. DECISION PACKAGES

Each package: options, advantages, risks, recommendation (PROPOSED). Nothing is decided here.

### DP-1 — Source of truth for plan & entitlements (DECISION REQUIRED)

| | A. Catalog in Platform DB + generate signed Manifest | B. Read entitlements directly from Control Plane tables | C. Hybrid: Catalog is authoring truth; Manifest stays the runtime artifact; per-Company resolver reads the Company's own manifest |
|---|---|---|---|
| Runtime source | Signed manifest per Company | Plan/Subscription rows | Company-DB manifest (already written by provisioning) |
| Signature / fingerprint | Preserved (needs issuer key access from the Control Plane) | Not used for SaaS Companies; bypasses signature | Preserved |
| Tamper resistance | Highest | Lowest (platform DB trust only) | High |
| On-prem compatibility | Same artifact as on-prem | Diverges from on-prem path | Same artifact as on-prem |
| Reuses existing code | `verifyManifest`, `applyEntitlementManifestToCompany`, `editions*` | Little | Most (writer already exists; only a reader is missing — F2) |
| Main risk | Private signing key now lives in/behind the Control Plane | Two entitlement mechanisms to maintain | Resolver must be Company-context-aware (Area 21 coupling) |

PROPOSED provisional candidate (not approved): **C**. It keeps the signed artifact
(ADR-015/019 independence, anti-clone) and can reuse the `editions*` tables as the authoring
catalog; the manifest writer already exists. **DP-1 is a Runtime Resolution Architecture
decision, not only a choice of where entitlements are stored.** Option C must not be read as
"add a reader": the decision includes at least:
1. How the Company context is determined reliably at the point of the entitlement check.
2. How entitlement is bound to the *correct* Company (and never to another).
3. How to handle `RequireModuleGuard` being synchronous and context-free today
   (`isModuleEntitled(code): boolean`, no request argument) — this is a change to a shared
   guard, not an addition beside it.
4. How manifest signature verification and the fingerprint binding are preserved on that path.
5. How the Control Plane stays a non-mandatory dependency for On-Prem installs.
6. Key custody (who may sign) — a separate DECISION REQUIRED inside DP-1.
Items 1–3 touch shared engines adjacent to Area 21 and are subject to the P-1/Area 21
boundary in §6. The on-prem licensing question (ADR-015) is **not** closed by any option and
stays open.

### DP-2 — XNEXUS as a Tenant (DECISION REQUIRED)

Current state: a code comment says XNEXUS is not an operational Company tenant (not an ADR).
Options: **A.** keep as is (XNEXUS owns the platform only; uses no ERP). **B.** XNEXUS becomes
an ordinary Company with its own DB, admin and internal subscription; platform authority stays
a separate identity axis. **C.** B plus a documented exception (e.g. an internal "owner" plan).
Risks of B: a User who is both a Platform Operator and an XNEXUS Company member must not
inherit one from the other (requires DP-4 first). PROPOSED: B, **sequenced after DP-4**.
Requires an explicit superseding record of the existing comment; do not change it implicitly.

### DP-3 — Company Admin onboarding vs. D1 (DECISION REQUIRED)

D1 stands. Options: **A.** keep: operator pre-creates the User (current). **B.** additive
"invite" step: Control Plane creates an *invitation* record; the User (and credential) is
created by a separate, explicit identity flow, then `initialAdminUserId` is passed to the
**unchanged** provisioning path — D1 text ("Membership Management never creates a User") stays
literally true. **C.** provisioning creates the User directly (supersedes D1 — requires
explicit ruling, not recommended as the first step). Open sub-questions: invitation transport
(email/out-of-band), credential first-set, expiry/revocation, audit event. PROPOSED: B as a
new component *beside* D1, never inside Membership Management.

### DP-4 — Platform Identity & roles / SoD (DECISION REQUIRED)

Requested roles: Platform Owner/Administrator, Commercial Operator, Support Operator, Company
Admin. Verified: only one platform role exists (`admin`, F5). Options: **A.** new platform-role
tables in the Platform DB, separate from `roles/user_roles` used for Company authorization.
**B.** reuse `roles/user_roles` with a `platform.*` node namespace (cheaper; keeps one engine
but mixes axes). **C.** keep `admin` and add finer permission nodes only. Proposed SoD
(PROPOSED, not decided): Commercial Operator manages plans/subscriptions but cannot provision
databases or access Company data; Support Operator has read-only/time-boxed Company access via
a *separate, audited* path; Platform Owner holds key-custody and role assignment; a single
person should not both create a plan and approve its assignment to a Company (FA-01 is the
existing approval mechanism and is a candidate). NOT VERIFIED: whether platform `user_roles`
can already express a non-`admin` platform operator without schema change.

### DP-5 — Subscription lifecycle (DECISION REQUIRED)

States to decide (PROPOSED set, not ratified): `TRIAL?`/`ACTIVE`/`PAST_DUE?`/`GRACE`/`SUSPENDED`/
`CANCELLED`/`EXPIRED`. Verified building blocks: manifest `term_start/term_end/grace_days`;
`EntitlementService` already derives a status from the manifest term. Required decisions:
(1) mapping Subscription state → `Company.status` (and F1 enforcement), (2) **downgrade
semantics**: module removal retains data (ADR-023 O-5 as cited in code) — but what of users,
roles, limits above the new ceiling, in-flight workflows, a Company already over a lower limit,
(3) upgrade timing (immediate vs period end), (4) re-provisioning requirements (module
migrations are tag-based; a newly entitled module's migrations/roles must be applied to an
existing Company DB — NOT VERIFIED that the Company path supports adding a tag after creation),
(5) who may approve each change. F1 must be confirmed and, if confirmed, resolved first: without runtime enforcement,
Subscription suspension has no effect.

### DP-6 — Usage limits: commercial vs operational (DECISION REQUIRED)

Verified: Company-owned counters; `/limits` is a non-Company-scoped, permission-gated surface
(see F3); provisioning seeds none (F3). Options: **A.** plan limits are pushed into each Company's `limit_profiles` at
provisioning/upgrade and mark them platform-owned (Company cannot edit — currently true only
because no Company route exposes it). **B.** limits resolved from the manifest `limits` field
(already part of the signed artifact) and `LimitService` reads that as the ceiling, with
`limit_profiles` allowed only to *tighten*. PROPOSED: B (ceiling from the signed artifact, local
profile can only lower it) — keeps the commercial/operational split without a new table.
DECISION REQUIRED: which limit keys are *commercial* (users, branches, employees…) — the
repo defines e.g. `hr.max_employees`; "users" and "branches" limit keys are NOT VERIFIED to
exist.

### DP-7 — Billing (analysis only; NOT in implementation scope)

Per the instruction, no gateway or billing engine is proposed. Analysis:
- **Does a subscription need internal billing, or only a recorded commercial state?**
  DECISION REQUIRED. Minimum viable seam: Subscription carries `term_start/term_end/grace`,
  a free-text `commercial_reference` and an operator-recorded `paid_through` date — i.e. a
  *recorded* state, manually maintained.
- **Electronic vs. manual payment in phase 1:** DECISION REQUIRED (assumption NOT made).
- **Invoices / renewals / grace:** grace is already expressible in the manifest; renewals are
  a manifest re-issue; invoices are NOT designed. The repo's `Invoice`/`Payment` domain is
  tenant customer finance and must not be reused for SaaS billing without an explicit ruling.
- **Must be architecturally ready without building billing:** (a) Subscription is its own
  entity separate from Plan and from Company status; (b) all state changes emit auditable
  events; (c) no code path assumes payment exists; (d) currency/tax handling kept out of the
  Subscription model; (e) an `external_billing_ref` slot so a future billing system can attach.

### DP-8 — On-prem compatibility (DECISION REQUIRED)

ADR-019 requires zero mandatory external connectivity for operations; ADR-015 leaves on-prem
licensing open. PROPOSED guard-rails: (1) the signed manifest remains the **only** thing an
on-prem install needs; (2) the Plan Catalog / Subscription / Control Plane are optional
components — an on-prem Installation applies a manifest as today (`POST /admin/entitlement/apply`)
and has no dependency on a Control Plane; (3) the SaaS Control Plane is just one *issuer* of
manifests. DECISION REQUIRED: whether DAII commercially licenses on-prem installs (the open
ADR-015 question) — this study does not answer it.

### DP-9 — Suspension enforcement (F1) (DECISION REQUIRED, prerequisite)

Premise to confirm first: F1 is VERIFIED only at code-path level (INFERRED/NOT VERIFIED at
runtime), and covers Suspend only — Decommission behavior is a separate, un-analysed question.
Options: **A.** `CompanyContextGuard` additionally checks `Company.status` (READY only).
**B.** suspend also marks `DatabaseRegistry.status` non-ACTIVE (connection manager already
refuses it). **C.** both. Trade-offs: B reuses an existing refusal point but conflates a
commercial state with a database-health state (`FAILED`/`ACTIVE` meanings); A is explicit but
adds a lookup per request. Also decide: read-only access during suspension vs. full block,
and the effect on `POST /auth/select-company` and already-issued tokens (tokens carry
`companyId`; the guard re-validates Membership per request, so a per-request status check
takes effect immediately). Touches shared auth plumbing, adjacent to Area 21 — **needs CTO
authorization before any code**.

---

## 6. PHASED IMPLEMENTATION ROADMAP (PROPOSED — requires ratification of §5 first)

| Phase | Content | Depends on | Notes |
|---|---|---|---|
| **P-0** | This study → CTO rulings on DP-1…DP-9 | — | Current phase. |
| **P-1** | Candidate scope: address **F1** (suspend enforcement) + **F4** (admin permissions from an explicit module list in the UI/API). **Conditional:** only after F1/F4 runtime confirmation and an explicit CTO ruling on the allowed change boundary next to Area 21 | DP-9; confirmation of F1/F4; CTO ruling on boundary | Prerequisite for later phases. "Smallest correct change" here is a goal, **not** an authorization: it does not permit modifying `CompanyContextGuard`, `AuthService`, `RequireModuleGuard`, `EntitlementService` or the Approval/Event/Config engines. Each such file needs its own explicit authorization. |
| **P-2** | Platform identity & roles (separate axis) | DP-4 | Gate for XNEXUS-as-tenant (DP-2) and for SoD on plans. |
| **P-3** | Plan Catalog (authoring) + Plan→(tags, roleModuleCodes, limits, manifest) resolver; Create Company takes a plan | DP-1, DP-6 | Reuses `editions*`. |
| **P-4** | Per-Company entitlement reader + limit ceiling | DP-1, DP-6; Area 21 Company-context rulings | Highest coupling risk. |
| **P-5** | Subscription entity + lifecycle + upgrade/downgrade | DP-5, P-1, P-3, P-4 | Requires proof that an existing Company DB can gain/lose a module tag. |
| **P-6** | Company Admin invitation (additive to D1) | DP-3 | Independent; can run in parallel after P-2. |
| **P-7** | XNEXUS tenant | DP-2, P-2 | Optional. |
| **P-8 (deferred)** | Billing | independent ruling | Not in implementation scope. |

Each phase follows the program's existing discipline: Evidence → Decision → Authorization →
Code → Real-PG → Regression → Closure.

---

## 7. OPEN QUESTIONS & STOP CONDITIONS

**Open questions**
1. Who holds the manifest-signing private key in a SaaS deployment, and may the Control Plane sign? (DP-1)
2. Is there a single `installation_fingerprint` for the SaaS host, and is sharing it across all Companies acceptable? (Currently so by design — `company-entitlement-provisioning.ts`.)
3. Can an existing Company DB gain a new module's migrations/role templates after creation? NOT VERIFIED.
4. Which limit keys are commercial? "Users"/"branches" keys NOT VERIFIED to exist.
5. Does a platform operator need distinct credentials/MFA from tenant users? NOT VERIFIED (no MFA concept located).
6. Does the on-prem product get a commercial license? (ADR-015, open.)
7. Do the 5 findings F1–F5 need runtime confirmation before rulings? Recommended, **only under separate authorization** (nothing was run for this study): a read-only/test-only proof for F1, F3, F4 on a clean Company (the dev DB is documented as contaminated by the 2026-10-04 audit; numeric conclusions need a clean Company).

**Stop conditions (do not proceed to an Implementation Contract if any holds)**
- DP-1 (entitlement source/key custody) or DP-9 (suspension enforcement) unresolved.
- Any change that edits `EntitlementService`, `RequireModuleGuard`, `CompanyContextGuard`, `AuthService`, or the Approval/Event/Config engines before the CTO's Area 21 rulings (these are shared engines under the standing STOP directive).
- Any proposal that edits D1, Model B, ADR-073/074 or ADR-015/019 without a recorded explicit decision.
- A design that makes the Control Plane mandatory for an on-prem install.
- Billing design or a payment gateway being introduced into implementation scope.

## 8. Evidence index (all read-only)

`foundation/company/{company.entity,company-status,company-activation.service,company-registry.controller,company-registry.service,company-context.guard,company-role-seeding,company-entitlement-provisioning,membership.entity,company-membership-provisioning.service}.ts` ·
`foundation/database-provisioning/database-provisioning.service.ts` ·
`foundation/database-registry/{database-registry.service,company-connection-manager.service}.ts` ·
`foundation/entitlement/{entitlement.service,entitlement.controller,edition.entity,manifest.type}.ts` ·
`foundation/module-lifecycle/module-lifecycle.service.ts` ·
`foundation/module-registry/require-module.decorator.ts` ·
`foundation/limit-engine/{limit.service,limit.controller,limit-registry.seeder}.ts` ·
`foundation/authentication/auth.service.ts` · `foundation/authorization/roles.guard.ts` ·
`frontend/src/{components/Layout.tsx,App.tsx,pages/control-plane/*}` ·
`backend/docs/decisions/{ADR-015,ADR-019,ADR-055,ADR-073,ADR-074,P0-MULTI-COMPANY-CONTROL-PLANE-API}.md` ·
`architecture/DAII_MODULAR_PACKAGE_ENTITLEMENT_PERMISSION_CONTRACT.md`.

**Not run:** no runtime test, no HTTP call, no database query was executed for this study;
every VERIFIED mark above is source/ADR reading. No existing file was modified.
