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
