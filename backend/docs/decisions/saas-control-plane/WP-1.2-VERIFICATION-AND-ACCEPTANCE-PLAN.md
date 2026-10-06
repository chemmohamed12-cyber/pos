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
