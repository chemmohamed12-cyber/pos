# Final Closure Package — Control Plane / Architecture Baseline

**Date:** 2026-10-05 · Lane A, documentation only.
**CTO status:** **ARCHITECTURE BASELINE — ISSUED.** Current gate: **WP-0.4**. Implementation: HOLD until authorized. Production: HOLD.
*(This file was deleted at the CTO's request in an earlier turn and recreated here because the Phase Closure order requires it; it is the Final Closure Package of record.)*

## 1. Pinned baseline (taken as-is; not edited in this pass)

Pinned by content hash (first 16 hex of sha256) at the time of issuance. The headers of WP-1.1 and WP-1.2 still read "PROPOSED FOR CTO REVIEW" because they were pinned unedited; **their baseline status is recorded here and in the Docket, not in their text.**

| Document | sha256 (16) |
|---|---|
| WP-1.1 Architecture Contract | `49596933303d3003` |
| WP-1.2 Verification & Acceptance Plan | `a22947b7db202688` |
| Master Execution Blueprint | `8880fc3fd625ec3a` |
| DP-9 Decision Record | `45d7aae3a7d465f6` |
| Batch A v2 | `1dcdd8b724481d12` |
| Batch B (consolidated) | `8383760ae5f7b9f9` |
| Batch C | `1425805ef79fcc1c` |
| CD-1 | `aa1636fe707c5389` |
| LA-1 | `312802a0cdd13c2d` |

Test-evidence anchor (WP-0.5, valid only for its anchored state): `ba5a16be…044f1`.

## 2. What the Baseline means
The decisions, constraints and rules in the package above are the architecture reference for the next phase. It is **not** an implementation, migration, shared-engine or production authorization.

## 3. Verification

| Item | Result |
|---|---|
| WP-1.1 | verified (pinned) — N-01…N-37 with sources; C-1…C-6 as ruled; open-items register complete |
| WP-1.2 | verified (pinned) — V-01…V-34 (+V-09a, V-14a) = 36 PROPOSED scenarios, none states an execution result |
| Blueprint | verified (pinned) |
| Docket | verified — final states in §4 |
| Dependency Matrix | verified — **Dependency ≠ Authorization; Gate ≠ Implementation Approval**; IDs are catalog references; exceptions limited to DP-1 gap analysis, C-4, C-6, the CD-1 recovery package and the LA-1 specification, not generalizable |
| Traceability | verified — CTO Ruling → Rule → Scenario → Work Package |

## 4. Docket (final)

| Decision | State |
|---|---|
| DP-9 · DP-8 · DP-4 · DP-6 · DP-5 · DP-7 · DP-3 · DP-2 · CD-1 · LA-1 | DECIDED per the package (implementation NOT AUTHORIZED; LA-1 specification required) |
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL |
| C-1 … C-6 | part of the Architecture Baseline |
| **OPEN BY DESIGN** (not to be closed by inference) | cache invalidation mechanism/scope · C-4 approval/dual-control mechanism · C-5 audit mechanism (platform audit records = working assumption only) · DP-1 signed-artifact details / key custody · LA-1 detailed specification · DP-3 delivery details · Recovery/Re-provisioning workflow · Lifecycle Retention Policy · ADR-015 on-prem licensing |

## 5. Status

```text
Architecture Baseline: ISSUED
WP-0.4: NOT MET
Implementation Authorization: NONE
Foreign Work: NEEDS RE-PROOF / UNRATIFIED
Production: HOLD
```

WP-0.4 is a hard gate for any implementation touching shared authentication, entitlement or guard engines, cross-company infrastructure, or Area 21-sensitive paths.


---

# DAII SaaS Control Plane — Complete Decision Package (Architecture Baseline ISSUED)

## Contents
1. WP-1.1 — Commercial & Authority Architecture Contract (baseline, pinned)
2. WP-1.2 — Data model, Verification & Acceptance Plan (baseline, pinned)
3. DP-9 — Suspension Enforcement: Decision Record
4. Batch A v2 — DP-8 / DP-4 / DP-1
5. Batch B — DP-6 / DP-5 / DP-7
6. Batch C — DP-3 / DP-2
7. CD-1 — Lifecycle State Integrity
8. LA-1 — Lifecycle Admission Boundary
9. WP-0.5 — Characterization results
10. WP-0.4 — Stable-source evidence (NOT MET)
11. Master Execution Blueprint (baseline, pinned)
12. Decision Dossier (historical)


---

# PART 1 — WP-1.1 — Commercial & Authority Architecture Contract (baseline, pinned)

*(source: `WP-1.1-COMMERCIAL-AND-AUTHORITY-ARCHITECTURE-CONTRACT.md`)*

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


---

# PART 2 — WP-1.2 — Data model, Verification & Acceptance Plan (baseline, pinned)

*(source: `WP-1.2-VERIFICATION-AND-ACCEPTANCE-PLAN.md`)*

# WP-1.2 — Conceptual Data Model, Verification Plan & Acceptance Criteria

**Status:** DOCUMENTED — **RECONCILED with the CTO's C-1…C-6 rulings — PROPOSED FOR CTO REVIEW**, together with `WP-1.1-COMMERCIAL-AND-AUTHORITY-ARCHITECTURE-CONTRACT.md` (rules N-01…N-37; reconciliation rulings in its §5; dependency matrix in its §10).
**Nature:** planning only. **No DDL, no migration, no code, no test is created by this document.** It states what *would* have to be proved, so any later Work-Package Authorization can reference exact criteria. Production: HOLD. Date: 2026-10-05.

## 1. Evidence and environment rules (apply to every criterion)

| # | Rule | Source |
|---|---|---|
| E-1 | Tests run on the **isolated PostgreSQL instance** (`127.0.0.1:5544`) with disposable `daii_test_*` databases; **never** the shared dev server/`daii_dev`; credentials never echoed | CTO ruling; `ISOLATED_TEST_ENVIRONMENT.md` (another workstream's doc; rule of record to be confirmed) |
| E-2 | Runs are **anchored to an exact source hash**: sha256 over `src/**` **and `dist/database/migrations/**`** (the migration runner loads compiled files), recorded at start and end; executed from a **pinned snapshot copy** whenever the live tree is being written by other workstreams | WP-0.4/0.5 lessons |
| E-3 | Evidence is valid **only for its anchored state**; it is never carried to a changed tree; a changed dependency invalidates it | evidence discipline |
| E-4 | Every failure is classified — genuine regression · test pollution · teardown race · infrastructure · concurrent foreign change — and none is buried under "passes alone" | CTO |
| E-5 | Disposable databases dropped; **zero residue verified** after each run | WP-0.5 practice |
| E-6 | Full regression runs only on the isolated instance, from a hash-anchored source, never uncontrolled against the dev database | CTO ruling |
| E-7 | Foreign work (Plans, Approval Engine, Event Engine) is **not** counted as evidence for any criterion until re-proved | CTO |
| E-8 | Labels are never merged: VERIFIED · DECIDED · AUTHORIZED · IMPLEMENTED · REAL-PG · ISOLATION · REGRESSION VERIFIED | CTO |

## 2. Conceptual data model (entities and ownership — no schema)

Notation: **[P]** platform database · **[C]** Company database. Items marked ◇ depend on an OPEN decision and are placeholders only.

| Entity | Home | Purpose | Key relations / invariants | Contract |
|---|---|---|---|---|
| Installation | [P] | the platform host; signed installation manifest | one row; ceiling for everything below | L1, DP-2/8 |
| Company | [P] | registry + lifecycle status | one per tenant; `READY` is the only operational status; no XNEXUS Company | L2, N-01, N-34 |
| DatabaseRegistry / Credential | [P] | connection target and secret for a Company DB | infrastructure health only; **not** a lifecycle authority | N-11 |
| Membership | [P] | User ↔ Company link (`user_company_memberships`) | counts as a **seat**; unique (user, company) | L7, N-24 |
| User / Credential | [P] | global identity | never created by provisioning/membership management (D1) | I-2 |
| Invitation ◇ | [P] | additive onboarding record | bound to **one** Company; one-time, expirable, auditable; no password; no Platform Admin; may use `pending`; role-key carry ◇ | L7, N-32/33 |
| Plan / Edition ◇ | [P] | platform-owned authoring of modules | catalog shape not decided; reuse of `editions*` ◇ | L3 |
| Company Entitlement Artifact ◇ | [P] authority, signed; cached per Company | what one Company may use | signed chain; platform-controlled signing; keyed by `companyId`; shape/TTL ◇ | L4, N-14…18 |
| Subscription ◇ | [P] | SaaS commercial term/state per Company | separate from Plan and from `Company.status`; states ACTIVE/GRACE/TRIAL/SUSPENDED/CANCELLED/EXPIRED; commercial facts `paid_through`, `commercial_reference`, `external_billing_ref` | L5, DP-7 |
| Commercial Limit ceiling ◇ | in the signed artifact; installation-level `companies.max` in [P] | cap on consumption | local profile tightens only; reconcile from rows before counting | L6, N-23…28 |
| Limit profile / usage counter | [C] (existing) | per-Company counters | counters are **not** derived from rows today (VERIFIED) | L6 |
| Platform roles ◇ | [P] | platform authority | separate axis from Company RBAC; set/store ◇ | L7, DP-4 |
| Company roles / permissions | [C] (existing) | operational authority | holds latent platform-style nodes today (R14, VERIFIED) | L8 |
| Control Plane audit record ◇ | mechanism OPEN (working assumption: platform audit records in [P]) | every Control Plane transition | auditable without the Event Engine (C-5); the concrete mechanism is **not decided** | N-37, C-5 |
| Approval (platform level) ◇ | [P] ◇ | dual control for subscription/plan changes | **not** the Company Approval Engine | N-21, C-4 |

**Cross-entity invariants to be provable:** (i) a Company with status ≠ READY exposes no operational path (N-01); (ii) the sum of memberships equals consumed seats after reconciliation (C-1); (iii) the artifact a request resolves is the one for the **validated** Company (N-15); (iv) no row of one Company is reachable through another Company's context (Model B).

## 3. Acceptance criteria per phase (exit gates; all REAL-PG on the isolated instance, source-anchored)

*All criteria and scenarios in this plan are **PROPOSED** for CTO ratification; none is a decision or an authorization.*

| Phase | Acceptance criteria (all required) |
|---|---|
| **P1** (this plan) | Contract ratified; open-items register triaged; this plan ratified; C-1…C-6 ruled; no open DP |
| **P2 Control Plane foundation** | Platform-role separation proved (a platform operator has no Company authority and vice-versa); Plan catalog CRUD proved; every Control Plane change auditable (mechanism per the C-5 implementation package); no change to shared engines without WP authorization |
| **P3 Provisioning** | Provisioning accepts a plan and yields the plan's module set; failed provisioning leaves a non-READY state that cannot be forced READY; a defined recovery path exists; ≥2 plans with different module sets proved; per-Company limit seeding reconciled from rows |
| **P4 Runtime enforcement** | DP-9 Layer 1 behavior proved (below); LA-1 admission proved for every path in its inventory; entitlement resolved per validated Company; cache rules proved **including reliable invalidation and immediate upgrade (C-2)**; limit-ceiling enforcement proved **as its own independent package (C-3)**; **re-proof of every guard-dependent controller**; Area 21 condition stated honestly (27/43 until the 16 are retrofitted) |
| **P5 Customer lifecycle** | Subscription states map to READY exactly as ruled; upgrade immediate / downgrade period-end proved; no data deleted on downgrade; **platform approval/dual control proved only after DP-4 Platform Roles exist (C-4)**; invitation flow and **invitee self-credential (own package after WP-0.4, C-6)** proved; **`users.max` governs the effective Membership on every path (C-1)**; every Control Plane transition audited without the Event Engine (C-5) |
| **P6 Release readiness** | Cross-Company adversarial matrix passes including commercial states; On-Prem runs with the Control Plane absent; rollback verified; regression green on a hash-anchored source; **then** a separate release authorization (production HOLD until issued) |

## 4. Verification matrix (what must be proved; traceable to the contract)

Type: **RP** = real-Postgres; **ISO** = two-Company isolation; **UNIT** = isolated unit; **UI** = front-end test; **REG** = regression.

| ID | Rule(s) | Scenario | Expected result | Type |
|---|---|---|---|---|
| V-01 | N-01/N-02/N-06 | Member of a SUSPENDED (and each other non-READY) Company calls a Company-scoped route | **409 `COMPANY_NOT_READY`**; no Company-DB operation; response leaks no infrastructure state or other-Company data | RP + ISO |
| V-02 | N-03 | `selectCompany` for a non-READY Company | rejected | RP |
| V-03 | N-04 | `refresh` after the Company stops being READY | token has no Company claim | RP |
| V-04 | N-05 | Company flips to SUSPENDED between two requests with the same JWT | the **second** request is blocked immediately; no stale-status window | RP |
| V-05 | N-07/N-09 | Operational scheduler for a Company that became SUSPENDED after scheduling | refuses to execute; other Companies' jobs unaffected | RP + ISO |
| V-06 | N-08 | Baseline backup for a SUSPENDED Company | continues under its explicit policy | RP |
| V-07 | N-10 | Platform admin calls an operational route of a SUSPENDED Company | blocked (no implicit override); platform routes still work | RP |
| V-08 | N-07 | Race: status flips between the admission check and DataSource acquisition | outcome follows the LA-1 specification (no operational write after the flip) | RP (concurrency) |
| V-09 | N-12 | Failed provisioning, then `reactivate` | Company never becomes operationally READY with registry FAILED | RP |
| V-09a | N-11 | Registry marked non-ACTIVE while `Company.status` is READY | operational access is refused as infrastructure protection, but **no lifecycle decision is derived from the registry value** — lifecycle authority is `Company.status` alone | RP |
| V-10 | N-12 | Recovery/Re-provisioning workflow (when defined) | failed Company reaches READY only through it | RP |
| V-11 | N-13 | Decommission | no operation possible; no deletion/teardown occurs | RP |
| V-12 | N-14/N-15 | Route with no validated Company context | no per-Company claim is made; no default Company chosen | RP + UNIT |
| V-13 | N-15/N-16 | Entitlement resolved for Company A vs B with different artifacts | each gets its own; forged/unsigned artifact rejected; Company admin cannot sign | RP + ISO |
| V-14 | N-17 | Cache: keyed by `companyId`; reliable invalidation on change; bounded TTL; entitlement cache never consulted for lifecycle status | no stale entitlement is ever served; a stale entry never serves another Company | RP + UNIT |
| V-14a | N-17/N-20, C-2 | **Upgrade with the cache populated**, entitlement read from every process that can serve the Company | the upgraded entitlement is effective **immediately** everywhere; the test fails if any process serves the old value after the change (mechanism per the WP-4.2 spec) | RP (multi-process) |
| V-15 | N-18 | Coverage statement | the generated coverage claim equals the verified 27/16 split until Area 21 closes | doc + RP |
| V-16 | N-19 | Each subscription state | READY only for ACTIVE/GRACE/TRIAL | RP |
| V-17 | N-20 | Upgrade; downgrade | upgrade effective at once; downgrade at period-end; **no rows deleted**; usage above the new ceiling readable, new consumption refused | RP |
| V-18 | N-21, C-4 | Subscription change by one operator | requires platform-level approval/dual control; Company Approval Engine is not consulted; **not executable until DP-4 Platform Roles exist** | RP |
| V-19 | N-22 | On-Prem install with a manifest term and no Subscription | behaves exactly as today | RP |
| V-20 | N-23/N-26, C-3 | Ceiling from the signed artifact; local profile attempts to raise it | tightening accepted, raising refused. *(Ceiling enforcement is verified inside its own independent WP, not inside another package.)* | RP |
| V-21 | N-24, C-1 | Create an effective Membership by **invitation acceptance** and by **D1/direct grant** at the `users.max` cap | both paths refused at the cap; seat count consistent on both; existing memberships reconciled first (N-28); invitation *issuance* alone consumes no seat | RP |
| V-22 | N-25 | `companies.max` | creating a Company beyond the cap is refused platform-side | RP |
| V-23 | N-27 | Cap reached | new consumption blocked; nothing deleted | RP |
| V-24 | N-28 | Cap applied to an existing Company with real rows | counter starts from reconciled persisted rows, not 0 | RP |
| V-25 | N-29 | Billing | no gateway/engine/invoice path exists; commercial facts only operator-recorded | UNIT + review |
| V-26 | N-30/N-31 | Platform operator also member of a Company | no authority transfers either way; any Support access is explicit, logged, scoped | RP + ISO |
| V-27 | N-32, C-6 | Invitation: reuse, expiry, wrong Company, replay; invitee sets own credential | each refused; audit record per use; no password in the invitation; no Platform Admin created; credential set only by the invitee. *(Verified inside the independent post-WP-0.4 package.)* | RP |
| V-28 | N-33 | Delivery | no Email/WhatsApp/SMS/Notification code path exists | review |
| V-29 | N-34 | Registry/UI | no XNEXUS Company exists or is required | review |
| V-30 | N-35 | Control Plane absent | On-Prem boots, licenses, and operates; no outbound dependency | RP + REG |
| V-31 | N-36/R14 | Any route gaining Company context | its `core.*`/`system.*` permission nodes reviewed against Company-admin grants; test proves a Company admin cannot reach a platform action | RP |
| V-32 | Model B | Cross-Company adversarial matrix extended with each commercial/lifecycle state | A→A allow; A→B, B→A deny; no-context deny; revoked-membership deny; wrong-id deny; platform DB never used for Company data | ISO |
| V-33 | all | Regression | full suite on the isolated instance from an anchored source; every failure classified (E-4) | REG |
| V-34 | N-37, C-5 | Each Control Plane transition (subscription state, plan assignment, lifecycle change, invitation issue/accept/revoke) | produces an audit record in the mechanism selected by the implementation package (working assumption: platform audit records) identifying actor, target Company and the change; **works with the Event Engine absent**. *(Record contents are PROPOSED, not decided.)* | RP |

## 5. Items that cannot be verified until prerequisites exist
- Full per-Company entitlement enforcement (V-12…V-15) — until Area 21 gives the 16 controllers Company context.
- V-10 (recovery), retention behavior beyond V-11 — until those policies are defined.
- V-08 and V-05 — until the LA-1 specification exists.
- V-18 — until the DP-4 Platform Roles and the platform approval mechanism exist (C-4).
- V-14a — until the WP-4.2 specification defines the invalidation mechanism and its scope (C-2).
- V-20 — until the independent ceiling-enforcement WP exists (C-3).
- V-27 — until the independent invitee-credential WP exists after WP-0.4 (C-6).
- V-21 — executable once the DP-6 implementation package defines how the cap is enforced at effective-Membership creation (C-1 is ruled).

## 6. Rollback and release criteria (outline for P6)
Each authorized package ships with: the exact source hash at start and end; a reversible change set (additive migrations only; no destructive down-migration on Company data); a documented fallback to the prior behavior; the evidence bundle (manifest, recorded results, zero-residue proof). Release requires: all P6 criteria, regression on an anchored source, On-Prem independence (V-30), Area 21 status stated, and a **separate explicit release authorization**.

## 7. Traceability

**Rule → scenario (N-01…N-37):** N-01→V-01 · N-02→V-01 · N-03→V-02 · N-04→V-03 · N-05→V-04 · N-06→V-01 · N-07→V-05,V-08 · N-08→V-06 · N-09→V-05 · N-10→V-07 · N-11→V-09a · N-12→V-09,V-10 · N-13→V-11 · N-14→V-12 · N-15→V-12,V-13 · N-16→V-13 · N-17→V-14,V-14a · N-18→V-15 · N-19→V-16 · N-20→V-14a,V-17 · N-21→V-18 · N-22→V-19 · N-23→V-20 · N-24→V-21 · N-25→V-22 · N-26→V-20 · N-27→V-23 · N-28→V-21,V-24 · N-29→V-25 · N-30→V-26 · N-31→V-26 · N-32→V-27 · N-33→V-28 · N-34→V-29 · N-35→V-30 · N-36→V-31 · N-37→V-34. Cross-cutting: Model B → V-32; regression → V-33.

**Reconciliation ruling → rule → scenario → gating package:**

| Ruling | Rules | Scenarios | Package / gate |
|---|---|---|---|
| C-1 seats on every membership path | N-24, N-28 | V-21, V-24 | DP-6 implementation package (WP-3.3) |
| C-2 immediate upgrade; reliable invalidation | N-17, N-20 | V-14, V-14a, V-17 | WP-4.2 spec; gates G-A21, G-0.4 |
| C-3 signed ceiling; independent enforcement WP | N-26 | V-20 | WP-4.3 (independent) |
| C-4 approval after DP-4 roles | N-21 | V-18 | WP-2.1 → WP-5.1 |
| C-5 auditable transitions, no Event Engine | N-37 | V-34 | WP-2.3 |
| C-6 invitee credential after WP-0.4 | N-32 | V-27 | WP-5.3 (after G-0.4) |

Dependency matrix for work packages: contract §10.

## 8. Authorization status
NOT AUTHORIZED. No test, migration, code or schema is created by this plan. WP-0.4 remains NOT MET. Production: HOLD.


---

# PART 3 — DP-9 — Suspension Enforcement: Decision Record

*(source: `DP-9-SUSPENSION-ENFORCEMENT-DECISION-RECORD.md`)*

# DP-9 — Suspension Enforcement — Decision Record

**Record type:** Decision Record only. No code, migration, guard change, ADR number or schema is
created or changed by this document. **Date recorded:** 2026-10-05.
**Source of the decision:** CTO directive "DAII SaaS Control Plane — Long-Range Execution Plan &
Controlled Delivery Protocol", §2 (2026-10-05).

## 0. Classification (per CTO directive §7 — states are never merged)

| State | Value |
|---|---|
| VERIFIED (current behavior) | **Yes** — code path + real-PG runtime (7/7), see §3 |
| DECIDED | **Yes** — decisions D-1…D-7 below |
| AUTHORIZED (implementation) | **NO** — "Implementation Status: NOT AUTHORIZED" (WP-0.3 closed; WP-0.4 NOT MET; Lifecycle Admission package not yet defined) |
| IMPLEMENTED | No |
| REAL-PG / ISOLATION / REGRESSION VERIFIED (of the *fix*) | No — nothing exists to verify |
| DOCUMENTED | This record |
| PRODUCTION | HOLD |

The characterization spec (`src/foundation/company/company-suspension-access-path.characterization.spec.ts`)
is a **diagnostic evidence artifact only** (untracked, test-only). It is not a mandate to change
any guard or production path.

## 1. Decisions (CTO-approved, as issued)

| # | Decision |
|---|---|
| D-1 | `SUSPENDED` = full operational block. **No read-only mode in V1.** |
| D-2 | `DECOMMISSIONED` = full block. |
| D-3 | Enforcement = **Option A**: check `Company.status` inside `CompanyContextGuard`. |
| D-4 | `selectCompany` rejects any Company that is not `READY`. |
| D-5 | An already-issued JWT is blocked **immediately**, via a status check on every request. |
| D-6 | `refresh` does not return the Company claim when the Company is not `READY`. |
| D-7 | Option B is **not** adopted; `DatabaseRegistry` does not become a lifecycle authority. |

## 2. WP-0.3 — consequence items O-1…O-5: CTO rulings (2026-10-05) — DECIDED

| ID | Ruling (as issued) |
|---|---|
| O-1 Background jobs | Backup, Disaster Recovery and platform-level housekeeping **continue** while a Company is not READY. Any scheduled job that performs operational work or modifies Company data **stops** when the Company is not READY. Subscription/entitlement expiry sweeps may continue as **Control Plane** operations but must not bypass the operational block. Every job carries an explicit `companyId` and **re-checks status before executing**. One Company's job failure must not affect another Company. |
| O-2 HTTP error contract | **HTTP 409 Conflict**, stable code **`COMPANY_NOT_READY`**. No operation runs on the Company database; no internal infrastructure state and no other Company's data in the response. Front-end: stop the current operation, remove the invalid Company from the local operational context, return to the Company Selector, show a clear Arabic "Company currently unavailable" message, **no automatic retry** that could repeat a financial/operational action. The per-request check is the final authority, not UI state or JWT validity. |
| O-3 Platform Admin / Support | Platform-level administration routes stay available under their own permissions. **No implicit override** of the Company block for Platform Admin or Support: any operation that requires a Company DataSource obeys the READY condition. **No Support read-only bypass in V1.** Any future exception needs its own ADR/decision defining permissions, audit and scope. |
| O-4 READY-only semantics | The V1 operational condition is `Company.status === READY`. Every other status (`PROVISIONING`, `DEGRADED`, `SUSPENDED`, `MIGRATING`, `FAILED`, `DECOMMISSIONED`) disallows operational work, whether or not it is currently reachable. |
| O-5 Status caching | **No cache** of lifecycle status on the operational authorization path. Every request reads the current status from the Platform DB (one extra read per request accepted in V1). A stale status must never bypass Suspension/Decommission. Any later optimisation needs an independent architectural decision that preserves immediate revocation. |

**WP-0.3: CLOSED (all five items DECIDED). Implementation: NOT AUTHORIZED.**

### 2.1 Derived classification of existing schedulers under O-1 (PROPOSED — needs CTO confirmation of the boundary)

| Scheduler (VERIFIED by code read) | What it does | Class under O-1 | Result when Company not READY |
|---|---|---|---|
| `company-baseline-backup.scheduler` | Company baseline backup | Backup/DR | **continues** |
| `closing-snapshot-recovery.scheduler` | recovers interrupted closing snapshots in Company data | operational (modifies Company data) | stops |
| `preliminary-hold-expiry.scheduler` | expires sales-order holds | operational | stops |
| `approval-expiry.scheduler` | expires approval requests in Company DB | operational | stops |
| `membership-reconciliation.scheduler` | repairs Company role provisioning for memberships | operational (writes Company DB) | stops *(boundary to confirm)* |
| `company-event-dispatcher.scheduler` (foreign, unratified) | runs event handlers on Company data | operational | stops |

Boundary question for the CTO: is `closing-snapshot-recovery` "operational" (this table's reading) or housekeeping? It modifies Company accounting data, so it is classed operational here.

### 2.2 RECONCILIATION OF D-3 × O-1 × O-3 — CTO RULING (2026-10-05): two-layer boundary — DECIDED

The tension recorded earlier (D-3 puts the check in `CompanyContextGuard`; O-1/O-3 speak of every operation that opens a Company DataSource) is resolved by the CTO as follows. The earlier proposal of a single "shared READY assertion" is **rejected as an implementation proposal**; it survives only as an architectural direction.

| Layer | Enforcement point | Rule |
|---|---|---|
| **Layer 1 — Authorization / Request Context** | `CompanyContextGuard` (D-3, unchanged) | `Company.status === READY` for Company-scoped **HTTP** operations |
| **Layer 2 — Company DataSource Safety** | a **Company lifecycle admission check** appropriate to each non-HTTP path (service, scheduler, infrastructure) — *not* the HTTP guard | any path that wants to open a Company DataSource must pass admission and find `READY` before it does |
| **Backup/DR exception** | an **explicit Backup policy** (O-1: backup continues) | exempt from the READY operational block *only because* that exemption is its own explicit, independent decision |

```text
HTTP Request        → CompanyContextGuard            → READY → Company DataSource
Scheduler / Service → Company lifecycle admission    → READY → Company DataSource
Backup Job          → Explicit Backup Policy         →         Company DataSource
```

| Item | State |
|---|---|
| D-3 | **DECIDED** (HTTP enforcement point) |
| O-1 / O-3 | **DECIDED** |
| Two-layer boundary | **DECIDED — architectural direction** |
| "Shared READY assertion" as an implementation | **NOT AUTHORIZED** |
| WP-4.1 scope | expands to include a **Lifecycle Admission Boundary**; its implementation needs a **separate package** |

**The separate Lifecycle Admission package is now named LA-1 (`LA-1-LIFECYCLE-ADMISSION-BOUNDARY-PACKAGE.md`; PACKAGE DECIDED / SPECIFICATION REQUIRED / implementation HOLD) and must define (CTO list):** (1) who calls the admission check; (2) which operations count as *operational*; (3) the exceptions; (4) how a race between the status check and DataSource acquisition is prevented; (5) how schedulers treat a Company that became `SUSPENDED` after the job was scheduled; (6) how Backup is separated from operational access.

*Paths verified by code read that today open a Company DataSource outside the guard (inputs to that package, not a decision):* `company-membership-provisioning.service` (3 sites), `installation-audit.controller`, `plans/company-package.service`, `plans/company-view-context.service`, and the five schedulers listed in §2.1.

## 3. Evidence (VERIFIED)

- **Code path:** `CompanyActivationService.suspend()` writes only `companies.status`
  (`company-activation.service.ts`). The access path checks Membership (`CompanyContextGuard`,
  `AuthService.selectCompany`, `AuthService.refresh`) and the registry status (`getDataSource`
  refuses non-`ACTIVE`). `Company.status` is read only by `listVisible` and `memberships/mine`.
- **Runtime (real Postgres, disposable two-company databases, 7/7 PASS, 2026-10-05):** after
  `suspend()` the status is `SUSPENDED` and the registry stays `ACTIVE`; an already-issued token
  still reaches the Company database; `selectCompany` still issues a token; `refresh` keeps the
  Company claim. After `suspend() → decommission()` the status is `DECOMMISSIONED`, the registry
  stays `ACTIVE`, and access continues. Suspending Company A does not affect B. A registry status
  of `FAILED` refuses the connection (the only block that works today).
- **Tested source hashes (first 16 hex of sha256):** `company-context.guard.ts` `bb38b4e2d042d25c`;
  `auth.service.ts` `a729b3efade142be`; `jwt-auth.guard.ts` `d47f1d6a7168d295`;
  `company-activation.service.ts` `6e2d3223872bdc97`; `company-registry.service.ts`
  `8cb10ccff890ec61`; `company-connection-manager.service.ts` `6ca4212303f1c84f` (this file
  contains edits by another workstream — the proof tests only the pre-existing registry-status
  check); harness `6af6841dc480eed3`; spec `b45aa4e9007194e0`. Valid for those states only.
- **Reachability facts:** only four `transitionTo` call sites exist (suspend, reactivate,
  decommission, provisioning→READY), so `DEGRADED`/`MIGRATING`/`FAILED` are unreachable today and
  `DECOMMISSIONED` is reachable only from `SUSPENDED`.
- **Blast radius (VERIFIED by count):** 36 controllers use `CompanyContextGuard`. Any change to the
  guard affects all of them, including every controller Area 21 already closed.

## 4. Implementation implications (PROPOSED — informational, NOT an authorization)

When a Work Package for DP-9 is later authorized it will touch **shared engines**:
`CompanyContextGuard`, `AuthService.selectCompany`, `AuthService.refresh` (and a Company-status
read per request). Therefore it must be sequenced under the Area 21 gate: stable source state,
no concurrent foreign edits to those files, and re-proof of the controllers that depend on the
guard. The existing mechanism for a revoked Membership (`refresh` drops `companyId`) is the
in-repo precedent for D-6.

Known adjacent behaviors **not changed by DP-9** and tracked separately (see Blueprint, candidate
decision CD-1): `PROVISIONING → READY` is allowed through `reactivate`; a Company whose
provisioning failed stays `PROVISIONING` and is hidden from the Company list; decommissioning has
no data-retention or database-teardown logic.

## 5. Status line

**DP-9: DECIDED — DOCUMENTED — IMPLEMENTATION NOT AUTHORIZED.** Production: HOLD.


---

# PART 4 — Batch A v2 — DP-8 / DP-4 / DP-1

*(source: `BATCH-A-DECISION-PACKAGE-DP8-DP4-DP1.md`)*

# Batch A — DP-8 / DP-4 / DP-1 — Stable Decision Package (v2, after CTO rulings 2026-10-05)

**Status:** RULED. DP-8 **DECIDED (8-1)** · DP-4 **DECIDED (4-A)** · DP-1 **architecture DECIDED IN PRINCIPLE — CONDITIONAL**.
**Implementation authorization for all three: NOT AUTHORIZED.** Production: HOLD.
**Governing rule (CTO):** *existing code that predates a decision does not turn into the decision.* The order is **Architecture Decision → Authorization → Code**, never Code → Architecture justification.

This package is deliberately split into: **§1 what was decided**, **§2 what is still open inside it**, **§3 what already exists in the shared tree (evidence only, not ratified)**, **§4 gap analysis of that code against the decided architecture**, **§5 consistency of the three rulings**, **§6 standing constraints**.
Labels: **DECIDED · NOT RATIFIED · NOT AUTHORIZED · VERIFIED (source read; executed where stated) · PROPOSED · NOT VERIFIED**.

---

## 1. Decision Records

### DP-8 — On-Prem Compatibility — **DECIDED — Option 8-1**
- The SaaS Control Plane must **not** become a prerequisite for running DAII On-Prem.
- Preserve: On-Prem independence; Company operational autonomy; **no** SaaS subscription / billing / control-plane dependency forced on a local installation; the **same Core architecture** wherever possible — a difference of deployment/control plane, **not a product fork**.
- Any SaaS-only service is an **optional control-plane capability**, never an operational dependency of On-Prem.
- The ADR-015 business question (does DAII commercially license On-Prem?) remains **open**; this ruling does not answer it.
- **Implementation: NOT AUTHORIZED** until the DP-1 / DP-4 dependency implications are assembled.

### DP-4 — Platform Identity, Roles & Separation of Duties — **DECIDED — Option 4-A**
- **Platform Authority ≠ Company Operational Authority.** Model B stays: Platform DB → identity, membership, control-plane concerns; Company DB → operational roles and permissions.
- Platform Admin does **not** automatically become a Company Super Admin; **no implicit privilege escalation** through the SaaS Control Plane.
- Any Support/Platform access to Company operations must be **explicit, monitored and scope-limited**.
- Consistent with DP-9 O-3: Platform Admin manages platform-level concerns but has **no bypass** of the Company `READY` rule.
- **Implementation: NOT AUTHORIZED.** (Role set, store design, separation-of-duties rules and the Support-access mechanism are implementation-package questions — §2.)

### DP-1 — Entitlement Runtime Resolution — **ARCHITECTURE DECIDED IN PRINCIPLE — CONDITIONAL**
> **Per-Company entitlement resolution, using an explicit Company context, with the signed manifest / runtime artifact remaining part of the authority chain, and no default or ambient Company context.**

| Item | State |
|---|---|
| DP-1 architecture direction | **DECIDED** |
| Existing Plans implementation | **NOT RATIFIED** |
| DP-1 implementation authorization | **NOT YET GRANTED** |

**Two conditions before this direction can become an implementation authorization:**
1. **Area 21.** Entitlement enforcement may **not** be claimed complete on all Company routes while 16 controllers remain outside the Company-context boundary — VERIFIED: they are exactly the 16 remaining Area 21 controllers (`accounting ap ar attendance cash-bank commission fixed-asset hr inventory-accounting invoices payroll returns rfq sales supplier target`); the other 27 of the 43 module-guarded controllers have `CompanyContextGuard`.
2. **Plans code is not the reference merely because it exists.** Required sequence: **DP-1 architecture → Existing-Plans gap analysis → authorization.** Not: existing Plans → ratification.

---

## 2. Still open inside Batch A (to be settled by implementation packages, not by this record)

| DP | Open sub-decision | Note |
|---|---|---|
| DP-8 | Whether an explicit deployment-mode switch (8-2) is needed to keep SaaS-only surfaces off On-Prem builds; whether plan tables belong in the `core` migration tag that On-Prem also runs | No deployment-mode flag was found in the code read; the as-built Plans migration is in `core` |
| DP-8 | ADR-015 on-prem licensing | Business decision, not answerable from code |
| DP-4 | Platform role set, store design (separate tables vs namespace within 4-A), separation-of-duties rules, key-custody ownership, the explicit/monitored/scoped Support-access mechanism | Support access has **no V1 bypass** under DP-9 O-3 |
| DP-4 | Treatment of the dormant platform-style nodes already in Company `admin` roles (§6) | Standing constraint, not yet a work package |
| DP-1 | Is the per-Company runtime artifact itself signed (a signed Company artifact), or is the signed **installation** manifest the sole signed element with Company plan data unsigned? | The CTO text keeps "the signed manifest/runtime artifact" in the chain; the exact shape is **not** decided |
| DP-1 | Key custody (who may sign; may the Control Plane sign) | Depends on DP-4 |
| DP-1 | Behavior of a Company with no package; cache TTL and invalidation (Gate D); exact wording of partial-enforcement claims until Area 21 | |
| DP-1 | Interaction with the DP-9 Lifecycle Admission Boundary (§4, G-5) | |

---

## 3. What exists in the shared tree — AS-BUILT EVIDENCE, **NOT RATIFIED** (formerly "DP-1.0")

**CTO ruling on DP-1.0: REJECT AS AUTHORIZATION / RETAIN AS EVIDENCE.** Classification: **FOREIGN IMPLEMENTATION — NEEDS RE-PROOF / UNRATIFIED.** Not to be reverted, not to be discarded, not to be treated as approved.
Reasons recorded by the CTO: it appeared before any DP-1 ruling; its authorization is unknown; it modified a shared engine (`RequireModuleGuard`); it introduced `COMPANY_ENTITLEMENT_RESOLVER`; it has effects on a suspended Company; the 16 remaining controllers tie it directly to the Area 21 boundary.

| Item | Fact | Class |
|---|---|---|
| Components | `foundation/plans/`: `Plan`, `PlanModule`, `CompanyPlanAssignment`; `PlanService`; `CompanyPackageService` (assign a plan; sync role templates/grants into the Company DB); `CompanyEntitlementService` (per-Company resolver; 15 s in-process cache keyed by `companyId`; `effective = assigned package ∩ installation licence`; no package ⇒ installation entitlement unchanged); `CompanyViewContextService` (backs `/me/navigation`, `/me/entitlements`); `PlansController` (`@RequireRole('admin')`); migration `core/1789890000000-CreatePlansAndCompanyAssignments`; `PlansModule` `@Global()` and in `app.module.ts`; front-end pages | VERIFIED (read) |
| Shared engines modified | `entitlement-resolver.token.ts`, `require-module.decorator.ts`, `require-feature.decorator.ts` (guards now `async`; use the per-Company resolver when `request.companyContext.companyId` exists, else the installation-wide check), `entitlement.controller.ts`, `navigation.*`, `app.module.ts` | VERIFIED (git diff) |
| Who | "DAII HR (fork)" session — verbatim Write result for `company-package.service.ts`; rest of the group by co-location (inferred). Migration header cites "CTO: 'Super Admin workflow — create a company, assign its package'" — **an assertion inside a file; not received by this workstream; not verified** | VERIFIED (attribution) / NOT VERIFIED (authorization) |
| Corroboration | its generated `docs/acceptance/MODULE_ENFORCEMENT_COVERAGE.md` computes the same 27 / 16 split | VERIFIED |

**Out of Batch A (CTO):** the **Approval Engine** retrofit from the same session is **NOT AUTHORIZED — HOLD / NEEDS RE-PROOF**, no revert, and is not part of this package; no isolation spec it added grants retroactive authorization. The Event Engine work ("Multi-Company front") likewise stays NEEDS RE-PROOF.

---

## 4. Gap analysis — DP-1 decided architecture vs the as-built Plans code (read-only; evidence for the authorization decision, not an endorsement)

| # | Requirement from the decided architecture / rulings | As-built (VERIFIED by reading; nothing executed against the Plans code) | Verdict |
|---|---|---|---|
| G-1 | Per-Company resolution | `CompanyEntitlementService.resolve(companyId)`; guards use the resolver | satisfied in code (unratified) |
| G-2 | **Explicit** Company context, no default/ambient context | Guards read only `request.companyContext.companyId` (set by `CompanyContextGuard`); never the JWT claim | satisfied in code (unratified) |
| G-3 | No default Company on routes without context | Routes without a validated context fall back to the **installation-wide** check — no Company is invented, no widening to platform privilege | satisfied in code; **consequence = partial enforcement** (27/43) until Area 21; a Company on a narrower package keeps the installation's full module set on the 16 |
| G-4 | Signed manifest / runtime artifact stays in the authority chain | The signed **installation** licence is the ceiling (`package ∩ installation`); Company plan assignment rows are **unsigned**; the existing per-Company signed-manifest writer remains unused | **OPEN** — the decided text does not say whether a Company-level artifact must itself be signed (§2) |
| G-5 | Respect DP-9 + Lifecycle Admission Boundary | `CompanyPackageService` and `CompanyViewContextService` open a Company DataSource checking only Membership + registry `ACTIVE`; `/me/navigation`/`/me/entitlements` return a view for a `SUSPENDED` Company; plan assignment forbids only `DECOMMISSIONED` | **GAP** |
| G-6 | Shared-engine changes are re-proved | Both guards changed from sync to `async`; no re-proof of the 43 module-guarded controllers by this workstream | **GAP** (NEEDS RE-PROOF) |
| G-7 | Platform authority per DP-4 4-A | Plan authority is the single platform `admin` role; no platform-role separation exists | **GAP** (depends on DP-4 implementation) |
| G-8 | DP-8 8-1: SaaS-only capability optional, never an On-Prem dependency | Resolver is `@Optional()`; no assignment ⇒ unchanged behavior; but the module is loaded unconditionally and its tables live in the `core` migration tag that On-Prem also runs | **OPEN** (inert, not a dependency; "optional capability" shape undecided) |
| G-9 | Entitlement ≠ permission (ADR-055) | Assigning a package adds grants and never removes any; the Company `admin` already holds every module root (executed, WP-0.5c) → a package that excludes a module does **not** remove the admin's permission nodes; entitlement is the only gate | **FINDING** — must be stated in any "package enforced" claim; live on the 16 controllers |
| G-10 | Cache and consistency | 15 s in-process TTL with exact invalidation in-process; cross-process staleness bound not verified | **OPEN** (Gate D; distinct from the DP-9 no-cache rule for lifecycle status) |
| G-11 | Limits / term / subscription | Plans carry modules only | **OUT OF SCOPE** of DP-1 (DP-5/DP-6) |
| G-12 | Latent authority not activated by accident | Not addressed by the code | **STANDING CONSTRAINT** (§6) |

Reading the table: the code realizes the *shape* of the decided direction (G-1, G-2, G-3) but leaves gaps (G-5, G-6, G-7), a finding (G-9), two open architecture questions (G-4, G-8) and one open consistency question (G-10). Nothing here ratifies it.

---

## 5. Consistency of the three rulings

| Pair | Check | Result |
|---|---|---|
| DP-8 8-1 × DP-1 | The signed installation manifest remains the only thing On-Prem needs; Plans/per-Company resolution is optional and inert when unused | consistent; the "optional capability" *shape* is open (G-8) |
| DP-4 4-A × DP-1 | Plan/entitlement authority needs a platform owner distinct from Company authority | consistent; **DP-1 implementation depends on DP-4 implementation** (G-7) |
| DP-4 4-A × DP-9 O-3 | Platform Admin: platform concerns only, no READY bypass | consistent |
| DP-1 × DP-9 | Entitlement resolution must not widen access to a non-READY Company | consistent in principle; **GAP G-5** until the Lifecycle Admission Boundary exists |
| DP-1 × Area 21 | No default Company context; partial enforcement stated | consistent; Condition 1 |

**No substantive conflict** among the three rulings.

---

## 6. Standing constraints recorded from this round

1. **Latent authority (CTO):** every Company `admin` role already holds `core.limit.edit`, `core.entitlement`, `core.config`, `system.release` (+ every module root) from the core migrations (executed, WP-0.5c). `/limits` is platform-DB only today, so these grants are inert. **Rule:** no route may gain Company context while checking a `core.*`/`system.*` node — and the limits architecture may not be evolved — without first reviewing those nodes against the Company `admin` grants, so this authority is never activated by accident.
2. **F4 (Phase-0 study) is SUPERSEDED** by the real-Postgres characterization and **may not be used** as a basis for any DP-4 or DP-6 decision.
3. **Evidence hygiene:** results are valid only for their tested source state; any run touching the migration runner must hash `dist/database/migrations` as well as `src`.
4. **Foreign changes** (Plans, Approval Engine, Event Engine) are never reverted and never counted as Area 21 or Batch A evidence until re-proved.

## 7. State and next step

| Item | State |
|---|---|
| DP-8 / DP-4 | DECIDED (8-1 / 4-A); implementation NOT AUTHORIZED |
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL; Plans code NOT RATIFIED; implementation NOT AUTHORIZED |
| Approval Engine retrofit | HOLD / NEEDS RE-PROOF; outside Batch A |
| WP-0.4 | **NOT MET** while other workstreams write to the tree |
| Next | Batch B and C (DP-6, DP-5, DP-7; DP-3, DP-2) are prepared against these rulings only on the CTO's call; **no implementation of any kind starts from this package.** |


---

# PART 5 — Batch B — DP-6 / DP-5 / DP-7

*(source: `BATCH-B-CONSOLIDATED-PACKAGE-FOR-CTO-RULING.md`)*

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


---

# PART 6 — Batch C — DP-3 / DP-2

*(source: `BATCH-C-DECISION-PACKAGE-DP3-DP2.md`)*

# Batch C — DP-3 / DP-2 — Decision Package (docs only)

**Status:** PROPOSED / EVIDENCE ONLY — nothing here is decided, authorized or implemented. 2026-10-05.
**Method (same as Batch A v2 / Batch B):** Decided/Open/Conditional → Verified evidence → Existing-tree evidence (separate) → Dependencies → Conflicts/gaps/risks → Recommended bundle (PROPOSED) → Authorization status → Stop conditions.
**Not touched:** code, migrations, guards, Plans, Approval Engine, Event Engine. Labels: **DECIDED · OPEN · CONDITIONAL · VERIFIED · NOT FOUND · NOT VERIFIED · PROPOSED**.

> **CTO RULINGS 2026-10-05 on this package — authoritative; the option text below is the original proposal.**
> **DP-3 — DECIDED: Additive Invitation Model.** An invitation flow **on top of D1, not replacing it.** Constraints: (1) D1 stays valid for the existing-user membership path; (2) an invitation never creates a Platform Admin; (3) it creates/links a **Company membership** within one specific Company; (4) permissions come from **Company RBAC**, not from the invitation; (5) the inviter never sends a password; (6) the invitation is **one-time, expirable and auditable**; (7) it is bound to one Company and cannot be reused for another; (8) the existing `pending` status may be reused if review shows it fits — no parallel lifecycle without reason.
> **Invitation Core = DECIDED. Delivery Transport = DECIDED (CTO, later 2026-10-05): V1 is transport-independent with out-of-band delivery of the link/token outside DAII; the invitee creates their own credential; no Email, WhatsApp, SMS or Notification Engine integration within DP-3 without a separate decision, and no implementation may turn out-of-band into one of those.** (Earlier wording preserved here: Delivery Transport was OPEN) — the engine must be transport-independent; V1 may hand the token/link over outside the system, but Email/WhatsApp/SMS are **not** part of DP-3 implementation without a separate decision. ("out-of-band links" in §6 is *not* adopted as a full execution decision.) **Implementation: NOT AUTHORIZED.**
> *Still open inside DP-3 (not ruled):* whether an invitation may carry a requested `roleKey` reference (constraint 4 says permissions come from Company RBAC, not the invitation); who may issue which invitation (first Company Admin vs staff) in detail; seat-accounting moment (DP-6); rate limiting and token format.
> **DP-2 — DECIDED: XNEXUS is Platform-Level, not a DAII Company.** XNEXUS is **not** represented as an operational Company/tenant inside DAII (structure: Installation/XNEXUS Platform → Company A/B/C; **not** an XNEXUS Company containing customer Companies). No artificial XNEXUS Company may be created to ease permissions or entitlement. This supersedes the `Layout.tsx` code comment as a formal architectural decision and **overrides the earlier PROPOSED lean (option B after DP-4)**. DP-2 authorizes **no** change to platform/Company authority — that belongs to DP-4. **Implementation: NOT AUTHORIZED.** *Consequence noted, not ruled:* if XNEXUS ever needs to run its own business in DAII, that is a separate installation/decision; this ruling does not address it. DP-5's "internal subscription for XNEXUS" and any "owner plan" are therefore out of scope.

## 0. Inherited decisions (binding on this batch)
D1 (provisioning/membership management never create a `User`; `initialAdminUserId` must exist) · D7 (no READY Company without an administrator) · Model B · DP-9 DECIDED (only `READY` grants access; no support bypass) · DP-8 DECIDED 8-1 (SaaS capabilities optional, never an On-Prem dependency) · **DP-4 DECIDED 4-A** (Platform Authority ≠ Company Operational Authority; no implicit escalation; any Support/Platform access to Company operations explicit, monitored, scope-limited) · DP-1 architecture DECIDED IN PRINCIPLE / CONDITIONAL · F4 SUPERSEDED · R14 latent authority · CD-1 on the Risk Docket · WP-0.4 NOT MET · Plans / Approval / Event Engine work = NEEDS RE-PROOF. **Implementation of everything: NOT AUTHORIZED.**

---

## DP-3 — Company Admin Invitation / Onboarding

**1. State.** OPEN. Conditional on DP-4 implementation (who may invite) and on a transport decision; must not supersede D1 unless the CTO says so.

**2. Verified evidence (source read; nothing executed in this batch).**
- **The only user-creation path is `POST /auth/register`.** Bootstrap-only for the first user (who becomes platform `admin`); afterwards it requires an authenticated **platform `admin`** caller. It **auto-activates** the account with **no invitation and no email verification**, and the **admin supplies the password**. Throttled (5/min). There is **no other "create user" endpoint** (the controller's own comment says so).
- `POST /admin/users/:id/reset-password` lets a platform admin **set** a user's password directly (revokes sessions); no self-service password setup for a new user.
- Login blocks any user whose status is not `active`; the default status is `pending`; there is a failed-attempt lockout. So a `pending` state already exists and is already blocking.
- Company onboarding today: the Create Company screen is a **picker over `GET /admin/users`** — the operator must create the User first, then choose it as `initialAdminUserId`.
- **A Company Administrator cannot create a User** (D1: membership management only grants a membership to an existing User; creating a User needs platform `admin`). Users are global identities in the platform database; a Company's staff are memberships.
- **No notification/email transport exists:** `foundation/notification/` is a README stating "NOT IMPLEMENTED — skeleton only". No MFA/TOTP concept was found.

**3. Existing-tree evidence (not ratified).** A front-end page `CompanyMembers.tsx` exists in the control-plane pages (another workstream, 2026-10-05 00:02; **not reviewed here**). No backend invitation code exists in the Plans work.

**4. Dependencies.**
- **DP-4 4-A:** an invitation must not give a Company admin platform authority; the identity-creation step is a platform-identity act, so who may trigger it needs a platform-side rule.
- **DP-9:** an invitation into a non-READY Company must not yield operational access.
- **DP-8 8-1:** On-Prem installations must keep the current manual path; invitation must be an optional capability.
- **DP-5/DP-6:** `users.max` (DP-6) counts memberships or users — invitations must decide when a seat is consumed (at invite, at acceptance).

**5. Conflicts / gaps / risks.**
- **Credential handling:** the platform admin chooses and therefore knows the initial Company Admin's password; the account is active at once.
- **Gap against the intended SaaS split:** the target model has the Company Admin managing the Company's employees, but a Company Admin has no way to create the Users those employees need — only platform `admin` can.
- No delivery channel: any invitation link must travel out-of-band until a notification component is separately decided.
- Invitation tokens are a new credential class: expiry, single use, revocation, audit and rate limiting are all undefined.
- A new identity flow sits next to D1 and next to `AuthService` (a shared engine) — blast radius and re-proof.

**6. Options (PROPOSED only).**
- **A** — keep the current path: platform admin pre-creates the User; passes `initialAdminUserId`.
- **B** — additive invitation record; the User and credential are created by a **separate identity flow when the invitee accepts** (status `pending` → `active`); the **unchanged** provisioning/membership paths then receive the existing `userId`. D1 stays literally true.
- **C** — provisioning creates the User directly (supersedes D1; needs an explicit ruling).
- **Sub-decisions for B:** who may issue an invitation (platform authority per DP-4 for the first Company Admin; Company `core.company.members.manage` holders for staff — scoped to their own Company); transport (out-of-band link vs a new notification component); first-credential setting by the invitee; expiry/single-use/revocation; audit record; rate limit; seat accounting (DP-6).

**Recommended bundle (PROPOSED):** B as a component *beside* Membership Management (never inside it); first-Company-Admin invitations issued by platform authority, staff invitations by the Company's member-management permission; out-of-band link in V1; invitee sets their own password; seats counted at acceptance. Start with a design package only.

**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No new user-creation or token code; no change to `AuthService`/`AuthController`; no change to D1; no notification component; no invitation that grants any operational access before acceptance and `READY`.

**Questions for the CTO.** (a) Keep D1 literally (B) or supersede it (C)? (b) Who may invite whom (first Company Admin vs staff)? (c) Transport for V1. (d) Seat accounting moment. (e) Is the current "admin chooses the password" path acceptable for On-Prem only, or to be retired?

---

## DP-2 — XNEXUS as a Tenant

**1. State.** OPEN. Conditional on DP-4 **implementation** (the *decision* 4-A removes the conceptual blocker; the separation does not yet exist in code).

**2. Verified evidence.**
- The only statement of the current position is a **code comment** in `Layout.tsx`: the Control Plane menu is "not a Company-scoped nav item and **XNEXUS is not an operational Company tenant**". It is not an ADR.
- Nothing in the code prevents creating a Company named XNEXUS through the existing flow; it would be an ordinary Company with its own database and administrator.
- Structural separation already exists on paper: platform authority = platform `roles/user_roles`; Company authority = roles inside the Company database; membership links a global User to a Company. The same person can hold both.
- The first registered user becomes platform `admin` (bootstrap). Platform admin surfaces use `@RequireRole('admin')` (platform), not Company permissions (VERIFIED).
- **Latent authority (R14, executed):** every Company `admin` role holds platform-style nodes (`core.limit.edit`, `core.entitlement`, `core.config`, `system.release`) — harmless today because those routes have no Company context, but an XNEXUS Company admin would carry them too.
- The installation manifest's `customer_name` identifies the licence customer of the installation; in SaaS the host installation is XNEXUS's own — no concept of "operator vs customer" exists in that row.

**3. Existing-tree evidence (not ratified).** None specific to DP-2; the Plans work adds assignment of packages to Companies, which would apply to an XNEXUS Company as to any other.

**4. Dependencies.** **DP-4 implementation (hard prerequisite):** a person who is both a platform operator and an XNEXUS Company member must not inherit either authority from the other. DP-5 (an internal subscription for XNEXUS), DP-6 (internal limits), DP-9 (an XNEXUS Company is subject to the same READY rule; platform administration stays available per O-3), DP-8 (nothing On-Prem-specific).

**5. Conflicts / gaps / risks.**
- Without implemented platform-role separation, the single `admin` role is both the operator and (potentially) the XNEXUS operational administrator.
- Self-referential operation: the Control Plane provisioning, backing up and suspending its own tenant; an XNEXUS suspension must never lock out platform administration (consistent with O-3, but unproven).
- The existing comment would need an explicit superseding record; it must not be overridden implicitly.
- Dormant platform-style Company grants (R14) apply to XNEXUS as to everyone.

**6. Options (PROPOSED only).** **A** — XNEXUS owns the platform only and uses no ERP (status-quo comment, made an explicit decision). **B** — XNEXUS is an ordinary Company with its own database, administrator and internal subscription; platform authority remains a separate identity axis (DP-4 4-A). **C** — B plus a documented internal "owner" plan/exception.
**Recommended bundle (PROPOSED):** keep **A** until DP-4 is **implemented and proven**, then adopt **B** with no owner exception unless a concrete need appears; require a superseding record for the `Layout.tsx` position.

**7. Authorization.** NOT AUTHORIZED. **8. Stop conditions.** No creation of an XNEXUS Company as a decision-by-fact; no change to the existing comment or navigation; no grant of Company roles to platform operators; no special plan or exemption.

**Questions for the CTO.** (a) Does XNEXUS use DAII operationally (dogfooding) at all? (b) If yes, after DP-4 implementation — B or C? (c) Must platform administration be provably unaffected by the XNEXUS Company's own status?

---

## Batch C bundle, dependencies and status (PROPOSED)

| Order | Package | Needs first | Authorization |
|---|---|---|---|
| 1 | DP-3 | DP-4 implementation (who invites), **transport decision (open)** | **DECIDED (additive invitation); implementation NOT AUTHORIZED** |
| 2 | DP-2 | — (no code consequence) | **DECIDED (platform-level, not a Company); implementation NOT AUTHORIZED** |

**Consistency with Batches A/B:** no conflict — DP-3 and DP-2 inherit DP-4 4-A and DP-9 as decided; DP-3's seat accounting ties to DP-6; DP-2's internal subscription ties to DP-5. Both touch shared engines (identity/authentication; platform roles) and so wait on WP-0.4.

## Decision docket after Batches A–C (all PROPOSED unless marked)

| DP | State |
|---|---|
| DP-9 | DECIDED (implementation NOT AUTHORIZED; Lifecycle Admission = separate package) |
| DP-8 | DECIDED 8-1 |
| DP-4 | DECIDED 4-A |
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL |
| DP-6, DP-5, DP-7 | PENDING CTO REVIEW — Batch B prepared |
| DP-3 | **DECIDED** (additive invitation; transport OPEN) |
| DP-2 | **DECIDED** (XNEXUS platform-level, not a Company) |
| CD-1 | **DECIDED — policy** (see `CD-1-ARCHITECTURE-RISK-DOCKET.md`); repair NOT AUTHORIZED |
| Lifecycle Admission (LA-1) | PACKAGE DEFINED — specification required; implementation HOLD |


---

# PART 7 — CD-1 — Lifecycle State Integrity

*(source: `CD-1-ARCHITECTURE-RISK-DOCKET.md`)*

# CD-1 — Architecture / Control Plane Risk Docket entry

**Status:** **DECIDED — policy (CTO 2026-10-05)**; was raised to the Architecture / Control Plane Risk Docket. Not an immediate-fix list and not mixed with DP-9.
**Sequence followed:** characterization (done) → unified lifecycle policy decision (done, below) → repair/recovery/retention packages (not defined, not authorized). **No code changes.**
Characterization is complete (WP-0.5d, REAL-PG VERIFIED on the isolated instance, anchor `ba5a16be…044f1`); see `WP-0.5-CHARACTERIZATION-RESULTS.md` §5 and `evidence/wp05d.recorded.json`.

> **CTO RULING 2026-10-05 — CD-1 = DECIDED — Lifecycle State Integrity (policy). Implementation / repair: NOT AUTHORIZED.** The table below remains the **VERIFIED CURRENT BEHAVIOR** (WP-0.5d); the policy below says what the behavior *must* be. Policy is separated from repair.
> 1. **Provisioning failure:** `Company.status = PROVISIONING` with `Registry.status = FAILED` is **not READY** and may not become READY by `reactivate`.
> 2. **Reactivation:** `reactivate` is a transition for a Company that *was operationally valid and then stopped*; it is **not** a recovery mechanism for failed provisioning. A failed-provisioning Company needs a separate **Recovery / Re-provisioning workflow** (not yet defined — a future package).
> 3. **READY invariant:** `Company.status = READY` with `Registry.status = FAILED` is **never an acceptable operational state** (it may exist transiently during failure handling but is not operationally READY).
> 4. **Decommission:** lifecycle state is separated from **Retention / Destruction policy**. `DECOMMISSIONED` = no operation. Database, credential and membership retention and any destruction schedule belong to a separate **Lifecycle Retention Policy** that is **not yet decided** (immediate deletion vs retention period). The characterized behavior (database/credentials/memberships remain) is current behavior, **not** a decision that it is the final behavior.
> Not authorized: any change to `company-status.ts`, `company-registry.service.ts`, `company-activation.service.ts`, `database-provisioning.service.ts` or the registry controller. Open follow-ups (no ruling yet): the Recovery/Re-provisioning workflow package; the Lifecycle Retention Policy.

| # | Topic | Actual behavior (executed) | Existing decision it rests on | Risk | Exposure today |
|---|---|---|---|---|---|
| CD-1.1 | **Provisioning failure state** | Company row stays `PROVISIONING`, registry `FAILED`; the Company is **hidden from `GET /installation/companies`** (`listVisible` excludes `PROVISIONING`) but found by id; service-level retry (`provision()` again) completes it; the HTTP create route always creates a *new* Company row, so there is no retry through the API or UI | Area 2: "a company is never visible before READY"; Area 4: retry-safe provisioning | An operator cannot see or recover a failed Company from the Control Plane; orphan rows and orphan databases accumulate; a SaaS provisioning flow (P3) would inherit this | any provisioning failure |
| CD-1.2 | **Reactivation bypass** | `reactivate()` accepts `PROVISIONING → READY`; the failed Company becomes `READY` **and is listed as visible** while its registry stays `FAILED`; access is still refused by the registry check (`CompanyDatabaseNotActiveError`) | Area 2/19 state table (explicit decision 2026-09-22) | A READY, listed Company with no usable database; the only barrier is the registry check that DP-9 rejected as a lifecycle authority; confusing for the Control Plane UI and for DP-5 state mapping | one `POST /:id/reactivate` call |
| CD-1.3 | **Decommission retention / teardown** | After suspend → decommission: physical database remains; registry row `ACTIVE`; encrypted credential retained; memberships retained; database still reachable through the connection manager | Area 2/19 ("a READY Company must pass through an intermediate state first"); DP-9 D-2 (full block, status-level) | No data-retention or deletion policy; DP-9 enforcement must not be read as data lifecycle; commercial/legal retention and deletion requirements undefined; credentials of decommissioned Companies persist | every decommissioned Company |

## Interactions with other decisions
- **DP-9 (decided):** D-2 blocks access at the status level; CD-1.3 shows nothing else happens on decommission. CD-1.2 interacts with O-4 (any non-READY status blocks) — a Company wrongly set READY by the bypass would pass the status gate and be stopped only by the registry check.
- **DP-5 (open):** subscription states map to Company status; CD-1.1/1.2 define which transitions are trustworthy.
- **Provisioning (P3):** a plan-driven create flow needs a defined failure state and recovery path.

## Questions for the unified lifecycle decision (not decided here)
1. Failure state: should a failed provisioning move the Company to `FAILED` (state exists, currently unreachable) and be visible to platform admins with a recovery action?
2. Should `PROVISIONING → READY` through `reactivate` remain legal, or only through the provisioning pipeline's own transition?
3. Decommission: retention period, data export, credential revocation, physical database teardown, and who may authorize deletion.

**Not changed:** `company-status.ts`, `company-registry.service.ts`, `company-activation.service.ts`, `database-provisioning.service.ts`, the registry controller. No production code is touched by this entry.


---

# PART 8 — LA-1 — Lifecycle Admission Boundary

*(source: `LA-1-LIFECYCLE-ADMISSION-BOUNDARY-PACKAGE.md`)*

# LA-1 — Lifecycle Admission Boundary — Work Package definition

**Status:** **PACKAGE DECIDED / SPECIFICATION REQUIRED. Implementation: NOT AUTHORIZED (HOLD).** Created by the CTO ruling of 2026-10-05; resolves the D-3 × O-1 × O-3 tension without turning `CompanyContextGuard` into something larger than its function. This document defines scope and inputs only — it is **not** the specification and decides nothing about design.

## 1. Purpose (CTO)
Guarantee that **any path that wants to perform Company operational work cannot reach a Company DataSource or execute the operation without respecting the Company lifecycle policy.**

## 2. Architectural direction already decided (DP-9 record §2.2)
Layer 1 — `CompanyContextGuard` enforces `Company.status === READY` on Company-scoped HTTP operations. Layer 2 — any service/scheduler/infrastructure path that opens a Company DataSource passes a **Company lifecycle admission** appropriate to that path. Backup/DR is excluded **only** by its own explicit, independent policy. A "shared READY assertion" as an implementation is **not** authorized; it was an architectural direction only.

## 3. The specification must settle exactly six things (CTO)
| # | Item | The spec must answer |
|---|---|---|
| 1 | **Callers** | Which actors invoke admission: HTTP, services, schedulers, workers, infrastructure |
| 2 | **Operational classification** | What counts as Company operational work versus Control Plane / maintenance work |
| 3 | **Exceptions** | Backup and similar — each an **explicit policy**, never an implicit bypass |
| 4 | **Atomicity / race** | What happens between the status check and DataSource acquisition; how a TOCTOU gap is prevented so the READY check is not a cosmetic read |
| 5 | **Scheduled work** | A job scheduled while READY whose Company is `SUSPENDED` at execution time must refuse operational execution |
| 6 | **Backup separation** | Backup has its own proven access policy — not `if backup then bypass` |

## 4. Inputs gathered so far (evidence, not design)
- **Paths that open a Company DataSource outside the HTTP guard (VERIFIED by code read):** `company-membership-provisioning.service` (3 sites; reached by platform-admin membership routes), `installation-audit.controller`, `plans/company-package.service`, `plans/company-view-context.service` (foreign, unratified), `closing-snapshot-recovery.scheduler`, `preliminary-hold-expiry.scheduler`, `approval-expiry.scheduler`, `membership-reconciliation.scheduler`, `company-baseline-backup.scheduler`, and `events/company-event-dispatcher.scheduler` (foreign, unratified).
- **Provisional scheduler classification under O-1** (to be confirmed by the specification): baseline backup = Backup/DR (continues); closing-snapshot recovery, hold expiry, approval expiry, membership reconciliation, event dispatcher = operational (stop when not READY). Boundary question flagged earlier: closing-snapshot recovery modifies Company accounting data and is classed operational here.
- **Race-relevant fact (VERIFIED):** `CompanyContextGuard` reads Membership, then `getDataSource` (which checks registry status per call and returns a cached pooled DataSource); lifecycle status is a separate row read. Nothing joins status check and acquisition in one atomic step.
- **O-5 constraint:** no cache of lifecycle status on the authorization path.
- **R14 constraint:** no route may gain Company context while checking `core.*`/`system.*` nodes without reviewing the Company `admin` grants.
- **CD-1 interaction:** READY with a `FAILED` registry is never operationally READY (CD-1 policy); admission must treat the registry state accordingly.

## 5. Dependencies and gates
WP-0.4 (stable source) must be met first — LA-1 touches shared engines (guard, connection manager, schedulers). Area 21 remains an independent gate. Foreign work (Plans, Approval Engine, Event Engine) stays NEEDS RE-PROOF and is not a baseline.

## 6. Stop conditions
No code, migration or guard change; no shared READY assertion implementation; no implicit Backup bypass; no per-job status cache; no change to `CompanyContextGuard`'s scope beyond Layer 1.


---

# PART 9 — WP-0.5 — Characterization results

*(source: `WP-0.5-CHARACTERIZATION-RESULTS.md`)*

# WP-0.5a / b / c / d — Test-only Characterization Results

**Authorization:** WP-0.5a/b/c — AUTHORIZED TEST-ONLY (CTO, 2026-10-05). WP-0.5d (CD-1 characterization) — executed under the same test-only constraints because the CTO's CD-1 ruling required "a separate characterization first"; the CTO should confirm this reading (the spec is untracked; discarding it costs nothing).
**Constraints honored:** disposable real PostgreSQL databases only, **on the isolated instance (127.0.0.1:5544)**; no `daii_dev`, no shared dev server; no production code, migration or guard changed; new files untracked and uncommitted; databases dropped and **zero residue verified**; source hashes recorded; discoveries are findings, not fixes.

## 1. Evidence binding (Exact Source State / Hash / Test Run)

| Item | Value |
|---|---|
| Run | 2026-10-05 05:46:36 → 05:50:20, `jest --runInBand`, 4 suites, **17/17 tests PASS** |
| Executed from | a **pinned snapshot root** (copy of `src/` and `dist/` taken 05:40–05:41, `node_modules` junctioned) so no concurrent edit or rebuild by another workstream could alter the run |
| Snapshot anchor (sha256 over `src/**` + `dist/database/migrations/**`, 1,759 files) | `ba5a16beb64a497d33415974df11d9d2aa8c0181bb6ce080b68f4c83113044f1` |
| Live tree at 05:54 | **identical anchor hash**; no file under `src/` or `dist/database/migrations/` has an mtime after 05:41:30 (last `src` write 05:40:28) → no write occurred during the test window |
| Migration digests recorded by every spec at start and end | `src` `140cc986cd46b031`, `dist` `a2f3ffcf266621dd` (unchanged start→end) |
| Git HEAD | `4bb71f8391321b883b40145b2b5fb6c233048fa2` |
| Raw records | `evidence/wp05a.recorded.json` … `wp05d.recorded.json` |
| Residue | `[]` in all four, re-verified |

**An earlier attempt is INVALID EVIDENCE and is not used:** a first run from the live tree (05:35–05:38) failed in setup (`relation "user_roles" does not exist`) because the migration runner loads the **compiled `dist/database/migrations` at call time** and `dist` was rebuilt (directory mtime 05:38; the process that did it was not identified) during the run. Leftover databases from that attempt were mine and were dropped. Lesson recorded for all later work packages: the evidence manifest must cover `dist/database/migrations`, not only `src`.

The characterization is valid **for the anchored state only**. That state contains other workstreams' unratified edits (guards, Approval Engine, Event Engine, Plans); the tests exercise provisioning/migration/seeding/limit/permission code, not those edits, but the binding is to the whole anchored tree.

## 2. WP-0.5a — adding / removing a module on an existing Company database (closes Dossier F-11)

| Observation | Result | Class |
|---|---|---|
| Core-only Company, then re-run the migration pipeline with `['core','sales']` | **succeeds**; 23 sales migrations ran; `customers`, `sales_orders` created | REAL-PG VERIFIED |
| Existing data (roles 9, role_permissions 33, users 1, user_roles 1) | **unchanged** after the add | REAL-PG VERIFIED |
| Re-run with the same tags | **no-op** (0 pending) | REAL-PG VERIFIED |
| "Remove" the module (run with `['core']`) | **no-op — nothing reverted**; tables and data remain | REAL-PG VERIFIED |
| Module role templates on the existing Company | seeding adds 3 roles / 6 grants; the `admin` role gets 0 new grants (it already held every module root) | REAL-PG VERIFIED |
| Add `accounting` alone onto a core-only database (no `finance`/`sales`) | **succeeds** (41 migrations) — **the runner does not enforce module dependency closure**; closure is enforced only where tags are derived from a manifest | RECORDED FINDING |

**Meaning for DP-5/WP-5.2:** upgrade (add a module to a live Company) is technically feasible with the existing pipeline; downgrade is a data-retaining no-op at database level (access removal is entitlement-only). Dependency closure must be enforced by the caller.

## 3. WP-0.5b — `/limits` scope and Company limit editability (executes Dossier F-6)

| Observation | Result | Class |
|---|---|---|
| Platform `admin` passes the `/limits` edit guard with no Company context | yes (permission evaluated on the platform DB) | REAL-PG VERIFIED |
| A Company A administrator, as the route is wired (no Company context) | **denied** | REAL-PG VERIFIED |
| Same user **if** the route had Company A's context | **allowed** — the Company `admin` role (seeded by core migrations) holds `core.limit` | RECORDED FINDING (dormant authority) |
| `PUT /limits/profiles/:key` effect | row lands in the **platform** `limit_profiles`; Company A's `limit_profiles` stays empty | REAL-PG VERIFIED |
| Effect on Company A | platform cap of 1 → platform-side check `{allowed:false,max:1}`; Company A's check/consume (own database) → `{allowed:true,max:null}` **unlimited** | REAL-PG VERIFIED |
| `setProfile`/`clearProfile` signatures | no `manager` parameter (3 / 2 arguments) — **no Company-capable limit edit path at the service level** | VERIFIED |

**Meaning for DP-6:** a `/limits` edit has no effect on any Company, and every Company is unlimited today (confirmed by execution). If `/limits` ever gains Company context (Area 21), Company admins would hold the permission to edit — a dormant-authority risk for DP-4.

## 4. WP-0.5c — what the initial admin of a UI-created Company can do (**contradicts Phase-0 study finding F4**)

Flow executed: real `DatabaseProvisioningService`, `tags` omitted (every tag → 252 migrations ran), `roleModuleCodes` omitted (`[]`), no entitlement manifest → Company reached READY/ACTIVE.

| Observation | Result | Class |
|---|---|---|
| Three core Company nodes (`members.manage`, `backup.manage`, `audit.view`) | editable | REAL-PG VERIFIED |
| Module permissions | **34 of 34 sales nodes granted** — the `admin` role holds every module root (`accounting attendance commission finance hr inventory logistics manufacturing payroll procurement reporting sales targets`) **without any `roleModuleCodes`** | REAL-PG VERIFIED |
| Platform-style core nodes in the Company database | `core.limit.edit`, `core.entitlement`, `core.config`, `system.release` all **editable**; `core.approval`, `system.release.backup` also present | REAL-PG VERIFIED |
| Re-seed with `roleModuleCodes:['sales']` | **0 additional grants** — the input has no effect on the admin role | REAL-PG VERIFIED |

**Meaning:** the Phase-0 study's F4 ("a UI-created Company's admin receives no module permissions") is **false at runtime**; the core migrations hand the Company `admin` every module root plus platform-style nodes. Consequences for the dossier: (1) entitlement is the only module gate — a package that excludes a module **does not** remove the admin's permission nodes for it (consistent with ADR-055, but the grant is live wherever entitlement falls back to installation-wide: the 16 platform-scoped controllers); (2) plan→permission mapping is not "the missing input"; (3) dormant platform-style authority sits in every Company database (DP-4).

## 5. WP-0.5d / CD-1 — provisioning failure, reactivation bypass, decommission retention

| Topic | Observation | Class |
|---|---|---|
| Failure state | after a failed provisioning (bad admin id → stage `initial-admin`): Company `PROVISIONING`, registry `FAILED`, **absent from the visible list**, still found by id | REAL-PG VERIFIED |
| Resume | calling `provision()` again for the same Company with a valid admin **completes it** (READY/ACTIVE; now listed). The HTTP create route always makes a *new* Company row — no resume path via HTTP (code fact, not executed) | REAL-PG VERIFIED (service) / VERIFIED (code) |
| Reactivation bypass | `reactivate()` on the failed Company → status **READY** while registry stays **FAILED**; **it is listed as visible**; the guard then refuses access (`CompanyDatabaseNotActiveError`) | REAL-PG VERIFIED |
| Decommission | after suspend → decommission: status `DECOMMISSIONED`; **physical database still exists**; registry `ACTIVE`; credential row retained (1); membership retained (1); database still reachable (9 roles read) — no teardown, no retention policy | REAL-PG VERIFIED |

## 6. Findings produced (none fixed; each needs its own decision)

1. **FND-1** — Company `admin` roles hold platform-style `core.*`/`system.release` nodes and every module root (WP-0.5b/c). Dormant today; live if routes gain Company context.
2. **FND-2** — Phase-0 study F4 is contradicted by execution (§4).
3. **FND-3** — The runner does not enforce module dependency closure (§2).
4. **FND-4** — `/limits` edits affect only the platform database; every Company unlimited (§3).
5. **FND-5** — CD-1 behaviors confirmed (§5), including a failed-provisioning Company that can appear as READY and listed.
6. **FND-6** — Evidence hygiene: tests that use the migration runner depend on live `dist/`; manifests must cover it (§1).

## 7. Files created by this work (all untracked, test-only; none committed)

`src/foundation/testing/saas-characterization.helpers.ts` · `src/foundation/testing/saas-provisioning-kit.ts` ·
`src/foundation/database-provisioning/module-add-existing-company.characterization.spec.ts` ·
`src/foundation/limit-engine/limits-scope.characterization.spec.ts` ·
`src/foundation/database-provisioning/ui-created-company-admin.characterization.spec.ts` ·
`src/foundation/database-provisioning/provisioning-lifecycle.characterization.spec.ts` ·
(earlier) `src/foundation/company/company-suspension-access-path.characterization.spec.ts`.
The helper refuses to run unless `DB_HOST=127.0.0.1` and `DB_PORT=5544`.


---

# PART 10 — WP-0.4 — Stable-source evidence (NOT MET)

*(source: `WP-0.4-STABLE-SOURCE-EVIDENCE.md`)*

# WP-0.4 — Working-tree Ownership & Stable Source — Evidence

**Verdict: NOT MET.** (CTO ruling: "CONDITIONAL — NOT YET VERIFIED"; WP-4.1 may not start on this basis.)
What *is* established: a source-hash-bound, non-concurrent test window for the WP-0.5 runs. What is **not**: a standing stable tree, and resolved ownership of every change group. Date: 2026-10-05.

## 1. Definition applied (CTO) and result

| Requirement | Result | Evidence |
|---|---|---|
| Record Git HEAD | **MET** | `4bb71f8391321b883b40145b2b5fb6c233048fa2` (unchanged T0 → T1) |
| Manifest of modified + untracked files with SHA-256 | **MET** for `backend/src` + `backend/docs` | `evidence/T0-manifest-20261005-0530.sha256` (356 files), `evidence/T1-manifest-20261005-0551.sha256` (366 files). **Gap closed:** `dist/database/migrations` is part of the anchor below — the T0 manifest omitted it |
| Identify the owner of each unresolved change group | **PARTIAL** | §3 — attributed by transcript evidence for named files only; everything else UNATTRIBUTED |
| Confirm no concurrent writes during the test | **MET for the WP-0.5 window** | `src/` + `dist/database/migrations/` (1,759 files): no file mtime after 05:41:30, last `src` write 05:40:28; test window 05:46:36–05:50:20; live anchor at 05:54 equals the pinned anchor |
| Bind test results to the actual source hash | **MET** | anchor `ba5a16beb64a497d33415974df11d9d2aa8c0181bb6ce080b68f4c83113044f1`; each spec also recorded migration digests at start and end (unchanged) |
| A standing stable tree | **NOT MET** | §2 |

## 2. Why the tree is not stable (observed, not inferred)

Between T0 (05:30:31) and T1 (05:51:14) these files changed in the shared tree (`evidence/T0-to-T1-changed-files.txt`):
`foundation/approval-engine/approval-engine.service.ts`, `approval-engine.module.ts`, `approval.controller.ts`, new `approval-engine.company-isolation.spec.ts`, `domains/inventory-warehouse/application/inventory.service.ts`, `domains/accounting/application/financial-events/inventory-costing-handler.service.ts`, `foundation/module-registry/manifests/logistics.manifest.ts`.
Earlier today (all verified by mtime) other workstreams changed shared guards, the exception filter, closed Area 21 services and `financial-event.service.ts`. A `dist/` rebuild at 05:37–05:38 (by a process not identified) invalidated one of my own runs.
The quiet interval 05:41→now is real but short and is **not** a stable-source declaration.

## 3. Ownership of change groups (attribution = a verbatim Write result in a session transcript; nothing inferred from file presence)

| Group | Files (examples) | Attributed to | Basis | Ratified? |
|---|---|---|---|---|
| Plans / packages / per-Company entitlement resolver | `foundation/plans/*`, `core/1789890000000-CreatePlansAndCompanyAssignments`, `module-registry/{entitlement-resolver.token,require-module.decorator,require-feature.decorator}.ts`, `entitlement.controller`, `navigation.*`, `app.module.ts`, front-end control-plane pages | **"DAII HR (fork)"** (`local_43695077-…`) for `company-package.service.ts`; the rest of the group by co-location and timestamps (**inferred**) | transcript Write result + diff | **No** — migration header cites a CTO instruction this workstream has not seen |
| Approval Engine retrofit | `approval-engine.service.ts`, `approval-engine.module.ts`, `approval.controller.ts`, `approval-engine.company-isolation.spec.ts` | **"DAII HR (fork)"** (spec Write result at 02:45Z) | transcript + diff (+199/−85 lines) | **No** — Area 21 Approval Engine decision has not been issued |
| Isolated test environment | `docs/acceptance/ISOLATED_TEST_ENVIRONMENT.md`, tools, exception filter edits | **"DAII HR (fork)"** | transcript | not applicable (tooling) |
| Event Engine D10 + D3/D4 policies + manual receipt + edits to closed Area 21 services | `foundation/events/*`, `inventory-posting-policy*`, `returns/*`, `financial-event.service.ts` (05:10), `manual-receipt…spec` | **"Multi-Company front"** (`local_0f4192f6-…`) | transcript Write results (dispatcher, event spec, policy registry, manual-receipt spec) | **No** (CTO: external/unauthorized until established) |
| Area 21 retrofit (27 controllers) | the retrofit files, matrix, ratification package | this workstream (`Multi-Company back21`) | own history | GL pending ratification |
| SaaS control-plane documents and characterization tooling | `docs/decisions/saas-control-plane/*`, the characterization specs and helpers | this workstream | own history | docs only |
| **Everything else** among 366 changed files | — | **UNATTRIBUTED** | — | **NEEDS RE-PROOF** |

## 4. What would make WP-0.4 MET (proposed, for the CTO)

1. A CTO-declared **freeze window** or per-file ownership ruling covering the shared-engine files (guards, Approval Engine, Event Engine, entitlement) — or a ruling that the other workstreams' changes are ratified (so they become part of the baseline instead of foreign changes).
2. Owners (or the CTO) to confirm the **UNATTRIBUTED** remainder.
3. A manifest that includes `dist/database/migrations` (done here) taken immediately before and after WP-4.1's tests.
4. Until then, WP-4.1 and any shared-engine package use **pinned-snapshot execution** (as for WP-0.5): hash-anchored, immune to concurrent edits — valid only for that anchored state.

## 5. Status line
**WP-0.4: NOT MET — evidence recorded.** WP-4.1: **not startable** on this basis.


---

# PART 11 — Master Execution Blueprint (baseline, pinned)

*(source: `SAAS-CONTROL-PLANE-MASTER-EXECUTION-BLUEPRINT.md`)*

# DAII SaaS Control Plane — Master Execution Blueprint

**Status:** PROPOSED planning artifact. It authorizes **nothing**. No Work Package below is AUTHORIZED
until the CTO issues a Work-Package Authorization naming it. **Date:** 2026-10-05.
**Baseline:** DP-9 DECIDED (implementation not authorized). DP-1…DP-8 open — see
`SAAS-CONTROL-PLANE-DECISION-DOSSIER-DP1-DP8.md`. Production: HOLD.

Classification vocabulary (CTO directive §7), used per item and never merged:
`VERIFIED · PROPOSED · DECIDED · AUTHORIZED · IMPLEMENTED · REAL-PG VERIFIED · ISOLATION VERIFIED ·
REGRESSION VERIFIED · DOCUMENTED · PRODUCTION`.

---

## 1. Invariants (every phase and package is checked against these)

1. **Model B** is untouched: one database per Company; Membership in the platform DB; RBAC inside the Company DB; JWT `companyId` is transport only.
2. **D1/D7**: provisioning never creates a User; no `READY` Company without an administrator.
3. **ADR-055**: entitlement ≠ permission; backend is final authority; hiding a UI element is not enforcement.
4. **ADR-015/019**: DAII On-Prem stays independent of the Control Plane; the on-prem licensing question stays open.
5. **DP-9 (DECIDED)**: only `READY` grants access; guard-level enforcement; `selectCompany`/`refresh` follow.
6. **Area 21 gate** remains mandatory and independent. No Controller Retrofit expansion, no Shared-Engine change, no "SaaS ready" claim on partial results.
7. **Shared working tree**: no cross-workstream mutation; any file changed by another workstream after its last verification is `NEEDS RE-PROOF`. Evidence is bound to an exact source state/hash and is not transferred to a changed tree.
8. **Test environment**: single targeted specs on disposable databases only (the two-company real-PG harness). No uncontrolled full jest against the shared `daii_dev` — *reported to this session by the HR-fork session as a CTO ruling; confirm in the Area 21 evidence rules*.
9. **Production**: HOLD until a separate explicit release authorization.

---

## 2. Phases, scope and exit gates

| Phase | Scope | Exit gate (all required) |
|---|---|---|
| **P0 Foundation & Decision Closure** | Record DP-9 ✔; close DP-9 open items O-1…O-5; rule DP-1…DP-8 (+CD-1) in three batches; resolve working-tree ownership; Area 21 boundary ruling for shared engines; test-only pre-proofs | Decision Records DOCUMENTED for every DP; WP authorizations issued; stable-source declaration |
| **P1 Commercial & Authority Architecture** | One architecture contract: Installation ↔ Company ↔ Edition/Plan ↔ Subscription ↔ Limits ↔ Platform authority; data model; verification plan & acceptance criteria | Contract ratified; acceptance criteria per later phase fixed; no open DP |
| **P2 Control Plane Foundation** | Platform identity & roles (DP-4); Plan Catalog authoring model (reuse `editions*`); platform audit events; Control Plane UI shell (reuse existing three pages) | Platform-role separation REAL-PG VERIFIED; catalog CRUD documented; UI contract frozen |
| **P3 Provisioning Integration** | Create Company takes a Plan; plan → (migration tags, role module codes, limits, manifest); provisioning failure handling (CD-1); per-Company limit seeding | Provisioning REAL-PG VERIFIED for ≥2 plans with different module sets; failure states behave per ruling; isolation VERIFIED |
| **P4 Runtime Enforcement** | DP-9 enforcement; per-Company entitlement resolution (DP-1); limit ceilings (DP-6); Company-aware front-end entitlement | DP-9 enforcement REAL-PG + ISOLATION + REGRESSION VERIFIED including re-proof of all guard-dependent controllers; entitlement/limit proofs per Company |
| **P5 Customer Lifecycle** | Subscription entity and lifecycle; renewal/grace/expiry per Company; upgrade/downgrade (incl. module add/remove on an existing Company DB); Company Admin invitation; XNEXUS tenant (optional) | Lifecycle REAL-PG VERIFIED incl. suspended/expired/downgraded/over-limit; invitation flow verified |
| **P6 Acceptance & Release Readiness** | Cross-Company adversarial matrix extended with commercial states; on-prem regression (Control Plane absent); rollback/runbooks; documentation; release criteria | REGRESSION VERIFIED on stable source; on-prem independence proven; release criteria met — then separate release authorization (still HOLD until issued) |

---

## 3. Work-Package catalog

`Auth` = authorization needed before work starts. `Engines` = shared engines/files the package would touch (stop-condition territory). `Track` = parallel lane (§5).

| WP | Package | Phase | Needs decision | Engines touched | Proof required | Track | Status |
|---|---|---|---|---|---|---|---|
| WP-0.1 | DP-9 Decision Record | P0 | DP-9 ✔ | none | document | A | **DOCUMENTED** |
| WP-0.2 | Decision Dossier DP-1…DP-8 + CD-1 | P0 | — | none | document | A | **DOCUMENTED (PROPOSED content)** |
| WP-0.3 | Close DP-9 open items O-1…O-5 | P0 | CTO ruling | none | document | A | **CLOSED — DECIDED 2026-10-05** (see DP-9 record §2; tension D-3 vs O-1/O-3 escalated) |
| WP-0.4 | Working-tree ownership resolution + stable-source declaration | P0 | CTO/owners | none | hash manifest | D | **NOT MET — evidence recorded** (`WP-0.4-STABLE-SOURCE-EVIDENCE.md`) |
| WP-0.5a | Test-only proof: add a module (tag) to an *existing* Company DB (F-11) | P0 | none (test-only) | none | REAL-PG (disposable DBs) | B | **DONE — REAL-PG VERIFIED** (`WP-0.5-CHARACTERIZATION-RESULTS.md` §2) |
| WP-0.5b | Test-only proof: `/limits` scope and Company limit editability (F-6, executed) | P0 | none (test-only) | none | REAL-PG | B | **DONE — REAL-PG VERIFIED** (§3) |
| WP-0.5c | Test-only proof: what a UI-created Company's admin can do (module permissions, F-4 of study) | P0 | none (test-only) | none | REAL-PG | B | **DONE — REAL-PG VERIFIED; contradicts study F4** (§4) |
| WP-0.5d | Test-only characterization of CD-1 (provisioning failure / reactivation bypass / decommission retention) | P0 | CD-1 ruling | none | REAL-PG | B | **DONE — REAL-PG VERIFIED** (§5; CTO to confirm this reading of the CD-1 ruling) |
| WP-1.1 | Commercial & Authority Architecture Contract | P1 | DP-1…DP-9, CD-1, LA-1 | none | document | A | **DOCUMENTED — PROPOSED FOR CTO REVIEW** (`WP-1.1-COMMERCIAL-AND-AUTHORITY-ARCHITECTURE-CONTRACT.md`) |
| WP-1.2 | Data model + Verification Plan + acceptance criteria | P1 | WP-1.1 | none | document | A | **DOCUMENTED — PROPOSED FOR CTO REVIEW** (`WP-1.2-VERIFICATION-AND-ACCEPTANCE-PLAN.md`) |
| WP-2.1 | Platform identity & roles | P2 | DP-4 | `RolesGuard` usage, platform roles | REAL-PG + ISOLATION | E | BLOCKED on DP-4 |
| WP-2.2 | Plan Catalog (authoring) | P2 | DP-1(1b), DP-6 | `editions*` tables | REAL-PG | E | BLOCKED |
| WP-2.3 | Control Plane transition auditing (catalog reference) | P2 | DP-4 *(derived)* | audit mechanism **OPEN** (C-5; platform audit records = working assumption only) | REAL-PG | E | BLOCKED — not authorized |
| WP-2.4 | Control Plane UI shell (reuse 3 pages) | P2 | none for shell | frontend only | frontend tests | C | **Eligible now** (frontend-only, existing contracts) |
| WP-3.1 | Plan → provisioning inputs resolver | P3 | DP-1, DP-6 | provisioning inputs (no pipeline change) | REAL-PG | E | BLOCKED |
| WP-3.2 | Create Company accepts a Plan; failure handling | P3 | CD-1, DP-1 | registry controller/DTO | REAL-PG | E | BLOCKED |
| WP-3.3 | Per-Company limit seeding | P3 | DP-6 | provisioning | REAL-PG + ISOLATION | E | BLOCKED |
| WP-4.1 | **DP-9 enforcement** — Layer 1: guard, `selectCompany`, `refresh`, `409 COMPANY_NOT_READY` contract. **Layer 2 (Lifecycle Admission Boundary) is a SEPARATE package** — its design must first define callers, what is operational, exceptions, the status-check/DataSource-acquisition race, schedulers whose Company is suspended after scheduling, and Backup separation; a "shared READY assertion" implementation is NOT AUTHORIZED | P4 | DP-9 ✔ + O-1…O-5 ✔ + D-3/O-1/O-3 reconciliation | **`CompanyContextGuard`, `AuthService`**, membership-provisioning, installation-audit, plans, 5 schedulers | REAL-PG + ISOLATION + REGRESSION (re-proof of the 36 guard-dependent controllers) | F (gated) | **BLOCKED — WP-0.4 NOT MET; Layer-2 package undefined** |
| WP-4.2 | Per-Company entitlement resolver | P4 | DP-1 | **`EntitlementService`, `RequireModuleGuard`**, Config EDITION layer | REAL-PG + ISOLATION + REGRESSION | F (gated) | BLOCKED on DP-1/DP-4/DP-8 |
| WP-4.3 | Limit ceilings enforcement | P4 | DP-6, DP-1 | `LimitService` consumers | REAL-PG + ISOLATION | F | BLOCKED |
| WP-4.4 | Company-aware front-end entitlement/navigation | P4 | DP-1, O-2 | frontend only | frontend tests | C | BLOCKED on DP-1 (suspended-state UX: dependency on O-2 only; not an authorization) |
| WP-5.1 | Subscription entity + lifecycle | P5 | DP-5, DP-7 | new component | REAL-PG | E | BLOCKED |
| WP-5.2 | Upgrade/downgrade incl. module add/remove | P5 | DP-5, WP-0.5a | provisioning/module-lifecycle | REAL-PG + ISOLATION | E | BLOCKED |
| WP-5.3 | Admin invitation/onboarding | P5 | DP-3, DP-4 | new identity component beside D1 | REAL-PG | E | BLOCKED |
| WP-5.4 | Renewal/grace/expiry per Company | P5 | DP-5, O-1 | new schedulers (existing pattern) | REAL-PG | E | BLOCKED |
| WP-5.5 | XNEXUS tenant (optional) | P5 | DP-2, DP-4 | none | REAL-PG | E | BLOCKED |
| WP-6.x | Adversarial matrix, on-prem regression, runbooks, release criteria | P6 | all above | none | REGRESSION VERIFIED | all | BLOCKED |

---

## 4. Dependency and critical path

```
Batch A: DP-8 → DP-4 → DP-1 ─┐
Batch B: DP-6 → DP-5 → DP-7 ─┼→ WP-1.1/1.2 → P2 → P3 → P4 (4.2, 4.3) → P5 → P6
Batch C: DP-3, DP-2 (after DP-4) ─┘
DP-9 ✔ → WP-0.3 + WP-0.4 → WP-4.1   (independent of Batches A–C)
Area 21 gate: independent; bounds WP-4.1/4.2 (shared engines) and entitlement for the 16 unretrofitted controllers
```

Critical path: **Batch A rulings → WP-1.1 → WP-2.1/2.2 → WP-3.x → WP-4.2 → WP-5.x → P6.**
Longest external wait: **Area 21** (the 16 remaining controllers cannot receive Company-resolved
entitlement until they have Company context — VERIFIED, Dossier F-4).

---

## 5. Parallel work lanes

| Lane | Content | Rule |
|---|---|---|
| A — Decisions/Docs | Records, dossier, contract, verification plans | Read-only on code |
| B — Test-only evidence | WP-0.5a/b/c characterization proofs | New spec files only; disposable DBs; no production edits |
| C — Frontend | WP-2.4 Control Plane shell; suspended-state UX; Company-aware entitlement UI | Reads existing API contracts → integrates → reports gaps; never speculates or edits backend |
| D — Area 21 gate | Independent; owned by the Area 21 workstream | SaaS plan never expands its scope |
| E — Control Plane build | P2/P3/P5 packages | Starts only after its decisions + authorization |
| F — Shared-engine changes | WP-4.1, WP-4.2, WP-4.3 | Gated: stable source, no concurrent foreign edits to the files, re-proof of dependents |

---

## 6. What can proceed vs what stays BLOCKED

> **FINAL READING RULE (supersedes the wording of this section):** nothing listed as "can proceed", "may proceed" or "ready" here is authorized. **Dependency ≠ Authorization; Gate satisfied ≠ Implementation approval.** Work-package IDs are catalog references; every package needs its own explicit Work-Package Authorization. Frontend-only work continues only under the CTO's earlier parallel-work ruling on existing contracts, not by this Blueprint.


**Can proceed without waiting for any other decision**
- WP-0.3 (needs only the CTO's ruling on O-1…O-5, which are consequences of DP-9).
- WP-0.5a/b/c — test-only proofs, subject to a test-only authorization (like F1).
- WP-2.4 — frontend-only reuse of the existing Control Plane pages.
- Lane A drafting of verification plans and acceptance criteria.
- WP-4.1 after WP-0.3 and WP-0.4: it is DECIDED and independent of DP-1…DP-8, but touches a shared engine, so it needs Work-Package authorization and the Area 21 boundary rule.

**BLOCKED** (reason): everything in P1–P6 except the above — each waits on the DP rulings in §3's "Needs decision" column; WP-4.2/4.3/4.4 additionally wait on Area 21 for the 16 unretrofitted controllers.

---

## 7. Delivery protocol (automatic progression vs escalation)

**Work-Package template (each authorization must state):** scope; decision references; files allowed to
touch and files forbidden (ownership); proof required (Real-PG / Isolation / Regression); stable-source
hashes at start and end; rollback.

**Automatic progression.** Inside an authorized package the team proceeds
`CODE → REAL-PG → ISOLATION → REGRESSION → DOCUMENT → NEXT` without asking again, as long as all hold:
in the authorized scope; no new architectural decision needed; no file owned by another workstream is
touched; no authority limit exceeded; no unexplained failure. A package hands over to the next only
when its exit gate is met and recorded with exact source hashes.

**Escalate to the CTO only for (directive §10):**
1. an unresolved architectural or commercial decision that affects design;
2. a conflict between an approved ADR and the code, or between two decisions;
3. risk to data, Company isolation or authorization;
4. a needed edit outside the authorized scope or in another workstream's file;
5. a material failure that cannot be contained inside the package;
6. inability to prove the result on a suitable test environment.

**Evidence rules.** Every result carries its classification label; a narrow pass is never reported as
broad proof; a failure is classified (genuine regression · test pollution · teardown race ·
infrastructure · concurrent foreign change) and never buried under "passes alone"; evidence is valid only
for its tested state.

---

## 8. Risk register

| ID | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | Guard change blast radius | 36 controllers use `CompanyContextGuard` (VERIFIED) | WP-4.1 under Area 21 gate; full re-proof of dependents |
| R2 | Foreign edits contaminate evidence | Event Engine and 14 closed-controller files changed by another session (VERIFIED earlier) | Rule 7; hash-bound evidence; WP-0.4 |
| R3 | Key custody / signing authority undecided | DP-1 1d | Batch A ruling before any signing work |
| R4 | On-prem divergence | F-9, ADR-015/019 | DP-8 guard-rails; P6 on-prem regression |
| R5 | Per-Company entitlement cannot reach 16 controllers | F-4 (VERIFIED) | Interim installation-level rule; follows Area 21 |
| R6 | Module add on existing Company DB unproven | F-11 (NOT VERIFIED) | WP-0.5a before any upgrade promise |
| R7 | **Live exposure: every Company is unlimited and limits are not editable** | F-6/F-7 (VERIFIED by code) | DP-6 + WP-3.3; interim: record as a known commercial risk |
| R8 | Platform admin conflation; first-user-becomes-admin | F-5 (VERIFIED) | DP-4; WP-2.1 |
| R9 | Provisioning failure asymmetry / bypass | CD-1 (VERIFIED) | Triage CD-1 in Batch B |
| R10 | Extra lookup per request (DP-9 D-5) | O-5 | Measure in WP-4.1; no cache without a ruling |
| R11 | Test infrastructure: teardown race flake; shared dev DB contamination | observed repeatedly | Rule 8; targeted specs; cleanup verification after every run |
| R12 | Scope creep into billing | DP-7 | Seam only; billing deferred |
| R13 | No notification transport for invitations | F-8 (NOT FOUND) | DP-3 transport ruling before WP-5.3 |

---

## 9. Immediate next steps *(superseded by §10.4/§10.5 and the Final Closure Package — organizational only; no step here is an authorization)* (this blueprint is the plan; nothing starts without the item named)

1. **CTO:** rule O-1…O-5 (closes WP-0.3) and issue ownership/stable-source ruling (WP-0.4) → WP-4.1 becomes ready for a Work-Package Authorization.
2. **CTO:** rule Batch A (DP-8, DP-4, DP-1) — the longest-lead decision set.
3. **CTO (optional, parallel):** test-only authorization for WP-0.5a/b/c.
4. **Frontend lane:** WP-2.4 may proceed on existing contracts.
5. Team returns with Batch B and C only after Batch A is ruled.

Production: **HOLD**.

---

## 10. Status update 2026-10-05 (after the CTO's WP-0.3 / WP-0.4 / WP-0.5 / Batch A / CD-1 rulings)

| Item | State |
|---|---|
| DP-9 | DECIDED + DOCUMENTED; O-1…O-5 DECIDED; implementation NOT AUTHORIZED |
| WP-0.3 | CLOSED |
| WP-0.4 | **NOT MET** — hash-bound test window established; no standing stable tree; ownership partly unresolved |
| WP-0.5a/b/c/d | DONE, REAL-PG VERIFIED, 17/17, zero residue, isolated instance only |
| CD-1 | Raised to the Architecture/Control-Plane Risk Docket; characterized; awaiting a unified lifecycle decision |
| Batch A | Package prepared (`BATCH-A-DECISION-PACKAGE-DP8-DP4-DP1.md`); **new precondition DP-1.0** — a DP-1-shaped Plans implementation already exists in the shared tree |
| Foreign work now in the shared tree (all classified FOREIGN CHANGE → NEEDS RE-PROOF) | Plans/packages + per-Company entitlement resolver + guard changes ("DAII HR (fork)"); Approval Engine retrofit ("DAII HR (fork)"); Event Engine D10, D3/D4 policy and closed-Area-21 edits ("Multi-Company front") |
| Blueprint effect | WP-2.2/WP-3.x/WP-4.2/WP-4.4 become *review-and-adjust or re-proof* if the Plans work is ratified (DP-1.0); WP-4.1 scope grows (D-3 vs O-1/O-3); the Approval Engine edits touch the Area 21 gate directly (13 blocked controllers) |
| Invariant 8 (test environment) | now written in `docs/acceptance/ISOLATED_TEST_ENVIRONMENT.md` (authored by another workstream: isolated instance `127.0.0.1:5544`); all WP-0.5 runs complied. Still to be confirmed by the CTO as the rule of record |
| Production | HOLD |

### 10.1 CTO rulings of 2026-10-05 (second round) — recorded

| Item | CTO status |
|---|---|
| WP-0.5d / CD-1 | CONFIRMED valid test-only characterization; results → Risk Docket; no fix code |
| D-3 × O-1 × O-3 | **DECIDED — two-layer boundary** (Layer 1 = `CompanyContextGuard` for HTTP; Layer 2 = Company lifecycle admission for non-HTTP paths; Backup exempt by its own explicit policy). Shared READY assertion as implementation: NOT AUTHORIZED |
| DP-1.0 (Plans as-built) | REJECT AS AUTHORIZATION / RETAIN AS EVIDENCE — FOREIGN IMPLEMENTATION, NEEDS RE-PROOF / UNRATIFIED; no revert |
| Approval Engine retrofit | NOT AUTHORIZED — HOLD / NEEDS RE-PROOF; outside Batch A; no retroactive authorization from its spec |
| DP-8 | DECIDED — 8-1; implementation NOT AUTHORIZED |
| DP-4 | DECIDED — 4-A; implementation NOT AUTHORIZED |
| DP-1 | architecture DECIDED IN PRINCIPLE / CONDITIONAL (Area 21 condition; gap analysis before authorization); implementation NOT AUTHORIZED |
| F4 | SUPERSEDED |
| WP-0.4 | NOT MET |
| Production | HOLD |

**Effect on the plan:** P1's architecture contract may now be drafted for DP-8/DP-4/DP-1 (DOCUMENT only). WP-2.1 (platform roles), WP-2.2/3.x/4.2/4.4 (Plans-related) remain **BLOCKED — not authorized**; the as-built Plans code is an evidence input to the DP-1 gap analysis (Batch A §4), not a baseline. A new standing risk **R14** is added: *latent authority* — Company `admin` roles hold platform-style nodes; no route may gain Company context while checking those nodes, and the limits architecture may not evolve, without a prior review.

### 10.2 Decision packages prepared (docs only), 2026-10-05
Batch A v2 (REVIEWED — stable) · `BATCH-B-DECISION-PACKAGE-DP6-DP5-DP7.md` · `BATCH-C-DECISION-PACKAGE-DP3-DP2.md`. All of DP-1…DP-8 now have a package in the stable format (Decided/Open/Conditional → evidence → existing-tree evidence → dependencies → conflicts → PROPOSED bundle → authorization status → stop conditions). **Nothing in B or C is decided or authorized.** Remaining docket items needing CTO rulings: Batch B (DP-6, DP-5, DP-7), Batch C (DP-3, DP-2), CD-1 unified lifecycle, the Lifecycle Admission package definition, and the status of the foreign Plans / Approval / Event Engine work. WP-0.4 NOT MET; production HOLD.

### 10.3 CTO rulings of 2026-10-05 (third round) — recorded
| Item | CTO status |
|---|---|
| DP-3 | **DECIDED** — additive invitation on top of D1 (8 constraints); Invitation Core decided, **Delivery Transport OPEN**; implementation NOT AUTHORIZED |
| DP-2 | **DECIDED** — XNEXUS is platform-level, not a DAII Company; no artificial XNEXUS Company; implementation NOT AUTHORIZED; DP-5 "internal subscription"/owner plan out of scope |
| CD-1 | **DECIDED — lifecycle state-integrity policy** (failed provisioning ≠ READY; `reactivate` ≠ recovery; READY+FAILED never operational; decommission state separated from a not-yet-decided Retention Policy); repair NOT AUTHORIZED; Recovery/Re-provisioning workflow and Lifecycle Retention Policy are future packages |
| LA-1 Lifecycle Admission Boundary | **PACKAGE DEFINED / SPECIFICATION REQUIRED**; implementation HOLD (`LA-1-LIFECYCLE-ADMISSION-BOUNDARY-PACKAGE.md`); replaces the vague "WP-4.1 Layer 2" |
| Batch B (DP-6, DP-5, DP-7) | **PENDING CTO REVIEW** (the CTO had only the summary; content re-presented for review) |
| Plans / Approval Engine / Event Engine work | NEEDS RE-PROOF — NOT RATIFIED; Approval HOLD; never reverted, never a baseline |
| Area 21 / WP-0.4 / Production | independent gate / NOT MET / HOLD |

### 10.4 CTO rulings of 2026-10-05 (fourth round) — recorded
| Item | CTO status |
|---|---|
| Batch B (DP-6, DP-5, DP-7) | **CLOSED AT DECISION LEVEL** (rulings in the Batch B documents); implementation NOT AUTHORIZED |
| DP-3 transport | **CLOSED** — V1 transport-independent + out-of-band; invitee sets own credential; no Email/WhatsApp/SMS/Notification Engine without a separate decision |
| CD-1 | Recovery: `reactivate` is not recovery; `PROVISIONING`+registry `FAILED` needs a separate Recovery/Re-provisioning workflow. Retention: `DECOMMISSIONED` ≠ DELETE; Lifecycle Retention Policy separate; **no authorization for any destructive deletion or teardown** |
| LA-1 | architectural direction fixed (Layer 1 HTTP guard only; Layer 2 lifecycle admission for service/scheduler/worker/infrastructure; Backup/DR explicit independent policy); spec must settle the six items; no shared READY assertion; no widening of `CompanyContextGuard` |
| DP-1 remaining direction | Company runtime entitlement artifact stays in the **signed authority chain**; **signing authority platform-controlled** (never Company Admin / Company DB); **cache allowed** if keyed by `companyId`, explicitly invalidated, bounded TTL, no ambient Company, never mixed with lifecycle status (lifecycle status itself never cached — DP-9 O-5). DP-1 stays ARCHITECTURE DECIDED IN PRINCIPLE / CONDITIONAL until Area 21 and the implementation gates |
| DP-8 | On-Prem independent of the Control Plane; Control Plane / Subscription / Plan Catalog optional; **ADR-015 remains an OPEN business decision** and may not be settled by implementation |
| Foreign work | Plans/Company packages/entitlement, Event Engine = FOREIGN → NEEDS RE-PROOF → NOT RATIFIED; Approval Engine = HOLD → NEEDS RE-PROOF; unattributed changes NEEDS RE-PROOF; no revert/overwrite/ratify-by-assumption/baseline/architectural evidence |
| WP-0.4 | NOT MET |
| **Next step** | **P1 only: WP-1.1 Commercial & Authority Architecture Contract + WP-1.2 (data model, Verification & Acceptance Plan) — documentation/architecture only.** On completion both return to the CTO before any Work-Package Authorization |
| Forbidden until a separate WP Authorization | code/migration/schema/guard changes in Subscription, `LimitService`, `/limits`, Plans, `EntitlementService`, `RequireModuleGuard`, `RequireFeatureGuard`, Auth shared engines, `CompanyContextGuard`, lifecycle state, registry, Approval Engine, Event Engine; WP-4.1/4.2/4.3 on the shared tree |

### 10.5 CTO Reconciliation Rulings C-1…C-6 (2026-10-05) — recorded (architecture only; nothing authorized)
C-1 `users.max` governs the **effective Membership** on every path (invitation **or** D1/direct grant) · C-2 upgrade **immediate**; cache only with **reliable invalidation**, no stale entitlement · C-3 signed artifact = **commercial ceiling**; enforcement is an **independent later WP** · C-4 platform approval/dual control **depends on DP-4 Platform Roles first** · C-5 Control Plane transitions **auditable**, no reliance on the unproven Event Engine · C-6 invitee self-credential = **independent WP after WP-0.4**. Reflected in WP-1.1 (§5 rulings, rules N-17/20/21/24/26, new N-37, §10 dependency matrix) and WP-1.2 (V-14a, V-34, revised V-18/20/21/27, traceability §7). **Sequence:** WP-1.1/1.2 reconciliation → CTO review → Architecture Baseline → Work-Package Authorization. Lane A only; WP-0.4 NOT MET; foreign work NEEDS RE-PROOF; files outside documentation scope (e.g. `rfq.service.ts`, `Rfqs.tsx`, `Approvals.tsx`) are not touched by this lane. Production HOLD.
*Read-back note (2026-10-05):* the work-package names and the "AuditService taxonomy" wording in the catalog above are **PROPOSED**; per C-5 the audit mechanism is **OPEN** (platform audit records are only a working assumption). No work package in this Blueprint is authorized, and meeting a gate does not authorize a package.


---

# PART 12 — Decision Dossier (historical)

*(source: `SAAS-CONTROL-PLANE-DECISION-DOSSIER-DP1-DP8.md`)*

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
