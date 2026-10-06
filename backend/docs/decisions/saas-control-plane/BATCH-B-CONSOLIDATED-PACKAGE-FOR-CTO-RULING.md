# Batch B — Consolidated Decision Package (DP-6 · DP-5 · DP-7) — for one CTO ruling

**Status:** PENDING CTO REVIEW. Docs only. Nothing here is decided, authorized or implemented. 2026-10-05.
**How to use:** §1 is the ruling sheet (one line per decision, with the PROPOSED answer and a blank for the CTO's ruling). §2 is the complete Batch B text (evidence, existing-tree evidence, dependencies, conflicts, options, bundle, authorization status, stop conditions). §3 is the current decision docket. Rulings are made on the whole package at once.

> **CTO RULING 2026-10-05 — BATCH B CLOSED AT DECISION LEVEL (implementation NOT AUTHORIZED).** The text below is the original proposal; the rulings are authoritative.
> **DP-6:** commercial limits only for keys that are enforced or explicitly approved for enforcement (the 22 declared-but-unenforced keys are not marketed as commercial) · `users.max` = **Company Membership seats**, consumed at **invitation acceptance** · `companies.max` = **installation-level** · Company-level commercial ceilings come from the **signed runtime artifact**; a local profile may **only tighten** · reaching a cap blocks **new consumption only** — no deletion/destruction · applying a limit to an existing Company requires **reconciling from real persisted rows before the counter starts**.
> **DP-5:** Trial optional, not mandatory in V1 · the SaaS Subscription owns the SaaS commercial term; On-Prem keeps the manifest term · `ACTIVE`/`GRACE`/`TRIAL` ⇒ `READY`; `SUSPENDED`/`CANCELLED`/`EXPIRED` ⇒ non-READY · **upgrade immediate, downgrade at period-end** · downgrade never deletes data; usage above the new ceiling is kept and new consumption refused · **platform-level approval / dual control**; the Company Approval Engine may not be a platform approver while on HOLD.
> **DP-7:** **seam only** — no billing engine, no payment gateway, no SaaS invoice engine, no reuse of tenant Invoice/Payment; phase 1 = manual/operator-recorded facts (`paid_through`, `commercial_reference`, `external_billing_ref`); internal billing is not a current architectural requirement.

## 1. Ruling sheet

| # | Decision needed | PROPOSED answer (not decided) | CTO ruling |
|---|---|---|---|
| **DP-6 Commercial limits** | | | |
| 6.1 | Which limit keys are commercial? The 22 declared-but-unenforced keys: in or out? | Only keys that are enforced or explicitly scheduled for enforcement; the other 22 are not advertised as commercial | |
| 6.2 | Define "user" for `users.max` | Count **Company memberships** (seats), not global user rows; seat consumed at invitation acceptance (ties to DP-3) | |
| 6.3 | Enforcement option | `companies.max` enforced platform-side (installation-level, option C); Company-level caps use a **manifest-sourced ceiling a local profile can only tighten** (option B); limit authority platform-owned (DP-4) | |
| 6.4 | Behavior at the cap and on downgrade below current usage | Refuse new consumption only; never delete existing data; downgrade re-evaluates caps (with 5.4) | |
| 6.5 | Counter vs real rows | When a cap is first applied to an existing Company, **reconcile the counter from real rows** | |
| **DP-5 Subscription lifecycle** | | | |
| 5.1 | Is there a Trial? | Decide as a business matter; model the state as optional | |
| 5.2 | Term ownership when both an installation manifest term and a subscription exist | SaaS: subscription owns Company term; On-Prem: manifest term unchanged (DP-8 8-1) | |
| 5.3 | State set and mapping to `Company.status` | `TRIAL?`/`ACTIVE`/`GRACE`/`SUSPENDED`/`CANCELLED`/`EXPIRED`; only active-type states ⇒ `READY`; the rest ⇒ non-READY (blocked per DP-9) | |
| 5.4 | Downgrade below current usage | Entitlement removal with data retention; over-ceiling usage stays readable, no new consumption; no deletion | |
| 5.5 | Upgrade timing | Immediate for upgrade; period-end for downgrade | |
| 5.6 | Approval mechanism for platform subscription/plan changes | A **platform-level** approval/dual-control mechanism (the Company Approval Engine is Company-scoped and on HOLD) | |
| **DP-7 Billing boundary** | | | |
| 7.1 | Scope | **Seam only**; no billing engine | |
| 7.2 | Payment in phase 1 | Manual, operator-recorded (`paid_through`, `commercial_reference`, `external_billing_ref`) | |
| 7.3 | Is internal billing needed at all | Business decision; not required by the architecture | |

**Order of dependence:** 6.x first → 5.x (needs 6.x, CD-1 policy ✔, platform approval mechanism under DP-4) → 7.x (needs 5.x).
**Authorization after ruling:** even when ruled, implementation of every item stays NOT AUTHORIZED until a Work-Package Authorization is issued; WP-0.4 is NOT MET; shared engines wait for it.

---

## 2. Complete Batch B text

## 0. Inherited decisions (binding on this batch)
DP-9 DECIDED (only `READY` grants access; guard Option A; 409 `COMPANY_NOT_READY`; no lifecycle cache; two-layer boundary, Backup exempt) · DP-8 DECIDED 8-1 (SaaS capabilities optional, never an On-Prem dependency) · DP-4 DECIDED 4-A (platform authority ≠ Company authority; no implicit escalation) · DP-1 architecture DECIDED IN PRINCIPLE / CONDITIONAL (per-Company resolution, explicit Company context, signed artifact in the chain, no ambient context; Area 21 16-controller condition) · F4 SUPERSEDED · R14 latent authority · CD-1 on the Risk Docket · WP-0.4 NOT MET · Plans / Approval / Event Engine work = NEEDS RE-PROOF. **Implementation of everything: NOT AUTHORIZED.**

---

## DP-6 — Commercial Limits & Enforcement

**1. State.** OPEN. Nothing decided. Conditional on DP-1 (ceiling source) and DP-4 (who sets limits).

**2. Verified evidence (read; WP-0.5b executed on the isolated instance).**
- 26 limit keys are *declared* in module manifests; **enforcement call sites exist for only three keys** — `accounting.max_gl_accounts`, `sales.max_customers`, `hr.max_employees`. `sales.max_reps` is referenced in one file (enforcement not confirmed). The other 22 declared keys have no reference outside manifests/migrations/specs. VERIFIED.
- `users.max` and `companies.max` — **NOT FOUND** anywhere in `backend/src` or `backend/docs` (re-checked 2026-10-05). `POST /installation/companies` has no limit check.
- **Counter semantics (VERIFIED by reading `LimitService.resolve`):** usage is a **counter incremented on `consume`**, not derived from rows. No profile ⇒ unlimited **and untracked**. A profile set later starts counting from 0, so existing usage is **not** reflected. There are **no callers of `release()`**, so deletions do not return quota. Lowering a cap below current usage only refuses new consumption; nothing is removed.
- Where limits live: Company limit counters/profiles are Company-DB entities; `check/consume/release` accept a Company `manager`; **`setProfile/clearProfile` have no manager parameter**. `/limits` reads and writes the **platform DB**; a platform cap has **no effect** on any Company, and every Company is unlimited (executed, WP-0.5b).
- The signed manifest carries a `limits` map; it is resolved into the installation entitlement and exposed by the entitlement endpoints, but **no `LimitService` reference to it was found** — manifest limits are not enforced. `edition_limits` exists with no consumer found.
- Latent authority (executed): the Company `admin` role holds `core.limit`; a Company admin is allowed `/limits` edit **if** the route ever had Company context.

**3. Existing-tree evidence (not ratified).** The Plans as-built code carries modules only — no limit, term or subscription field (grep empty). It adds nothing to DP-6.

**4. Dependencies.** DP-1 (a manifest-sourced ceiling needs the signed-artifact decision); DP-4 4-A (limit authority must be platform-owned and never editable by a Company admin — R14); DP-8 8-1 (On-Prem keeps working with manifest/profile limits and no Control Plane); Area 21 (Company-side reads already use the Company manager); DP-5 (downgrade/over-limit semantics).

**5. Conflicts / gaps / risks.**
- Live commercial exposure: unlimited Companies; no `users.max`/`companies.max`.
- Counter-vs-rows drift: any limit applied to an existing Company under-counts; a downgrade cannot rely on counters to know real usage.
- `/limits` + dormant `core.limit` grant (R14): a naive "make limits Company-aware" change would hand Company admins edit rights over their own commercial caps.
- Two scopes are conflated in the vocabulary: `companies.max` is installation-level (platform side); `users.max` would be Company-level — and "user" is undefined (global `users` rows vs `user_company_memberships` per Company).
- 22 declared keys give the *appearance* of limits that nothing enforces.

**6. Options (PROPOSED only).** **A** — push plan limits into each Company's `limit_profiles` at provisioning/upgrade, marked platform-owned. **B** — resolve a ceiling from the signed manifest `limits`; a local profile may only tighten. **C** — add platform-side enforcement for installation-level limits (`companies.max`) independent of A/B. A and B can be combined with C.
**Recommended bundle (PROPOSED):** C for `companies.max`; **B-shaped** ceiling for Company-level caps (consistent with the DP-1 signed-artifact direction), with a rule that a counter must be **reconciled from real rows** when a cap is first applied to an existing Company; limit authority platform-owned (DP-4).

**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No change to `LimitService`/`/limits`/Limit entities; no new route that exposes limit editing under Company context; no `users.max`/`companies.max` key without a ruling on what a "user" is; no implicit commercial-limit claim for the 22 unenforced keys.

**Questions for the CTO.** (a) Which keys are commercial (and are the 22 unenforced ones in or out)? (b) Define "user" for `users.max`. (c) Behavior at the cap and on downgrade below current usage (with DP-5). (d) Reconcile-from-rows policy when a cap is applied late.

---

## DP-5 — Subscription Lifecycle

**1. State.** OPEN. Conditional on DP-1, DP-4, DP-6; constrained by DP-9 and CD-1.

**2. Verified evidence.**
- No Subscription, Renewal, Trial or per-Company term exists. The only term concept is the **installation** manifest: `term_start/term_end/grace_days` → status `expired` when `now > term_end + grace` (`EntitlementService`). VERIFIED.
- Company lifecycle (DP-9): only `READY` grants access. Reachable transitions today: `READY→SUSPENDED`, `SUSPENDED→READY`, `SUSPENDED→DECOMMISSIONED`, provisioning→`READY`; `DEGRADED/MIGRATING/FAILED` are unreachable. CD-1 (executed): `reactivate` can set `READY` while the registry is `FAILED`; decommission removes nothing.
- Downgrade (executed, WP-0.5a): removing a module is a **data-retaining no-op** at database level; access removal is entitlement-only. Upgrade: adding a module to a live Company database **works** (existing data intact; role templates seedable); the runner does **not** enforce dependency closure.
- The Approval Engine's tables live in each **Company** database and the engine is on HOLD under Area 21, so it **cannot serve as a platform-level approver** for plan/subscription changes.

**3. Existing-tree evidence (not ratified).** Plans as-built has an assignment row (`company_plan_assignments`) with no term, status, renewal or approver; plan assignment forbids only `DECOMMISSIONED`.

**4. Dependencies.** DP-1 (what a plan change materializes), DP-4 4-A (who creates vs approves — needs a platform-level mechanism), DP-6 (limits above the new ceiling), DP-7 (billing seam), DP-9 + the Lifecycle Admission package (suspension effects on jobs), DP-8 (subscription is a SaaS-only optional capability; On-Prem keeps the manifest term).

**5. Conflicts / gaps / risks.**
- Two term mechanisms could coexist (installation manifest term vs SaaS subscription) — ownership undefined.
- Subscription state → Company status mapping must not create states DP-9 cannot enforce (non-READY must block).
- Downgrade semantics undefined: users, limits, in-flight workflows above the new ceiling; counters do not reflect real usage (DP-6).
- CD-1 makes "READY" untrustworthy until the lifecycle is unified.
- Renewal/expiry jobs must run per Company, carry `companyId`, re-check status, and may continue only as Control Plane operations (O-1).

**6. Proposed model (PROPOSED).** Subscription = its own entity, separate from Plan and from `Company.status`. State set to rule on: `TRIAL?` · `ACTIVE` · `GRACE` · `SUSPENDED` · `CANCELLED` · `EXPIRED`. Mapping to Company status: only `ACTIVE`/`GRACE`/`TRIAL?` ⇒ `READY`; others ⇒ non-READY (blocked per DP-9). Upgrade immediate vs period-end; downgrade = entitlement removal with data retention, caps re-evaluated per DP-6. Every transition audited and approved by a platform-level mechanism (not the Company Approval Engine).
**Recommended bundle (PROPOSED):** rule DP-6 first; define the platform-level approval mechanism under DP-4 implementation; take DP-5 after CD-1's unified lifecycle decision.

**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No Subscription entity/migration; no use of the Company Approval Engine for platform approvals; no state that bypasses DP-9; no new suspension path before the Lifecycle Admission package; no promise of upgrade/downgrade before its package is authorized.

**Questions for the CTO.** (a) Is there a Trial? (b) Who owns term when both manifest and subscription exist? (c) Downgrade-below-usage policy. (d) Upgrade timing. (e) Approval mechanism for platform changes.

---

## DP-7 — Billing Boundary (deferred scope)

**1. State.** OPEN — analysis only; billing is **not** in implementation scope.
**2. Verified evidence.** No billing, invoicing-of-subscription, payment, renewal or metering exists (content search). The repo's `Invoice`/`Payment` domain is **tenant customer finance** and must not be reused for SaaS billing without a ruling.
**3. Existing-tree evidence.** None (Plans has no commercial state).
**4. Dependencies.** DP-5 (subscription entity), DP-8 8-1 (billing must never be required on-prem), DP-4 (who records commercial facts).
**5. Risks.** Scope creep into a payment engine; coupling subscription state to payment; currency/tax leaking into the Subscription model; audit via the Event Engine while that engine is under review.
**6. Proposed seam only (PROPOSED).** Subscription carries `term_start/term_end/grace`, an operator-recorded `paid_through`, a free-text `commercial_reference` and an `external_billing_ref` slot; no code path assumes payment exists; every state change is an **audit record** (platform `AuditService`), not dependent on the Event Engine; currency/tax kept out.
**Recommended bundle (PROPOSED):** seam only, manual commercial state in phase 1.
**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No payment gateway, billing engine, invoice generation or metering; no reuse of tenant Invoice/Payment.
**Business decisions required:** manual vs electronic payment in phase 1; whether internal billing is needed at all.

---

## Batch B bundle and status (PROPOSED)

| Order | Package | Needs first | Authorization |
|---|---|---|---|
| 1 | DP-6 | DP-1 implementation direction, DP-4 | NOT AUTHORIZED |
| 2 | DP-5 | DP-6, CD-1 policy ✔, platform approval mechanism | NOT AUTHORIZED |
| 3 | DP-7 | DP-5 | NOT AUTHORIZED (seam only) |

---

## 3. Decision docket (current)

| Decision | State |
|---|---|
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL (Plans code NOT RATIFIED) |
| DP-2 | **DECIDED** — XNEXUS platform-level, not a Company |
| DP-3 | **DECIDED** — additive invitation (transport OPEN) |
| DP-4 | **DECIDED** — 4-A |
| DP-5 · DP-6 · DP-7 | **PENDING CTO REVIEW — this package** |
| DP-8 | **DECIDED** — 8-1 |
| DP-9 | **DECIDED** (implementation NOT AUTHORIZED) |
| CD-1 | **DECIDED — policy** (repair, recovery workflow, retention policy not authorized/not defined) |
| LA-1 Lifecycle Admission | PACKAGE DEFINED — specification required; implementation HOLD |
| Plans / Approval Engine / Event Engine work | NEEDS RE-PROOF — not ratified; Approval HOLD; never reverted |
| Area 21 | HOLD / independent gate |
| WP-0.4 | NOT MET |
| Production | HOLD |

Related documents (same folder): `BATCH-A-DECISION-PACKAGE-DP8-DP4-DP1.md` · `BATCH-C-DECISION-PACKAGE-DP3-DP2.md` · `DP-9-SUSPENSION-ENFORCEMENT-DECISION-RECORD.md` · `CD-1-ARCHITECTURE-RISK-DOCKET.md` · `LA-1-LIFECYCLE-ADMISSION-BOUNDARY-PACKAGE.md` · `WP-0.5-CHARACTERIZATION-RESULTS.md` · `WP-0.4-STABLE-SOURCE-EVIDENCE.md` · `SAAS-CONTROL-PLANE-MASTER-EXECUTION-BLUEPRINT.md`.
