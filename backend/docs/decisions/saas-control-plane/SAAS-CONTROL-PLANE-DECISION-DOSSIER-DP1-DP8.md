# SaaS Control Plane — Consolidated Decision Dossier (DP-1 … DP-8)

**Status:** PROPOSED / EVIDENCE ONLY. **DP-9 is DECIDED** (see `DP-9-SUSPENSION-ENFORCEMENT-DECISION-RECORD.md`).
Nothing below is decided, authorized or implemented. No option is approved because it appears here
or in `docs/studies/SAAS_CONTROL_PLANE_TENANT_LIFECYCLE_PHASE0_STUDY.md`. **Date:** 2026-10-05.

Labels used on every claim: **VERIFIED** (source read, or executed where stated) · **PROPOSED** ·
**NOT VERIFIED** · **NOT FOUND**.

> **RULINGS 2026-10-05 (CTO) — read before anything below.** DP-9 **DECIDED** · DP-8 **DECIDED (8-1)** · DP-4 **DECIDED (4-A)** · DP-1 **architecture DECIDED IN PRINCIPLE — CONDITIONAL** (per-Company resolution, explicit Company context, signed manifest/runtime artifact in the authority chain, no default/ambient context). Implementation of every one of these: **NOT AUTHORIZED**. Existing Plans code: **NOT RATIFIED**. Approval Engine retrofit: **HOLD / NEEDS RE-PROOF**. The options discussion for DP-8/DP-4/DP-1 below is **historical**; the authoritative records are `BATCH-A-DECISION-PACKAGE-DP8-DP4-DP1.md` (v2) and `DP-9-SUSPENSION-ENFORCEMENT-DECISION-RECORD.md`. **Later rulings (2026-10-05, second/third round): DP-3 DECIDED (additive invitation; transport OPEN) · DP-2 DECIDED (XNEXUS is platform-level, not a Company — overrides the lean in the DP-2 section below) · CD-1 DECIDED as policy.** DP-5, DP-6, DP-7 remain open (Batch B, pending CTO review).
> **F4 of the Phase-0 study is SUPERSEDED** (real-Postgres characterization WP-0.5c): it must not be used as a basis for DP-4 or DP-6.

---

## 1. Verified fact base shared by all packages

| # | Fact | Class |
|---|---|---|
| F-1 | No Plan catalog API/UI, Subscription, Billing, Renewal, Trial or Metering exists. The `editions`, `edition_modules`, `edition_features`, `edition_limits` tables exist; only `DAII_STANDARD` is seeded; no controller or UI uses them. | VERIFIED (content search) |
| F-2 | Entitlement is installation-wide at runtime: `EntitlementService` caches one `installation` row from the ambient DataSource; `isModuleEntitled(code)` is synchronous with no request context. A per-Company manifest can be *written* (`applyEntitlementManifestToCompany`, optional provisioning parameter, not exposed by the HTTP DTO) but nothing reads it. | VERIFIED |
| F-3 | The module set and migration tag set are resolved per *installation* at boot (`enabled-modules.ts`); only a Company's database tag set is per Company, and only at provisioning. | VERIFIED |
| F-4 | 43 controllers use `RequireModuleGuard`; **27 also use `CompanyContextGuard`; 16 do not** — and those 16 are exactly the 16 remaining Area 21 controllers (`accounting ap ar attendance cash-bank commission fixed-asset hr inventory-accounting invoices payroll returns rfq sales supplier target`). For those 16 a request-context-based entitlement lookup has no Company context to read. | VERIFIED (count + file list) |
| F-5 | Platform authority is one role, `admin` (platform `roles`/`user_roles`), which also guards the control plane, entitlement apply, installation memberships and `admin/*`; the first user ever registered is granted it automatically. The same platform `roles` table also holds operational role keys (`sales_rep`, `sales_manager`, `driver`, …). | VERIFIED |
| F-6 | Limits: `LimitService.check/consume` read `limit_profiles` through the Company manager when supplied (else ambient). `LimitController` (`/limits`) has no `CompanyContextGuard`; `PermissionGuard` evaluates through `request.companyContext?.dataSource.manager`, which is therefore undefined on this route → permission evaluation and profile writes use the **ambient (platform) database**. **There is no API that edits a Company database's limit profiles.** Provisioning seeds no limits, and "no profile = unlimited". Net: every Company is currently unlimited and its limits are not editable by any route. | VERIFIED (code; not executed) |
| F-7 | Limit keys in use: `accounting.max_gl_accounts`, `sales.max_customers`, `hr.max_employees`; `sales.max_reps` is declared in a manifest (enforcement not confirmed). **`users.max` and `companies.max` do not exist anywhere** in `backend/src`, `backend/docs` or `architecture/`; `POST /installation/companies` has no limit check. | VERIFIED / NOT FOUND |
| F-8 | Company Admin onboarding: `CreateCompanyDto` requires `initialAdminUserId` of an **existing** User (D1: provisioning never creates a User). `notification/` contains only a README — **no email/notification transport exists**. No MFA/TOTP concept was found. `User.status` defaults to `pending`; bootstrap `register` activates immediately. | VERIFIED / NOT FOUND |
| F-9 | The manifest carries `installation_fingerprint`, computed on the customer's own machine and signed by the vendor; one fingerprint is shared by all Companies of an installation. In SaaS, XNEXUS is both operator and issuer. | VERIFIED |
| F-10 | `XNEXUS is not an operational Company tenant` exists only as a code comment (`Layout.tsx`), not an ADR. | VERIFIED |
| F-11 | Whether an *existing* Company database can gain a module's migrations/role templates after creation (`runMigrationsForDatabase` accepts a tag list) has never been exercised. | NOT VERIFIED |
| F-12 | Existing decisions that bind every package: Model B (one DB per Company; Membership in the platform DB; RBAC inside the Company DB); D1; D7 (no READY Company without an administrator); ADR-073/074; ADR-055 (entitlement ≠ permission; backend is final authority); ADR-015/019 (deployment-model independence; on-prem must work offline; **on-prem licensing explicitly left open**); DP-9. | VERIFIED |

---

## 2. Cross-package dependency map

| Package | Depends on | Feeds | Touches shared engines? |
|---|---|---|---|
| DP-1 Entitlement runtime resolution | DP-8 (on-prem), DP-4 (who may sign), Area 21 (F-4) | DP-5, DP-6, P3/P4 | **Yes** — `EntitlementService`, `RequireModuleGuard`, Config EDITION layer |
| DP-4 Platform identity & roles | — | DP-1 (key custody), DP-2, DP-3, DP-5 (approvals) | Yes — platform roles / `RolesGuard` usage |
| DP-6 Commercial limits | DP-1 (ceiling source), Area 21 | DP-5 (downgrade semantics) | `LimitService` consumers; a new Company-side surface |
| DP-5 Subscription lifecycle | DP-1, DP-4, DP-6, DP-9 ✔, DP-7 | P5 | Company status transitions (DP-9) |
| DP-3 Admin invitation / onboarding | DP-4, D1 | P5 | Identity (`UsersService`/credentials) — new component beside D1 |
| DP-2 XNEXUS tenant | DP-4 (must precede) | P5 (optional) | No |
| DP-8 On-prem compatibility | ADR-015 (open) | DP-1 | No |
| DP-7 Billing boundary | DP-5 | deferred | No |

**Decision batching (PROPOSED).** Rule in three batches to avoid re-work:
**Batch A = {DP-8, DP-4, DP-1}** (DP-1's key-custody and on-prem sub-decisions cannot be ruled without the other two);
**Batch B = {DP-6, DP-5, DP-7}** (limits ceiling and downgrade semantics are one question; billing is only a seam);
**Batch C = {DP-3, DP-2}** (both depend only on DP-4). CD-1 (§10) can be ruled with any batch.

---

## DP-1 — Entitlement Runtime Resolution Architecture (priority 1)

**Question.** What is the source of truth for a Company's plan/entitlements, and how does a request resolve entitlement for the *correct* Company?

**Decomposition (every item is a separate ruling inside DP-1):**

| # | Sub-decision | Options | Notes |
|---|---|---|---|
| 1a | Runtime artifact | (i) signed manifest per Company; (ii) plan/subscription rows read directly | Signature protects against DB tamper/operator error in SaaS; its anti-clone purpose (F-9) is on-prem-shaped |
| 1b | Authoritative copy | Platform plan/subscription (authoring) → materialized per Company | Reuses the existing writer (F-2) |
| 1c | How a request finds its Company | Guard reads `req.companyContext.companyId` → per-Company cache; **not** a JWT entitlement claim (Model B: JWT is transport only) | Works for 27 of 43 module-guarded controllers; **impossible for the 16 until Area 21 closes them** (F-4) |
| 1d | Key custody | Who may sign; may the Control Plane sign | Needs DP-4 |
| 1e | On-prem independence | Manifest stays the only thing an on-prem install needs; Control Plane is one optional issuer | Needs DP-8; does **not** close ADR-015 |
| 1f | Boot-time module graph | Per-Company entitlement can gate *requests* only; module loading/migrations remain installation-wide (F-3) | Must be stated explicitly, not implied |

**Options (from the Phase 0 study, restated).**
A — authoring catalog + generated signed manifest (signing key reachable from Control Plane).
B — read plan/subscription rows directly (bypasses signature; diverges from on-prem).
C — hybrid: catalog is authoring truth, signed manifest is the Company-DB runtime artifact, per-Company reader resolves by request Company.

**Conflicts.** B conflicts with ADR-015/019 parity. All options change a shared sync guard/engine (stop-condition territory). The Config EDITION layer reads `activeEditionCode()` installation-wide — plan-dependent config is installation-wide unless addressed (links to Area 21 Config decision).

**Cost/Effects.** Resolver + cache invalidation on apply; `RequireModuleGuard` becomes context-aware (57 `@RequireModule`, 27 `@RequireFeature` use sites, 7 resolver injection sites); front-end `me/entitlements`/navigation are installation-level today and must become Company-aware.

**PROPOSED lean (not approved):** C, sequenced after DP-8 and DP-4, with 1c scoped to Company-context controllers and an explicit interim rule for the 16 (installation-level entitlement until Area 21 closure).

**Open questions.** Cache TTL/invalidation (Gate D); behavior when a Company has no manifest (fail-closed vs installation default); who may re-issue.

---

## DP-4 — Platform Identity, Roles & Separation of Duties

**Question.** How is platform authority modelled separately from Company authorization?

**Verified base:** F-5 (one `admin`, first-user bootstrap, platform `roles` holds operational keys too).

| Option | Description | Trade-off |
|---|---|---|
| A | New platform-role tables in the platform DB, separate from `roles/user_roles` | Cleanest axis separation; new tables + guard |
| B | Reuse `roles/user_roles` with a `platform.*` node namespace | Cheaper; keeps mixing the axes F-5 describes |
| C | Keep `admin`; add finer permission nodes only | Smallest; does not separate operator from operational admin |

**Proposed separation-of-duties target (PROPOSED):** Platform Owner (key custody, role assignment) · Commercial Operator (plans/subscriptions; no database provisioning, no Company data) · Support Operator (read-only, time-boxed, separately audited Company access) · creator ≠ approver for plan assignment (FA-01 is the existing approval mechanism, but note it is itself still ambient under Area 21).

**Conflicts.** `@RequireRole('admin')` currently gates every control-plane surface; first-user-becomes-admin bootstrap is a security-relevant default. **NOT VERIFIED:** whether platform `user_roles` can express a non-`admin` operator without schema change. **NOT FOUND:** MFA.

**Dependencies.** None upstream. Feeds DP-1 (1d), DP-2, DP-3, DP-5.

---

## DP-6 — Commercial Limits & Enforcement

**Question.** Which limits are commercial, who sets them, and how are they enforced per Company?

**Verified base:** F-6, F-7 — Companies are currently unlimited; `/limits` acts on the platform DB; no `users.max`/`companies.max`.

| Option | Description | Trade-off |
|---|---|---|
| A | Push plan limits into each Company's `limit_profiles` at provisioning/upgrade, marked platform-owned | Reuses `LimitService`; needs a platform-owned marker and a write path that no Company route can reach |
| B | Ceiling resolved from the signed manifest `limits` field; local profile may only tighten | Keeps commercial/operational split without a new table; depends on DP-1 |

**Decisions inside DP-6.** (1) Which keys are commercial: add `users.max`/`companies.max` (new keys) vs map to existing ones. (2) `companies.max` is **installation-level** (enforced on `POST /installation/companies`, platform side) while `users.max` is **Company-level** — two scopes, two enforcement points. (3) What "user" counts (memberships? active users? seats). (4) Behavior at the ceiling and on downgrade below current usage (with DP-5).

**Dependencies.** DP-1 (B), Area 21 (Company-side limit reads already use the manager). **PROPOSED lean:** B, subject to DP-1.

---

## DP-5 — Subscription Lifecycle

**Question.** What are the subscription states, transitions and effects?

**Verified base:** no subscription exists (F-1); manifest `term_start/term_end/grace_days` and a derived status in `EntitlementService` are the only term concept; DP-9 defines the Company-status effect of suspension.

**PROPOSED state set (not ratified):** `TRIAL?` · `ACTIVE` · `GRACE` · `SUSPENDED` · `CANCELLED` · `EXPIRED`, as a separate entity from Plan and from `Company.status`.

**Decisions inside DP-5.** (1) Mapping subscription state → `Company.status` (DP-9: only `READY` grants access). (2) **Downgrade semantics:** module removal retains data and returns 404 on routes (existing module-lifecycle behavior, VERIFIED); but users/limits above the new ceiling and in-flight workflows are undefined. (3) Upgrade timing (immediate vs period end). (4) **Adding a module to an existing Company database is NOT VERIFIED (F-11)** and must be proven before upgrade is promised. (5) Approver per transition (DP-4). (6) Renewal/expiry processing must run **per Company** (existing scheduler pattern) and respect DP-9 O-1.

**Dependencies.** DP-1, DP-4, DP-6, DP-9 ✔, DP-7.

---

## DP-3 — Company Admin Invitation / Onboarding

**Question.** How does a new Company get its first administrator without breaking D1?

**Verified base:** F-8.

| Option | Description | Trade-off |
|---|---|---|
| A | Keep: operator pre-creates the User, passes `initialAdminUserId` | Works today; poor SaaS onboarding |
| B | Additive invitation: an invitation record; the User and credential are created by a separate identity flow; the existing provisioning path then receives `initialAdminUserId` unchanged | D1 stays literally true; needs a delivery transport |
| C | Provisioning creates the User directly | Supersedes D1; needs an explicit ruling |

**Decisions inside DP-3.** Invitation transport (**no notification transport exists** — out-of-band link vs a new notification component), first-credential setting, expiry/revocation, audit event, and who may invite (DP-4). **PROPOSED lean:** B as a component beside Membership Management, never inside it.

---

## DP-2 — XNEXUS as a Tenant

**Question.** Is XNEXUS an ordinary Company, and how is platform authority kept separate from its tenant membership?

**Verified base:** F-10 (a comment, not an ADR).

Options: **A** XNEXUS owns the platform only (status quo comment); **B** XNEXUS is an ordinary Company with its own database, admin and internal subscription, platform authority a separate identity axis; **C** B plus a documented internal "owner" plan.

**Constraint.** A person who is both a platform operator and an XNEXUS Company member must not inherit either authority from the other — impossible to guarantee until DP-4 exists. **PROPOSED lean:** B, sequenced after DP-4; requires an explicit superseding record of the existing comment.

---

## DP-8 — On-Prem Compatibility

**Question.** What keeps DAII On-Prem independent of the SaaS Control Plane?

**Verified base:** the signed manifest is applied through `POST /admin/entitlement/apply`; `ENTITLEMENT_MODE` defaults to `unlicensed-full`; entitlement works offline; ADR-019 forbids mandatory external connectivity; ADR-015 leaves on-prem licensing open.

**PROPOSED guard-rails:** (1) the signed manifest remains the only thing an on-prem install needs; (2) Plan Catalog, Subscription and Control Plane are optional components; (3) the SaaS Control Plane is one *issuer* of manifests. **Business decision required (not answerable from code):** whether DAII commercially licenses on-prem installs. No option in this dossier closes ADR-015.

---

## DP-7 — Billing Boundary (deferred scope)

**Verified base:** nothing exists; the repo's Invoice/Payment domain is tenant customer finance and must not be reused for SaaS billing without an explicit ruling.

**PROPOSED seam only (no billing engine):** Subscription is its own entity; every state change is an auditable event; no code path assumes payment exists; currency/tax kept out of the Subscription model; an `external_billing_ref` slot and an operator-recorded `paid_through` date. **Business decisions required:** manual vs electronic payment in phase 1; whether internal billing is needed at all.

---

## 10. Candidate decision CD-1 (not in the CTO's DP list — raised for triage)

**Provisioning-failure handling.** VERIFIED: on a provisioning failure the Company row stays `PROVISIONING` while the registry is `FAILED`; `listVisible` hides `PROVISIONING`, so the failed Company does not appear in `GET /installation/companies`; `reactivate` accepts `PROVISIONING → READY`, so a Company whose database failed can be forced to `READY` (the registry check still refuses connection); decommissioning has no retention/teardown logic. These are existing, previously decided behaviors (Area 2/19) that conflict with operability and with SaaS provisioning reliability (P3). **Decision requested:** triage as an in-scope decision (P3) or leave as accepted behavior.

---

## 11. What this dossier does not claim

No option is decided. No code, migration, ADR number, guard, or schema change exists as a result of it.
Production remains HOLD.

---

## 12. ADDENDUM 2026-10-05 — facts in §1 that the shared working tree has overtaken (read with `BATCH-A-DECISION-PACKAGE-DP8-DP4-DP1.md` §0)

The Dossier's fact base was verified before a parallel workstream added a Plans / Company-package implementation to the shared tree. The facts below were true when verified and are **no longer true of the current working tree**; they remain true of `HEAD`.

| Fact | Status now |
|---|---|
| F-1 (no Plan catalog API/UI) | **Overtaken in the working tree**: `foundation/plans/*`, `/installation/plans`, `/installation/companies/:id/package`, UI pages and a plan picker exist (unratified, foreign change). Still true: no Subscription, Billing, Renewal, Trial or Metering. |
| F-2 (entitlement runtime is installation-wide; no per-Company reader) | **Overtaken in the working tree**: `CompanyEntitlementService` + async `RequireModuleGuard`/`RequireFeatureGuard` resolve per Company via `request.companyContext.companyId`. The per-Company *signed manifest* is still unread. |
| F-4 (27/43 vs 16/43) | **Re-confirmed** by the workstream's own generated coverage document. |
| F-6 (limits scope, code reading) | **Executed** by WP-0.5b — see the WP-0.5 results document. |
| F-11 (module add on an existing Company DB) | **Executed** by WP-0.5a — see the WP-0.5 results document. |
| Phase-0-study F4 (UI-created Company admin has no module permissions) | **SUPERSEDED / INVALID** — contradicted by real-Postgres execution (WP-0.5a/c): the core migrations seed every module root and platform-style nodes (`core.limit.edit`, `core.entitlement`, `core.config`, `system.release`) onto the Company `admin` role. Not usable as evidence for DP-4 or DP-6. The study file itself is another workstream's committed document and is left unmodified; this Dossier carries the supersession. |

Every statement in §2–§11 about "DP-1 … nothing exists" must be read against this table.
