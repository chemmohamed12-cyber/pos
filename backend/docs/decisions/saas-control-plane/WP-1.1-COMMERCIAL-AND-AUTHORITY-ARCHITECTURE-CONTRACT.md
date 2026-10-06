# WP-1.1 — Commercial & Authority Architecture Contract (DAII SaaS Control Plane)

**Status:** DOCUMENTED — **RECONCILED with the CTO's C-1…C-6 rulings (2026-10-05) — PROPOSED FOR CTO REVIEW.** A contract *compiled from CTO decisions*; it becomes binding only on ratification (**Architecture Baseline**). It contains **no new decision**: every normative rule cites its source; anything not decided is listed as **OPEN** (§6).
**Scope:** documentation/architecture only. **Not an authorization:** no code, migration, schema, guard or shared-engine change follows from it. Production: HOLD. Date: 2026-10-05.
**Precedence:** this contract sits **below** and does not override ADR-015/019/055/073/074, D1, D7 and Model B. A conflict with any of them is escalated, never resolved silently.
**Classification vocabulary:** DECIDED · OPEN · CONDITIONAL · VERIFIED (source read / executed) · NOT AUTHORIZED. States are never merged (VERIFIED ≠ DECIDED ≠ AUTHORIZED ≠ IMPLEMENTED ≠ REAL-PG/ISOLATION/REGRESSION VERIFIED).

---

## 1. The chain this contract governs

```text
Installation  (XNEXUS platform — platform-level, not a Company)         [DP-2, DP-8]
    ↓
Company       (lifecycle; READY is the only operational state)         [DP-9, CD-1, LA-1]
    ↓
Edition / Plan  (platform-owned authoring of what a Company may have)  [DP-1]
    ↓
Signed Runtime Entitlement  (per Company, explicit Company context)    [DP-1]
    ↓
Subscription  (SaaS commercial term and state)                         [DP-5, DP-7]
    ↓
Commercial Limits  (ceilings; cap blocks new consumption only)         [DP-6]
    ↓
Platform Authority   ≠   Company Operational Authority                 [DP-4, DP-3, R14]
```

Cross-cutting: On-Prem independence [DP-8, ADR-015 open] · Area 21 dependency [DP-1 condition] · Lifecycle Admission [LA-1] · Billing boundary [DP-7].

## 2. Invariants (hold for every layer)

| ID | Invariant | Source |
|---|---|---|
| I-1 | **Model B**: one database per Company; Membership in the platform DB; operational RBAC inside the Company DB; the JWT `companyId` is transport, never proof | Model B, ADR-073/074 |
| I-2 | **D1/D7**: provisioning and membership management never create a `User`; no `READY` Company without an administrator | D1, D7 |
| I-3 | Entitlement ≠ Permission ≠ Limit ≠ Configuration; hiding a UI element is not enforcement; the backend is the final authority | ADR-055 |
| I-4 | **Platform Authority ≠ Company Operational Authority**; no implicit escalation in either direction | DP-4 4-A |
| I-5 | **No ambient or default Company context**, anywhere | DP-1 |
| I-6 | Only `Company.status === READY` permits operational work; lifecycle status is **never cached** on the authorization path | DP-9 O-4/O-5 |
| I-7 | On-Prem never depends on the SaaS Control Plane; every SaaS capability is optional | DP-8 8-1 |
| I-8 | Existing code that predates a decision is never the decision; foreign work is evidence only | CTO rule |
| I-9 | Results are valid only for the exact hash-anchored source state they ran on | evidence discipline |

## 3. Layer contracts

### L1 — Installation / XNEXUS platform
- **Definition.** The single Installation is the platform host; XNEXUS is **platform-level**, **not** a DAII Company and **not** a tenant (**DECIDED, DP-2**). No artificial XNEXUS Company may be created to ease permissions or entitlement.
- **Authority & store.** Platform database; the installation singleton and signed installation manifest. `companies.max` is **installation-level** (**DECIDED, DP-6**).
- **Open.** Whether XNEXUS ever runs its own business in DAII (would be a separate installation/decision — not ruled).
- **Forbidden.** Representing XNEXUS as a Company.

### L2 — Company and lifecycle
- **States.** `PROVISIONING · READY · DEGRADED · SUSPENDED · MIGRATING · FAILED · DECOMMISSIONED`. Operational work only in `READY` (**DP-9 O-4**).
- **Enforcement (DP-9, LA-1).** Layer 1: `CompanyContextGuard` enforces READY on Company-scoped **HTTP** only; `selectCompany` rejects any non-READY Company; `refresh` does not return the Company claim; an already-issued JWT is blocked immediately because status is read on every request; HTTP **409 `COMPANY_NOT_READY`**; no internal infrastructure state or other-Company data in the response; front-end stops, drops the Company from local context, returns to the Company Selector with an Arabic "Company unavailable" message and **never auto-retries**. Layer 2: every service/scheduler/worker/infrastructure path that opens a Company DataSource passes a **Company lifecycle admission** appropriate to it; Backup/DR is governed by its **own explicit independent policy**, not a bypass.
- **Jobs (O-1).** Backup/DR/platform housekeeping continue; operational jobs stop when the Company is not READY; subscription/entitlement expiry sweeps may continue as **Control Plane** operations but never bypass the operational block; each job carries an explicit `companyId` and **re-checks status before executing**; one Company's failure never affects another.
- **Integrity (CD-1, DECIDED policy).** `PROVISIONING`+registry `FAILED` is **not READY**; `reactivate` is not a recovery mechanism; a failed-provisioning Company needs a **separate Recovery/Re-provisioning workflow**; `READY`+registry `FAILED` is never an acceptable operational state; `DECOMMISSIONED` = no operation but **≠ DELETE** — retention/destruction belongs to a separate **Lifecycle Retention Policy**; **no destructive deletion or teardown is authorized**.
- **Platform access (O-3).** Platform administration routes stay available under their own permissions; **no implicit override**, **no Support read-only bypass in V1**; any exception needs its own decision (permissions, audit, scope).
- **Open.** LA-1 specification (callers, operational classification, exceptions, status/DataSource race, scheduled work after suspension, Backup separation); the Recovery/Re-provisioning workflow; the Lifecycle Retention Policy.
- **Forbidden.** A shared READY assertion as an implementation; widening `CompanyContextGuard` beyond Layer 1; making a registry status a lifecycle authority (DP-9 D-7).

### L3 — Edition / Plan
- **Definition.** Platform-owned authoring of which modules a Company may use (direction of **DP-1**).
- **Status.** The concrete catalog model is **not decided**. The Plans code in the shared tree is **FOREIGN — NEEDS RE-PROOF — NOT RATIFIED**; it is evidence for the DP-1 gap analysis (Batch A §4), not a baseline.
- **Open.** Catalog shape; whether to reuse the existing `editions*` tables.

### L4 — Signed Runtime Entitlement (per Company)
- **Decided.** Per-Company entitlement resolution using an **explicit Company context** (the validated `companyContext.companyId`, never the raw JWT claim); the Company entitlement runtime artifact **stays in the signed authority chain**; **signing authority is platform-controlled** — Company Admin and the Company DB never hold signing authority; **cache permitted** only if keyed by `companyId`, with **reliable invalidation** (C-2), bounded TTL, no ambient Company, and **never mixed with lifecycle status**; the cache may not produce stale entitlement.
- **Conditional (DP-1).** Architecture is DECIDED IN PRINCIPLE / CONDITIONAL on **Area 21** and the implementation gates. Entitlement enforcement **may not be claimed complete** while 16 module-guarded controllers lack Company context — VERIFIED: exactly the 16 remaining Area 21 controllers (`accounting ap ar attendance cash-bank commission fixed-asset hr inventory-accounting invoices payroll returns rfq sales supplier target`); 27 of 43 are enforceable today.
- **Observation (VERIFIED; not a rule) — entitlement ≠ permission (I-3).** Excluding a module from a package does not remove its permission nodes: every Company `admin` holds every module root (executed, WP-0.5c). Whether and how readiness claims must state this is not decided.
- **Open.** Artifact shape/format; the TTL value and cross-process invalidation; behavior of a Company with no artifact; the interim rule for routes without Company context (as-built: installation-wide check — evidence only).
- **Forbidden.** Default/ambient Company; Company-side signing; converting the gap into platform privileges.

### L5 — Subscription
- **Decided (DP-5).** The SaaS Subscription owns the SaaS commercial term; On-Prem keeps the manifest term. Trial optional (not mandatory in V1). `ACTIVE`/`GRACE`/`TRIAL` ⇒ `READY`; `SUSPENDED`/`CANCELLED`/`EXPIRED` ⇒ non-READY. **Upgrade immediate; downgrade at period-end.** Downgrade never deletes data; usage above the new ceiling is retained and new consumption refused. Subscription changes require **platform-level approval / dual control**; the Company Approval Engine may not serve as a platform approver while on HOLD. **Implementation depends on DP-4 Platform Roles being implemented first (C-4).**
- **Open.** Subscription entity shape; renewal/grace durations; who the approver/dual-control actors are (DP-4 role set); the mechanism itself.
- **Forbidden.** A subscription state that bypasses DP-9; a second term mechanism for On-Prem.

### L6 — Commercial Limits
- **Decided (DP-6).** Only enforced or explicitly approved keys are commercial (the 22 declared-but-unenforced keys are **not** marketed as commercial); `users.max` = **Company membership seats**, consumed at **invitation acceptance**, and (C-1) it **governs creation of the effective Membership on every path** — invitation or D1/direct grant; `companies.max` installation-level; Company-level ceilings come from the **signed runtime artifact**; a local profile may **only tighten**; reaching a cap blocks **new consumption only**; applying a limit to an existing Company requires **reconciling from real persisted rows before the counter starts**.
- **Verified facts it must respect.** Usage is a counter, not derived from rows; no profile ⇒ untracked; no `release()` callers; `/limits` writes the platform DB only; manifest `limits` are not enforced today.
- **Open.** Key list; seat-check mechanics (C-1 is ruled); counter model after reconciliation.
- **Forbidden.** Exposing limit editing under Company context (R14); destroying data at a cap.

### L7 — Platform Authority
- **Decided (DP-4 4-A, DP-3).** Platform DB → identity, membership, control-plane concerns. Platform Admin never becomes a Company Super Admin automatically; any Support/Platform access to Company operations is **explicit, monitored, scope-limited**. Invitation (DP-3): additive over D1; never creates a Platform Admin; creates/links a **Company membership** in one Company; permissions from Company RBAC, not the invitation; inviter never sends a password; **one-time, expirable, auditable, Company-bound**; reuse of `pending` allowed if it fits; V1 transport-independent with **out-of-band** delivery, **invitee creates their own credential**; no Email/WhatsApp/SMS/Notification Engine without a separate decision.
- **Open.** Platform role set, store and separation-of-duties rules; key-custody ownership; the Support-access mechanism; whether an invitation may carry a requested role key.
- **Forbidden.** Implicit escalation; routes that gain Company context while checking `core.*`/`system.*` nodes without review (R14).

### L8 — Company Operational Authority
- **Decided.** Operational roles/permissions live in the Company DB (Model B). Company administrators hold **no** platform authority and **no** signing authority (DP-4, DP-1). (Their ability to manage memberships within Company RBAC is existing behavior, recorded here as a fact — not a new rule.)
- **Latent authority (R14, VERIFIED/executed).** Every Company `admin` already holds `core.limit.edit`, `core.entitlement`, `core.config`, `system.release` and every module root from the core migrations — inert only because the routes that check them have no Company context. **Rule:** no route may gain Company context while checking such a node, and the limits architecture may not evolve, without first reviewing those nodes against the Company `admin` grants.
- **Open.** Treatment of the dormant grants (a work package, not yet defined).

### Cross-cutting
- **Billing (DP-7).** Seam only: no billing engine, gateway, SaaS invoice engine; no reuse of tenant `Invoice`/`Payment`; phase 1 = operator-recorded `paid_through`, `commercial_reference`, `external_billing_ref`. Internal billing is not a current architectural requirement.
- **On-Prem (DP-8).** Independent of the Control Plane; Control Plane / Subscription / Plan Catalog are optional; same Core architecture (deployment difference, not a fork). **ADR-015 (commercial licensing of On-Prem) is an OPEN business decision** and may not be settled by implementation or assumption.

## 4. Normative rules (compiled; each traceable)

| # | Rule | Source |
|---|---|---|
| N-01 | Operational work requires `Company.status === READY` | DP-9 O-4 |
| N-02 | For Company-scoped **HTTP** operations the enforcement point is `CompanyContextGuard` | DP-9 D-3 |
| N-03 | `selectCompany` MUST reject non-READY Companies | DP-9 D-4 |
| N-04 | `refresh` MUST NOT return the Company claim for a non-READY Company | DP-9 D-6 |
| N-05 | Status is read on every request; no cache of lifecycle status | DP-9 D-5, O-5 |
| N-06 | Non-READY ⇒ HTTP 409 `COMPANY_NOT_READY`, no internal detail | DP-9 O-2 |
| N-07 | Non-HTTP paths opening a Company DataSource MUST pass lifecycle admission | LA-1 |
| N-08 | Backup/DR continues under its own explicit policy, not a bypass | O-1, LA-1 |
| N-09 | Jobs carry `companyId` and re-check status before executing | O-1 |
| N-10 | No Platform/Support bypass of N-01 in V1 | O-3 |
| N-11 | Registry status MUST NOT be a lifecycle authority | DP-9 D-7 |
| N-12 | `PROVISIONING`+registry `FAILED` is never READY; `reactivate` is not recovery | CD-1 |
| N-13 | `DECOMMISSIONED` blocks operation; it does not authorize deletion | CD-1 |
| N-14 | No Company context is ever defaulted or ambient | DP-1, I-5 |
| N-15 | Entitlement resolution uses the validated Company context, never a raw claim | DP-1 |
| N-16 | The Company runtime entitlement artifact stays in the signed chain; signing is platform-controlled | DP-1 |
| N-17 | Entitlement cache: keyed by `companyId`, **reliable** explicit invalidation, bounded TTL; never mixed with lifecycle status; **a cache may not produce stale entitlement and is permitted only with reliable invalidation** | DP-1, **C-2 ruling** |
| N-18 | Per-Company enforcement may not be claimed complete until the 16 controllers have Company context | DP-1 condition |
| N-19 | Subscription states map to READY only for `ACTIVE`/`GRACE`/`TRIAL` | DP-5 |
| N-20 | Upgrade is **immediate** (no stale entitlement may delay it); downgrade is at period-end; downgrade deletes nothing | DP-5, **C-2 ruling** |
| N-21 | Platform-level approval/dual control for subscription changes; Company Approval Engine excluded; **implementation depends on DP-4 Platform Roles being implemented first** | DP-5, **C-4 ruling** |
| N-22 | SaaS term is owned by the Subscription; On-Prem term by the manifest | DP-5, DP-8 |
| N-23 | Only enforced/approved keys are commercial | DP-6 |
| N-24 | `users.max` = Company membership seats and **governs creation of the effective Membership on every path** — invitation (at acceptance) **and** D1/direct grant | DP-6, **C-1 ruling** |
| N-25 | `companies.max` is installation-level | DP-6 |
| N-26 | Company ceilings come from the signed artifact (the commercial ceiling); local profiles tighten only; **enforcement requires an independent, later Work Package** | DP-6, **C-3 ruling** |
| N-27 | A cap blocks new consumption only; no deletion | DP-6 |
| N-28 | Reconcile from real rows before a counter starts on an existing Company | DP-6 |
| N-29 | No billing engine/gateway/SaaS invoice engine; no tenant Invoice/Payment reuse | DP-7 |
| N-30 | Platform authority ≠ Company authority; no implicit escalation | DP-4 |
| N-31 | Support/Platform access to Company operations is explicit, monitored, scope-limited | DP-4 |
| N-32 | Invitations are additive over D1, one-time, expirable, auditable, Company-bound, no inviter password, no Platform Admin creation | DP-3 |
| N-33 | V1 invitation delivery is out-of-band; no Email/WhatsApp/SMS/Notification Engine without a new decision | DP-3 |
| N-34 | XNEXUS is platform-level, not a Company | DP-2 |
| N-35 | On-Prem never requires the Control Plane; ADR-015 is not settled by implementation | DP-8 |
| N-36 | No route gains Company context while checking `core.*`/`system.*` nodes without reviewing Company admin grants | R14 |
| N-37 | **Every Control Plane transition (subscription, plan assignment, lifecycle, invitation) is auditable; the audit mechanism must not rely on the unproven Event Engine** | **C-5 ruling** |

## 5. CTO Reconciliation Rulings C-1 … C-6 (2026-10-05) — architecture resolved; implementation NOT AUTHORIZED

These were raised as findings (interactions between earlier rulings) and are now **resolved at architecture level**. Residual items are listed; nothing beyond the rulings is added.

| ID | CTO ruling (as issued) | Contract effect | Residual / what stays open |
|---|---|---|---|
| **C-1** | `users.max` governs creation of the **effective Membership**, whether by **Invitation** or by **D1 / direct grant** | N-24 revised: one seat rule across every membership-creation path; the cap cannot be bypassed through the direct-grant path | Mechanics of the shared check and reconciliation of existing memberships (DP-6 "reconcile from real rows") belong to the DP-6 implementation package |
| **C-2** | **Upgrade must be immediate.** The cache may not produce stale entitlement and is allowed **only with reliable invalidation** | N-17 and N-20 revised; DP-1's bounded-TTL requirement is unchanged and C-2 adds that stale entitlement may not be served and a cache requires reliable invalidation — how these combine is part of the OPEN mechanism | **Invalidation mechanism and scope** (including across processes) is **not specified** — it must be defined in the WP-4.2 specification and proved (V-14, V-14a); until then no cache is authorized |
| **C-3** | The **signed artifact is the commercial ceiling**; **enforcement needs an independent later Work Package** | N-26 revised; no ceiling enforcement is bundled into any other package | The enforcement WP touches a shared engine and is gated by WP-0.4 (per §10); any Area 21 dependency is for that WP's specification to determine |
| **C-4** | **Platform Approval / Dual Control depends on DP-4 Platform Roles** before implementation | N-21 revised; sequencing fixed: DP-4 implementation → platform approval mechanism → DP-5 transitions | The platform role set and the approval mechanism design (DP-4 implementation package) |
| **C-5** | **Control Plane transitions must be auditable**; do **not** rely on the unproven Event Engine | N-37 added | Concrete audit mechanism is chosen in the implementation package; platform audit records are the working assumption, **not** a decision |
| **C-6** | **Invitee self-credential needs an independent Work Package after WP-0.4** | Sequencing fixed; no invitation/credential code in any other package | The WP itself (identity flow beside the auth engine; re-proof) |

## 6. Open-items register

| Item | Layer | Owner of the decision | Blocks |
|---|---|---|---|
| ADR-015 on-prem licensing | DP-8 | CTO (business) | nothing technical; may not be assumed |
| LA-1 specification | L2 | CTO / architecture | WP-4.1 Layer 2 |
| Recovery/Re-provisioning workflow | L2 | CTO / architecture | P3 failure handling |
| Lifecycle Retention Policy | L2 | CTO (business/legal) | decommission handling |
| Signed artifact shape; TTL value; **invalidation mechanism and scope (C-2)**; no-artifact behavior | L4 | CTO / architecture | WP-4.2 |
| Plan catalog model; reuse of `editions*` | L3 | CTO / architecture | WP-2.2 |
| Subscription entity, durations, approvers | L5 | CTO | WP-5.x |
| Commercial key list; seat-check mechanics and reconciliation of existing memberships (C-1 resolved at architecture level) | L6 | CTO / architecture | WP-3.3 / WP-4.3 |
| Platform approval / dual-control **mechanism** (C-4 ruled: after DP-4 roles) | L5/L7 | CTO / architecture | WP-5.1 |
| Control Plane **audit mechanism** (C-5 ruled: auditable, no Event Engine reliance; platform audit records = working assumption only) | L5/L7 | CTO / architecture | WP-2.3 |
| Platform role set, store, Support-access mechanism, key custody ownership | L7 | CTO | WP-2.1 |
| Dormant Company-admin grants (R14) | L8 | CTO | any route gaining Company context |
| Whether an invitation carries a role key | L7 | CTO | DP-3 implementation |
| DP-3 invitation **delivery details** — token format, expiry value, rate limiting, audit record contents (the V1 transport itself is decided: out-of-band) | L7 | CTO / architecture | DP-3 implementation |

## 7. Foreign work and evidence status (never a baseline)
Plans / Company packages / per-Company entitlement resolver (incl. changes to `RequireModuleGuard`/`RequireFeatureGuard`) · Event Engine work · Approval Engine retrofit (HOLD) · any unattributed change = **NEEDS RE-PROOF**; no revert, overwrite, ratify-by-assumption, baseline use, or use as architectural evidence. WP-0.4 stable source: **NOT MET**. WP-0.5 results are valid only for the anchored state (`ba5a16be…044f1`).

## 8. What this contract does not authorize
Any code, migration, schema or guard change; WP-4.1 / WP-4.2 / WP-4.3 on the shared tree; any change in Subscription, `LimitService`, `/limits`, Plans, `EntitlementService`, `RequireModuleGuard`, `RequireFeatureGuard`, Auth shared engines, `CompanyContextGuard`, lifecycle state, registry, Approval Engine or Event Engine; production readiness claims. Next: the CTO reviews this contract with WP-1.2 (`WP-1.2-VERIFICATION-AND-ACCEPTANCE-PLAN.md`) before any Work-Package Authorization.

## 9. Change control (PROPOSED process — for CTO confirmation)
Changes to this contract would be made only by a recorded CTO decision; the contract is re-issued with the changed rule's source, and affected acceptance criteria in WP-1.2 are updated in the same change.

## 10. Dependency and gating matrix (documentation; no Work Package is authorized by it)

**Reading rule (final):** **Meeting a dependency or a gate does NOT constitute authorization to implement the dependent work package.** Dependency ≠ Authorization; Gate satisfied ≠ Implementation approval. Every row requires its own explicit Work-Package Authorization. The work-package identifiers in this matrix are catalog/organization references only, not CTO-issued authorizations. "Must precede" entries are proposed dependencies derived from the rulings, whether or not marked *(derived)*, **except** those a ruling states explicitly: DP-1 architecture → Plans gap analysis → authorization; C-4 (platform approval only after DP-4 Platform Roles); C-6 (invitee credential after WP-0.4); the CD-1 Recovery/Re-provisioning workflow package; and the LA-1 specification package. **These exceptions must not be generalized to any other row.**

Gates: **G-0.4** = WP-0.4 stable source (NOT MET) · **G-A21** = Area 21 independent gate · **G-LA1** = LA-1 specification · **G-DP4** = DP-4 Platform Roles implemented · **G-OPEN** = open decision in §6.

| Work package (Blueprint) | Contract sections / rules | Must precede it | Gates | Touches shared engine? |
|---|---|---|---|---|
| WP-2.1 Platform identity & roles | L7; N-30/31 | — | G-0.4 | yes (platform roles / guards) |
| WP-2.2 Plan catalog | L3 | DP-1 gap analysis; G-OPEN (catalog model) | G-0.4 | no (new tables); foreign Plans code is evidence only |
| WP-2.3 Control Plane transition auditing | L5/L7; N-37 | WP-2.1 *(derived)* | G-0.4 | audit mechanism **OPEN** (C-5 working assumption: platform audit records) |
| WP-3.1/3.2 Plan → provisioning; failure handling | L2/L3; N-12 | WP-2.2; Recovery workflow (OPEN) | G-0.4 | provisioning inputs |
| WP-3.3 Per-Company limit seeding / reconciliation | L6; N-24/27/28 | DP-6 package; C-1 mechanics | G-0.4 | `LimitService` consumers |
| WP-4.1 DP-9 Layer 1 | N-01…N-06 | — | G-0.4 | **yes** (`CompanyContextGuard`, `AuthService`) |
| LA-1 (Layer 2 admission) | N-07…N-10 | LA-1 specification | G-LA1, G-0.4 | yes (connection paths, schedulers) |
| WP-4.2 Per-Company entitlement | L4; N-14…N-18 | DP-1 gap analysis; invalidation spec (C-2); signing custody (DP-4) | G-0.4, **G-A21** (16 controllers), G-DP4 | **yes** (`RequireModuleGuard`, `EntitlementService`) |
| WP-4.3 Limit-ceiling enforcement (**independent WP — C-3**) | L6; N-26 | WP-4.2 artifact; DP-6 | G-0.4 | **yes** (`LimitService`) |
| WP-5.1 Subscription entity/lifecycle | L5; N-19…N-22 | DP-6, WP-2.1, **platform approval (C-4)**, CD-1 policy | G-DP4, G-0.4 | no (new component) |
| WP-5.2 Upgrade/downgrade | N-20 | WP-4.2 *(derived from C-2)* | G-0.4 | provisioning/module lifecycle |
| WP-5.3 Invitation & **invitee credential (C-6)** | L7; N-24/32/33 | WP-2.1; DP-3 design | **G-0.4** (explicitly after) | **yes** (identity flow beside the auth engine) |
| WP-5.4 Renewal/expiry per Company | L5; N-09 | WP-5.1; LA-1 | G-LA1 | schedulers |
| P6 Acceptance | all | all above | all | — |

**Standing blocks for every row:** foreign work (Plans, Approval Engine, Event Engine) is NEEDS RE-PROOF and is not a baseline; Approval Engine HOLD; no use of the Company Approval Engine for platform approval.
