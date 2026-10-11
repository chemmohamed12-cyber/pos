# DAII — Work Package & Dependency Register — 2026-10-11

**Status: PROPOSED planning artefact for CTO review. It authorises no implementation, no schema/UI/permission/configuration change, no production or hosting access and no release.** Release status: **NOT APPROVED**.
Part B of the planning package. Companions: `DAII-MASTER-EXECUTION-PLAN-2026-10-11.md` (A) and `DAII-CTO-DECISIONS-AND-BLOCKERS-2026-10-11.md` (C). Parent baseline (single source of truth for strategy): `DAII-MASTER-DEVELOPMENT-ROADMAP-2026-10-11.md` (`50b3fc1`); evidence base: six audit documents (`2c6ccf3`, findings `PA-01…PA-42`), Evidence Reconciliation Note (`fe77c01`). Decision IDs `DEC-01…DEC-24` are the roadmap's and are not duplicated. Work-package IDs here are the stable execution IDs; the crosswalk to the roadmap's working labels is in the plan §13.

**Evidence baseline in force.** Audit cutoff `b591d1f`; clean-snapshot evidence `a6002fa` (N-01, 20 isolation specs, business suite T-00…T-20) and **`b591d1f` (N-02 fix + LA-1 L2 included; business suite T-00…T-22, 16 reservation-path isolation specs, unit 59/430, guard 50/50 — committed by the verification track in `1dea0db`/`a33f769` after the audit cutoff)**. Historical counts are preserved: isolation 80/1/19 (committed report) and 90/9/1 (verification status record, now committed) are separate states of the same 100-spec population; 90 PASS is not 90 independently verified clean-snapshot passes (20 are clean-snapshot, 70 working-tree).

## 0. Reading rules

**Status vocabulary (exactly four).**
- **READY FOR PLANNING** — the output is a plan, contract, design or analysis that can proceed now; no implementation is implied.
- **READY FOR IMPLEMENTATION** — no unresolved accounting policy, safety boundary, required authorisation or essential technical fact blocks it; it is executable once the CTO approves the execution baseline (WP-GOV-01). Includes read-only reviews and verification-only artefacts. **It never means a product-code change is authorised.**
- **BLOCKED** — an unresolved decision (DEC-xx), authorisation or missing owner prevents it.
- **AWAITING EVIDENCE** — it depends on a result, run or artefact that does not yet exist.

**Nature labels** follow the register: confirmed-by-test (CT), confirmed-by-reading (CR), suspected (S), missing capability (M), evidence gap (EG), debt (D). A CR finding is not treated as a confirmed runtime defect until its validation package has run. Skipped, blocked and unexecuted tests are never counted as passing.

**Roles (not people).** *Implementer* = the track that changes the code. *Independent reviewer* = a party who is neither the author of the change nor the producer of its evidence (the N-01 closure review was by the code's author; that is not repeated for gates). *Verification track* = Team 2's verification session. *Team 3* = read-only planning/analysis. Ownership of tracks is respected; Team 3 packages are analysis, planning and coordination.

**Independence of closure.** Closure of one package never implies closure of another: N-02, PA-33, payroll/GL/treasury, N-01, F-INV-001 and security/dependencies are separate streams.

## 1. Governance and documentation

| ID | Title · findings · ADRs | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests (auto · manual) | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-GOV-01 | Approve the execution baseline (plan, register, decision brief) and the evidence-update protocol · all · ADR-053 | P0 enabler: nothing else is "executable" without it | CTO review of the three planning documents | CTO · — | Signed baseline note | — · document review | CTO approval recorded; list of approved packages | READY FOR PLANNING |
| WP-DOC-01 | Adopt the capability matrix as the living ADR-053 matrix; reconcile or retire the stale master status file · PA-27 · ADR-053 | P2: governance debt, cheap | CTO decision to adopt (part of GOV-01) | Documentation owner · CTO | Marked-historical master status; owner and update rule | doc-link checker in CI · manual read | Newcomer reading finds current state; owner named | READY FOR PLANNING |
| WP-DOC-02 | Evidence-backed update of the audit documents (PA-22 counts and BLOCKED-by-analysis caveat; matrix F-02; scorecard; PA-42/PA-04/PA-33 evidence class after `b591d1f`) as a separate commit · PA-22, 42, 04, 33 | P1: keeps the evidence base accurate; trigger satisfied (verification record committed in `a33f769`) | None technical; must preserve historical figures and label clean-snapshot / working-tree / blocked / unrun | Team 3 · CTO | New documentation commit; the six audit documents in `2c6ccf3` stay immutable | doc-link check · manual diff review | Both historical figures kept; each claim labelled; six-diff review status carried | READY FOR IMPLEMENTATION |

## 2. Stream AUD — audit-chain integrity after rollback (PA-33) — separate authorisation, plan and closure

Finding: CT (reproducer T-22; FAIL-DEFECT on working tree and, newly, on the **clean snapshot of `b591d1f`**). Contracts: `foundation/audit/audit.service.ts`; N-02 report §6; closing snapshots (ADR-051); restore verification.

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-AUD-01 | Reproduction on a clean snapshot (satisfied) and root-cause note: confirm the entity insert path ignores the supplied `seq`, and no writer bypasses the chain lock | P0-A. Reproduction exists (T-22 on `b591d1f`); the note settles the essential technical fact | None | Team 3 (note) · Verification track | Root-cause note | existing T-22 · code reading | Note states: hashed `seq` ≠ stored `seq` after a burnt serial value; all writers go through `record` | READY FOR IMPLEMENTATION (analysis) |
| WP-AUD-02 | Existing-chain inventory: run the read-only verifier over non-production Companies to count real breaks and gaps | P0-A: informs DEC-02 | Authorised read-only access to non-production Company databases only; window | Verification track · Team 3 | Inventory table (Company, first broken seq, cause) | read-only verifier · none | Every non-production chain classified valid/broken with first break | AWAITING EVIDENCE |
| WP-AUD-03 | Remediation: the audit hash commits to the stored sequence value (`nextval` drawn under the chain lock, explicit insert; no change to hash format; no row rewrite). **Implemented and committed as `c764fc5`** (2026-10-11 13:27, by the verification session; it was committed before the CTO's scope-conformity condition was applied). Team 3 conformity review against the CTO's conditions: **conforms** (`DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md` (Team 3, uncommitted)). Not accepted until AUD-04/06/07 | P0-A, High: tamper-evidence control unverifiable after ordinary failures | DEC-01 **confirmed narrowly by the CTO** (authorisation applies only if the actual diff conforms; Team 3 found it does) | Foundation/Audit implementer (verification session) · independent reviewer | `audit.service.ts` (+27/−9), `t23-audit-seq-hash` spec, T-22 extension | T-22, T-23 R1/R2/C1/C2/H/P1/P2 (working-tree PASS) | Diff limited to drawing, hashing and storing the same sequence value; hash format and existing rows unchanged; accepted only through the AUD-04/AUD-06/AUD-07 criteria (plan §7, AUD row) | AWAITING EVIDENCE |
| WP-AUD-04 | Regression coverage: T-23 (rollback then append, multi-write rollback, 40 concurrent appends, mixed commit/rollback, golden hash vector, healthy chain continues, broken chain preserved) and T-22 (incl. the TypeORM explicit-seq characterisation) exist in `c764fc5`; results are working-tree class | P0-A | Clean-snapshot run of the fix commit (AUD-06) | Foundation/Audit implementer · Verification track | `t23` spec, T-22 extension | T-22, T-23, T-03/13/14, audit-chain-concurrency, area14 | Chain valid after every scenario; stored seq = hashed seq for 100 % of test writes; PASS on a clean snapshot | AWAITING EVIDENCE |
| WP-AUD-05 | Existing-history policy implemented (accept-and-annotate or authorised repair with backup); no in-place rewrite without separate approval | P0-A | **DEC-02**; AUD-02 | Foundation/Audit · independent reviewer + security/audit owner | Policy record; repair tool only if chosen | verifier before/after · manual review | Policy executed; originals preserved; backup verified | BLOCKED |
| WP-AUD-06 | Clean-snapshot verification of the fix commit (CI script, T-00…T-22, audit specs, unit, guard) | P0-A | AUD-03/04; window | Verification track · independent reviewer | Pinned evidence bundle | full suites · none | T-22 PASS; all existing audit specs PASS; `dirtyPaths: []` | AWAITING EVIDENCE |
| WP-AUD-07 | Independent review and written conclusion. A **partial** peer review exists (`89a0a2a`: code review complete, database clean-snapshot verification not complete, "evidence for the CTO's decision, not an acceptance"); its reviewer wrote `runInTransaction`, which the CTO has ruled does not satisfy the independence gate for N-02 | P0-A | AUD-06; a reviewer who did not author the patch or the relevant transaction rule (CTO ruling) | Independent reviewer · CTO | Conclusion in the package report | — · evidence re-examination | Conclusion recorded; PA-33 closes only if AUD-04..06 acceptance met | AWAITING EVIDENCE |

## 3. Stream PAY — payroll ↔ GL ↔ Treasury integrity (PA-34, PA-35, PA-36) — CR until PAY-01 runs

ADR-070 (payroll contract, disbursement shape), ADR-072 (integrated contract), ADR-067 (policy), `payroll-run-posted.handler.ts`, `treasury.service.ts` (`NO_EMIT`).

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-PAY-01 | Runtime validation in a disposable Company: approve → post → disburse one run (4,000 gross + 200 commission); read-only queries of the payroll journal, Wages Payable and bank GL balances, treasury rows and the cash/bank reconciliation | P0-B, High: books wrong from first payroll if CR facts hold | Window on the guarded cluster; no product change; no policy needed (observation only) | Verification track · Team 3 reads the result | Validation record: CT (confirmed) or REFUTED per finding | the lifecycle fixture + read-only SQL · none | PA-34/35/36 each recorded CONFIRMED-TESTED or REFUTED with evidence on a pinned commit | READY FOR IMPLEMENTATION |
| WP-PAY-02 | Decision records for the accounting shape (gross, commission, liabilities, disbursement, partial/failed) and commission expense account | P0-B: gate for any change | **DEC-03, DEC-04** (business/accounting owners); options prepared in the decision brief | Finance/accounting owner · CTO | Signed records | — · review | Records name accounts, timing, partial-payment treatment | BLOCKED |
| WP-PAY-03 | Design record: events and handlers, idempotency key (run id + line id), gap detector, cost-centre allocation | P0-B | PAY-01 result; PAY-02 | Payroll/Accounting implementer · independent reviewer | Design record | — · review | Each decision maps to an event/handler; replay safe on paper | BLOCKED |
| WP-PAY-04 | Implementation: posting amount per contract, disbursement GL entry, decimal-safe arithmetic through the shared money helper | P0-B | PAY-03; CTO authorisation to change payroll posting | Payroll/Accounting implementer · independent reviewer | Minimal diffs | see PAY-05 | Posting amount, disbursement GL entry and decimal arithmetic match the signed contract (PAY-02 / P0H-04); accepted only through the PAY-05/PAY-06 criteria (plan §7, PAY row) | BLOCKED |
| WP-PAY-05 | Tests: gross-only and gross+commission runs; cents/rounding; replay of the posting event; duplicate dispatch; `disburse` retry after partial failure with no duplicate payment; concurrent `disburse`; rollback of the disbursement transaction (audit chain valid — needs AUD); deactivated GL account; reconciliation-gap endpoint; cash/bank reconciliation clean; A/B isolation | P0-B | PAY-03 (authored with PAY-04) | Implementer · Verification track | New specs | listed · none | All PASS; no duplicate posting or payment | BLOCKED |
| WP-PAY-06 | Reconciliation proof: payroll run lines = journal = cash paid; payroll added to the R1–R10 oracle as R11 | P0-B | PAY-05 | Verification track · independent reviewer | Oracle extension | R1–R11 · none | Σ lines = Σ journal = Σ cash for randomised cent amounts; Wages Payable = undisbursed net | BLOCKED |
| WP-PAY-07 | Clean-snapshot verification of the fix commit incl. repaired and extended integrated spec | P0-B | PAY-04..06; window | Verification track · independent reviewer | Pinned bundle | full suites · none | `dirtyPaths: []`; all PASS | AWAITING EVIDENCE |
| WP-PAY-08 | Independent review and conclusion | P0-B | PAY-07; reviewer | Independent reviewer · CTO | Conclusion | — · evidence re-examination | PA-34/35/36 close only on met criteria | AWAITING EVIDENCE |
| WP-COM-01 | Commission integrity: reversal on invoice void/return/credit (or reviewed queue), GL recognition, payroll cut-off tests · PA-38, PA-35 · ADR-071, ADR-072 §14 | P1, Medium (S): paid commission on voided revenue | **DEC-04**; reading of ADR-071's adjustment intent (essential fact); PAY-04 | Commission implementer · independent reviewer | Policy + diffs + specs | void/return/credit scenarios · manual | Reversal or queue works; cut-off cases pass | BLOCKED |

## 4. Stream INV — N-02 reservation and inventory integrity (separate from PA-33 and N-01)

PA-04, PA-05, PA-42; N-02 reports; `inventory.service.ts`; T-20/T-21.

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-INV-01 | Clean-snapshot verification of the fulfil fix: evidence **received** for `b591d1f` (business T-00…T-22, T-20 H3 PASS in both styles, 16/16 reservation-path isolation specs, unit 59/430, guard 50/50). **Open:** T-03/T-04 re-run individually on a quiet cluster (the review's own run failed only on a cluster-collision artefact); final-head pipeline not yet published | P0-C | Quiet, non-conflicting cluster window; verification-track pipeline of the newer HEAD | Verification track · independent reviewer | Existing bundle `evidence-clean-snapshot-2026-10-11/b591d1f-n02/`; new bundle | as run | T-03/T-04 PASS alone; pipeline PASS on a pinned clean snapshot | AWAITING EVIDENCE |
| WP-INV-02 | Independent review of the fulfil fix. Peer reviews exist (`N-02-FULFIL-RESERVATION-INDEPENDENT-REVIEW-2026-10-11.md` (commit `c804845`) and `N-02-F-AUD-003-AND-REMAINING-INDEPENDENT-REVIEW-2026-10-11.md` (commits `89a0a2a`, `5104e1e`, `66c63b9`)) but the CTO has ruled that the disclosed conflict (the reviewer wrote the transaction rule the patch uses) means they **do not satisfy the independence gate**; they remain useful evidence. A reviewer who authored neither the patch nor `runInTransaction` is required, who inspects lock ordering, transaction ownership, re-read after lock, rollback, retries, duplicate movements, reservation consistency and deadlocks, and states explicitly whether the fulfillReservation criteria are met | P0-C: N-02 closes only after this | **DEC-08** (reviewer to be named) | Independent reviewer · CTO | Written conclusion in N-02 report §7 | — · evidence re-examination | Conclusion recorded; fulfil part closes only if criteria met | BLOCKED |
| WP-INV-03 | Reach test (HTTP-level double delivery confirmation) and deadlock evidence for overlapping multi-line fulfilments. Done so far (working-tree class, not closure): same-warehouse overlap reproduced pre-fix (T-21 case I: 12 deadlocks in 24 calls) and 0 after the sorted-key change; override-warehouse variant probed (case J: 0 deadlocks in 24 calls) and downgraded by the reviewer to "not substantiated" with an inferred, unproven edge; **a deadlock must not be called confirmed, nor ignored, when deciding closure** | P0-C | Fixture design for the HTTP reach test | Verification track · independent reviewer | Spec + record | HTTP concurrency · lock-order analysis | One dispatch movement and exact on-hand after the race; documented lock-order analysis or probe covering the remaining edge | READY FOR PLANNING |
| WP-INV-04 | H1 limit-engine overshoot: **implemented in `5c5b791`** (`LimitService.consume`/`release` through the shared rule); authorised by the CTO directive (item 3); T-24 H1 and T-20 H1 PASS (working-tree class); partial review found no defect; own reproduction, patch, tests and acceptance kept separate from the fulfil item | P1 (Medium, CT) | Clean-snapshot evidence; independent review (reviewer rule as INV-02) | Foundation implementer · independent reviewer | Diff + T-24 H1 | T-20 H1, T-24 H1 | Cap never exceeded; rollback restores quota; PASS on a clean snapshot | AWAITING EVIDENCE |
| WP-INV-05 | H2 `releaseReservedQuantity` over-release: **implemented in `5c5b791`**; T-24 H2 and T-20 H2 PASS (working-tree class); separate acceptance | P1 (Medium, CT) | Clean-snapshot evidence; independent review | Inventory implementer · independent reviewer | Diff + T-24 H2 | T-20 H2, T-24 H2 | Releases ≤ reserved; rollback restores; PASS on a clean snapshot | AWAITING EVIDENCE |
| WP-INV-06 | H4 racing `ProcessEngine.start` errors: **implemented in `5c5b791`** (atomic `INSERT … ON CONFLICT DO NOTHING` on the unique index created by migration `1755841300000`); T-24 H4 and T-20 H4 PASS (working-tree class); separate acceptance | P2 (Low–Medium) | Clean-snapshot evidence; independent review | Foundation implementer · independent reviewer | Diff + T-24 H4 | T-20 H4, T-24 H4 | No database error under racing starts; PASS on a clean snapshot | AWAITING EVIDENCE |
| WP-INV-07 | H5 shipment-transition fixture and probe | P1 (S: never probed) | None for the fixture (test-only); fix decision follows result | Verification track · reviewer | Fixture + probe | T-20 H5 · none | Transition limits hold or defect recorded | READY FOR PLANNING |
| WP-INV-08 | T-21 case H (audit chain after rollback): reported PASS after the audit fix (working-tree class); must not be weakened | Tied to AUD | Clean-snapshot run of the fix commit (AUD-06) | — | — | T-21 case H | PASS on a clean snapshot | AWAITING EVIDENCE |

## 5. Stream N01 — numbering and transition concurrency (local-scope closure recorded; do not expand)

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-N01-01 | Independent review of the recorded local-scope closure (clean `a6002fa` evidence; also the final tree passing CI) and recorded conclusion | P0-D | **DEC-07** (reviewer who is not the author of `23e5ec1`/`7097796` nor an evidence producer) | Independent reviewer · CTO | Conclusion in N-01 report | — · evidence re-examination | Agree / agree with caveats / disagree, with reasons; scope stays "local, single instance, tested paths + by construction" | BLOCKED |
| WP-N01-02 | Optional per-endpoint concurrency specs for the highest-traffic untested paths (sales orders, shipments, returns, purchase orders, warehouse transactions) | P2, depends on the reviewer's view of the by-construction argument | WP-N01-01 outcome | Verification track · reviewer | Specs | per-endpoint concurrency | PASS on a clean snapshot | AWAITING EVIDENCE |
| (excluded) | Multi-instance, hosting, production behaviour — **not part of N-01**; see WP-REL-01 | — | — | — | — | — | — | — |

## 6. Stream FIV — F-INV-001 (HTTP 410 change unapproved for release)

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-FIV-01 | Authorised usage investigation: queries Q1–Q4 over every Company database, all history and the last 90 days, via the read-only collector | P1: gates a release decision | **DEC-10** (named operator, read-only access, window) | Named operator · Verification track | Operator evidence | read-only queries · none | Evidence returned for every Company | BLOCKED |
| WP-FIV-02 | Compatibility assessment (internal callers verified not to POST non-receipt types; external usage unknown until FIV-01) | P1 | FIV-01 | Verification track · independent reviewer | Assessment | — · review | Documented usage and compatibility conclusion | AWAITING EVIDENCE |
| WP-FIV-03 | Release decision for the 410 change | P1 | FIV-02; CTO | CTO · — | Decision record | — | **Stays unapproved for release until FIV-01/02 complete** | BLOCKED |

## 7. Stream SEC — security, authorization, guards, dependencies (no unapproved bulk upgrades or lockfile changes)

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-SEC-01 | Dependency triage of the 65 backend (and 3 frontend) advisories by severity **and** runtime reachability; per-package targeted action, tests and rollback | P1, High (PA-25): release gate | None (analysis of existing audit data and source) | Team 3 / Security analyst · Foundation | Triage table (roadmap §4 extended) | — · source search for reachability | Every runtime-reachable package has a reachability verdict (verified or inferred, stated) and a proposed targeted change | READY FOR IMPLEMENTATION (analysis) |
| WP-SEC-02 | Hand review of the four JWT controllers without Company/platform guards; salary-data visibility check against the permission nodes | P1 (PA-29, Medium–High) | None (read-only) | Team 3 / Authorization track · reviewer | Per-controller review record | role × route tests proposed | Each controller classified (intentional/oversight) with evidence | READY FOR IMPLEMENTATION (analysis) |
| WP-SEC-03 | Dependency T1 (non-breaking) changes, one scoped change each, re-audit from a clean snapshot | P1 | **DEC-20**; SEC-01 | Foundation implementer · reviewer | Scoped diffs; re-audit | CI + business suite + isolation specs | Runtime critical = 0; no lockfile change outside the approved scope | BLOCKED |
| WP-SEC-04 | Dependency T2 major upgrades plan (NestJS, bcrypt 6, react-router 7, Jest 30) | P2 | SEC-03; ENB-01/02 (test net) | Foundation implementer · reviewer | Upgrade plan | n/a (plan) | Plan with tests and rollback; executed only when the net exists | BLOCKED |
| WP-SEC-05 | Guard review follow-through: apply the decisions on the 6 helper specs and 3 role-creating specs; guard unchanged unless explicitly decided | P1 (PA-22) | **DEC-09** | Verification track · guard owner | Per-spec results per commit | guard 50/50 · none | BLOCKED/NOT RUN never counted as pass | BLOCKED |
| WP-SEC-06 | Host proxy check (for the `proxy-addr` advisory) | P2 | Host access (not authorised) | Platform · reviewer | Check record | — | Proxy does not rely on vulnerable trust-proxy semantics | BLOCKED |

## 8. Stream LA1 — lifecycle admission (company isolation, PA-41)

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-LA1-01 | Wire the seven remaining sites (closing-snapshot recovery, membership provisioning ×3, membership reconciliation, event dispatcher, plans ×2) by their owners | P1 (Medium–High): a path opens a Company DataSource without admission | **DEC-19** (owners, approach); files owned by other tracks | Site owners · independent reviewer | Diffs + a real-Postgres spec per site | per-site specs | "A path without admission" no longer true | BLOCKED |
| WP-LA1-02 | Clean-snapshot isolation evidence for LA-1 Layer 2 as committed (`60b9bdf`): admission spec and scheduler/audit specs. Note: the `b591d1f` run lists 16 reservation-path isolation specs; the LA-1 admission spec is not among them | P1 | Window | Verification track · reviewer | Pinned bundle | `company-lifecycle-admission.real-pg.spec.ts`, scheduler specs, `company-audit-access` is **protected, not run** | PASS on a clean snapshot; protected spec untouched | READY FOR IMPLEMENTATION |
| WP-LA1-03 | Fix the three lint errors present at `a33f769` and still at `5c5b791`, all in LA-1 files (commit `60b9bdf`): `src/foundation/audit/installation-audit.controller.ts` 5:10 `'RolesGuard' is defined but never used` and 6:10 `'RequireRole' is defined but never used` (`@typescript-eslint/no-unused-vars`); `src/foundation/company/company-lifecycle-admission.real-pg.spec.ts` 5:1 import of `../../domains/sales-orders/application/preliminary-hold-expiry.scheduler` restricted (cross-domain internal import, DAII_DOMAIN_BOUNDARIES.md). Five further warnings (unused `eslint-disable` directives in other files) are not LA-1 and not errors. **Not attributed to N-02.** Fix authorised by the CTO within the LA-1 scope; preserve the failing evidence (`test-03/evidence/ci-run-n02-head-snapshot.log`, `ci-run-n02-final-head-snapshot.log`) | P1 (CI red at HEAD; PA-41, PA-22) | None: the diagnostics are exact; fix is two unused imports and a boundary-compliant way to reach the scheduler from the spec | LA-1 owner · independent reviewer | Two small diffs; green lint evidence | `npm run lint`, CI script on a clean snapshot of the resulting tree | Lint 0 errors on the resulting tree; **CI is not called green until all steps pass on that tree**; LA-1 specs still PASS | READY FOR IMPLEMENTATION |

## 9. Stream VER — verification net (cross-cutting enablers)

| ID | Title | Priority & rationale | Prerequisites / blockers | Owner · Reviewer | Artifacts | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|---|
| WP-VER-01 | Order-to-cash chain test at HTTP level (creation → approvals → deposit → fulfilment → shipment → delivery → invoice → payment → GL) with per-hop assertions and R1–R10 · PA-03 | P1 (High, EG) | Fixture design; unwind cases need ACC-09 | Verification track · reviewer | Spec + record | chain spec · none | Pinned clean-snapshot PASS | READY FOR PLANNING |
| WP-VER-02 | Real-Postgres job in CI and first hosted-runner execution · PA-22 | P1 | Hosted runner (not available); DEC-09 for blocked specs | Verification track · reviewer | CI config run | CI | Hosted run green; real-PG job scheduled | AWAITING EVIDENCE |
| WP-VER-03 | **Line-by-line review of the six pending adaptation diffs** (`company-membership-provisioning`, `company-datasource-factory-impact`, `company-datasource-registry-isolation`, `company-migration-runner`, `restore-manager-audit-chain`, `company-database-pool.multi-process`) and of the four read by Team 3 by an independent reviewer | P1: until done no broader safety claim | None (read-only) | Independent reviewer · CTO | Review record per diff | — · diff review | No assertion, guard-relevant statement or cleanup behaviour changed | READY FOR IMPLEMENTATION |
| WP-VER-04 | Frontend test strategy and short browser E2E set per phase path (order-to-cash, procure-to-pay, period close, payroll) · PA-23 | P1 (High, EG) | Strategy decision (essential fact: test runner choice) | Frontend/Verification · reviewer | Strategy + first tests | component + browser E2E | Runs in CI | READY FOR PLANNING |
| WP-VER-05 | Payroll in the oracle (R11) and golden-fixture suite hooks | with PAY-06 / ACC-01 | — | — | — | — | — | (tracked under PAY-06, ACC-01) |

## 10. Phase 0 — HR and Manufacturing contracts ONLY (no code, schema, UI, permission or configuration change)

Each contract covers domain boundaries, data ownership, workflow, financial-event contract, authorization requirements, failure/recovery behaviour and acceptance scenarios (ADR-053 §2).

| ID | Title · findings · sources | Priority | Prerequisites / blockers | Owner · Reviewer | Artifacts | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| WP-P0H-01 | Statutory payroll scope and effective dating (overtime, income tax, social insurance, other deductions; rate-table ownership) · PA-16 · ADR-067 §D/§E | P1 | Structure now; rates need **DEC-05** (business/legal owner, jurisdiction) | HR/Payroll architect · CTO + business owner | Contract draft; rate-table schema (document) | Contract signed or deferred with owner | READY FOR PLANNING |
| WP-P0H-02 | Holiday/working-day calendar; absence, lateness and unpaid-leave pay rules · PA-37 · ADR-067 §C, ADR-053 §16 | P1 | Rules need DEC-05 | same | Contract draft | same | READY FOR PLANNING |
| WP-P0H-03 | Payslip: content, numbering, approval, access, print/export · PA-16 | P2 | Access scope needs **DEC-23** | same | Contract draft | same | READY FOR PLANNING |
| WP-P0H-04 | Payroll accounting shape: posting amount, commission account, tax/insurance payable, disbursement entry, partial/failed disbursement, cost-centre allocation, reconciliation and closing-audit treatment · PA-34, 35 · ADR-070, ADR-072 | P0 (gates PAY) | **DEC-03, DEC-04** (this is the contract form of PAY-02) | Finance owner + architect · CTO | Contract draft | Signed | READY FOR PLANNING |
| WP-P0H-05 | Business-date rule for attendance, commission, payroll periods · PA-14 | P1 | **DEC-06** | architect · CTO | Rule record | Signed | READY FOR PLANNING |
| WP-P0H-06 | Disbursement: payment instruction/batch file, employee payment details, rejection/re-issue · PA-34, PA-09 | P1 | **DEC-24** | Treasury owner · CTO | Contract draft | Signed | READY FOR PLANNING |
| WP-P0H-07 | HR master: contracts, documents, leave types/balances/entitlements, shifts, loans, end-of-service · PA-40 · charter Wave 2 | P1 | DEC-18 for scope | HR architect · CTO | Contract draft | Signed | READY FOR PLANNING |
| WP-P0H-08 | Commission reversal policy and payroll cut-off · PA-38 · ADR-071/072 | P1 | **DEC-04** | Commission architect · CTO | Contract draft | Signed | READY FOR PLANNING |
| WP-P0H-09 | Salary-data visibility under the authorization model · integration I-15 | P1 | **DEC-23** | Authorization track · CTO | Visibility matrix | Signed | READY FOR PLANNING |
| WP-P0M-01…06 | Manufacturing contracts M0-1…M0-6 (planning/MRP boundary, costing, scrap/rework/by-products, lot/serial interface, capacity scheduling, open policy items: WIP template completeness, Event Engine batching, recovery audit) · PA-31, 06, 07 · ADR-060/061 | P2 | **DEC-18, DEC-22** | Manufacturing architect · CTO | Six contract drafts | Signed or deferred with owner | READY FOR PLANNING |
| WP-P0-GATE | Phase 0 exit: every contract signed or deferred with an owner; no implementation artefact exists for them | P0 | All P0H/P0M | CTO | Gate record | See plan §9 | AWAITING EVIDENCE |

## 11. Phase 1 — Accounting and HR (implement, verify, internally accept)

Common acceptance: Implemented-and-Verified on a clean snapshot of a named commit, HTTP-level scenario test, oracle extended, browser E2E for the UI path, no open High finding in the domain, independent review of the gate evidence, CTO internal acceptance (not release approval).

### 11.1 Accounting

| ID | Title · findings · sources | Priority | Prerequisites / blockers | Owner · Reviewer | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| WP-ACC-01 | Golden-fixture suite for TB/BS/P&L/cash flow (existing behaviour only: tax, depreciation, disposal, WIP) + oracle extension ("balance sheet balances", "cash-flow net equals treasury movement") · PA-32 | P1 | None: no policy needed for existing behaviour | Accounting/Verification · reviewer | fixture suite, R-checks | Known input → known statements; oracle checks PASS on a clean snapshot | READY FOR IMPLEMENTATION |
| WP-ACC-02 | = WP-PAY-04…08 (payroll-to-ledger correctness); no separate work | — | see PAY | — | — | see PAY | (alias) |
| WP-ACC-03 | Year-end approach and implementation · PA-10 · ADR-047 D3 | P1 | **DEC-16**; ACC-01 | Accounting · reviewer | statements unchanged by close; reopen safe | Statements (ACC-01 golden fixtures) unchanged by the year close; reopen after year close works; the chosen approach (DEC-16) is documented; PASS on a clean snapshot | BLOCKED |
| WP-ACC-04 | Bank-statement import and matching incl. payroll payments · PA-09 | P1 | ACC-01; payroll cash leg (PAY) for payroll matching; no specification exists (essential fact: matching rules) | Accounting/Treasury · reviewer | import preview, matching, A/B isolation, worked fixture | Reconciliation fixture clean | AWAITING EVIDENCE (needs specification) |
| WP-ACC-05 | Business-date unification via one helper · PA-14 | P1 | **DEC-06**; Commission regression re-run (see HR-03) | Accounting/HR · reviewer | fixtures at 23:30–03:30 Cairo; serial regression | One rule everywhere | BLOCKED |
| WP-ACC-06 | F03 deadlock: re-verify the retry on HEAD; Option A decision · PA-13 | P1 | **DEC-13**; AUD closure (shared lock paths) | Accounting/Foundation · reviewer | `f03-deadlock-retry-verification` on HEAD | PASS on a clean snapshot | AWAITING EVIDENCE |
| WP-ACC-07 | AP/AR adjustment accounts and VAT by approved policy (replace literal `5299`) · PA-39 | P1 | **DEC-17** | Accounting · reviewer | per-kind tests | Policy applied | BLOCKED |
| WP-ACC-08 | FX revaluation and exchange result, if required · PA-11 | P2 | **DEC-18** | Accounting · reviewer | revaluation run tests | Revaluation run with approval; exchange-result accounts as decided; reconciliation extended to foreign balances; PASS on a clean snapshot (only if DEC-18 confirms the requirement) | BLOCKED |
| WP-ACC-09 | Enablers: sales-order cancellation (deposit policy, reservation release) and supplier return (GRNI/PPV reversal, debit note) · PA-01, PA-08 | P1 | **DEC-14, DEC-15**; INV closure for reservation paths | Sales/Procurement · reviewer | concurrency (double cancel; cancel vs ship; return caps), oracle | Cancellation: pre-conditions per state with compensation rules, reservations released, deposit as decided in DEC-14, reconciliation clean, double-cancel and cancel-versus-ship tests PASS. Supplier return: caps, GRNI/PPV and supplier-ledger effects as decided in DEC-15, concurrency as T-07, oracle extended | BLOCKED |
| WP-ACC-10 | Order-to-cash and procure-to-pay chain tests with the oracle · PA-03 | P1 | VER-01; ACC-09 for unwind cases | Verification · reviewer | chain specs | Pinned clean-snapshot PASS | AWAITING EVIDENCE |

### 11.2 HR (attendance facts, targets/performance, commissions, payroll)

| ID | Title · findings · sources | Priority | Prerequisites / blockers | Owner · Reviewer | Tests | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| WP-HR-01 | = WP-PAY-01…08 (ledger correctness); no separate work | — | see PAY | — | — | see PAY | (alias) |
| WP-HR-02 | Integrity primitives: audit chain (= AUD), business date (= ACC-05) | — | see AUD, ACC-05 | — | — | see those | (alias) |
| WP-HR-03 | Commission regression canonical serial re-run on a named clean commit; update of the integrated E2E spec status; extend the spec with journal-amount, post-disbursement-GL and treasury-reconciliation assertions; execute to PASS · PA-14, PA-17 · ADR-072 | P1 (High, EG) | Window; business-date decision (for fixtures); PAY-01 (so that assertions reflect observed behaviour) | HR/Commission + Verification · reviewer | 204-test serial regression; extended integrated spec | Spec no longer BLOCKED; PASS on a pinned commit | AWAITING EVIDENCE |
| WP-HR-04 | HR master completion: contracts, documents, leave types/balances, shifts, holiday calendar · PA-40, PA-37 · charter Wave 2 | P1 | P0H-02, P0H-07 signed | HR implementer · reviewer | lifecycle + isolation specs; HR pages E2E | Lifecycle and isolation specs PASS for contracts, documents, leave types/balances, shifts and calendar as defined in the signed contracts (P0H-02, P0H-07); HR pages covered by browser E2E | BLOCKED |
| WP-HR-05 | Time-to-pay rules, statutory computation, tax/insurance liabilities, payslip · PA-16, PA-37 | P1 | P0H-01/02/03/04 signed; **DEC-05**; PAY-04; HR-04 | HR/Payroll implementer · reviewer | golden fixtures per rule; liabilities in GL; payslip access tests | Reproducible runs; fixtures pass | BLOCKED |
| WP-HR-06 | = WP-COM-01 (commission integrity); no separate work | — | see COM | — | — | see COM | (alias) |
| WP-HR-07 | Treasury and month-end for payroll: payment batch, rejection/re-issue, statement matching of payroll payments, closing-audit category and wages-payable reconciliation · PA-09, PA-34 | P1 | PAY-04; P0H-06; DEC-24 | Treasury/Accounting · reviewer | batch lifecycle; closing audit lists unposted/undisbursed runs | Reconciliation clean | BLOCKED |
| WP-HR-08 | Attendance facts, targets/performance and commission verification: clean-snapshot evidence and browser checks for attendance import/mapping/approval, targets approval, commission policy→result→approval→adjustment; isolation and permission matrix · PA-23, PA-14 | P1 | Business-date fixtures (ACC-05); frontend strategy (VER-04) | Verification · reviewer | isolation specs on a clean snapshot; browser E2E | PASS on a pinned commit | AWAITING EVIDENCE |
| WP-P1-01 | Integrated Phase 1 acceptance scenario: HR master → attendance facts → targets → sales events → commission → payroll → GL → treasury → period close (closing audit, snapshot), with idempotency/replay/rollback cases and reconciliation (R1–R11) | P1 | HR-03, HR-05, HR-07, PAY-07, ACC-03 | Verification · independent reviewer | chain scenario | Pinned clean-snapshot PASS; reconciliation clean | AWAITING EVIDENCE |
| WP-P1-GATE | Phase 1 exit gate (plan §9) | P1 | all above | CTO · independent reviewer | Gate record | See plan §9 | AWAITING EVIDENCE |

## 12. Enablers, architecture, Phase 2

| ID | Title · findings | Priority | Prerequisites / blockers | Owner · Reviewer | Acceptance | Status |
|---|---|---|---|---|---|---|
| WP-ENB-01 | Frontend component tests + browser E2E per phase path (PA-23) | P1 | = VER-04 strategy | Frontend · reviewer | Runs in CI | READY FOR PLANNING |
| WP-ENB-02 | Real-Postgres CI job, hosted run, remaining unrun/blocked specs (PA-22) | P1 | = VER-02, SEC-05 | Verification · reviewer | Hosted green; counts per class reported | AWAITING EVIDENCE |
| WP-ARCH-01 | Opportunistic contract extraction when a change touches a concrete cross-domain import (7 in the HR chain) (PA-28) | P2 | A resolved-path lint rule before it can be enforced | Architecture · reviewer | No new concrete imports | READY FOR PLANNING |
| WP-REL-01 | Release/hosting readiness: staging host, capacity targets and classification, multi-instance run (incl. any N-01 multi-instance extension), restore/rollback drills (needs AUD), monitoring (PA-24, 26, 30) | Phase 2, first | Phase 1 gate; **DEC-11**; host; AUD closure | Platform/Verification · independent reviewer | Release gate record | BLOCKED |
| WP-P2-02 | Customer quotation → order (PA-02) | P2 | DEC-18 | Sales · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-03 | Notifications and job queue; multi-instance-safe schedulers (PA-18) | P2 | REL-01 decisions | Foundation · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-04 | Lot/serial/expiry; FIFO/standard costing (PA-06, 07) | P2 | P0M-04, DEC-18 | Inventory · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-05 | Planning: availability, MRP, capacity scheduling (PA-31) | P2 | P0M-01/05 | Manufacturing · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-06 | Budgeting and read-only consolidation under the existing entitlement/audit model (PA-12) | P2 | ACC-01…04 | Accounting · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-07 | Integrations tenancy, more connectors, e-invoicing if legally required (PA-20, PA-15) | P2 | **DEC-12**, DEC-18, legal requirement | Platform · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-08 | HR breadth: recruiting, self-service, performance cycles, training, expenses (PA-40) | P2 | Phase 1 HR | HR · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |
| WP-P2-09 | CRM pipeline, project costing, tracking domain (PA-31, PA-19) | P2 | — | Product · reviewer | ERP Integration Contract signed; clean-snapshot verification; independent review | BLOCKED |

## 13. Dependency summary (edges that matter)

```
WP-GOV-01 ─► all "READY FOR IMPLEMENTATION" packages
DEC-01 ─► AUD-03 ─► AUD-04 ─► AUD-06 ─► AUD-07 ;  DEC-02 + AUD-02 ─► AUD-05
AUD-03..06 ─► INV-08 (T-21 case H) ─► PAY-05 rollback case ─► REL-01 restore drill
PAY-01 ─► PAY-03 ◄─ PAY-02 ◄─ (DEC-03, DEC-04 / P0H-04) ;  PAY-03 ─► PAY-04 ─► PAY-05 ─► PAY-06 ─► PAY-07 ─► PAY-08
PAY-04 ─► HR-05, HR-07, COM-01 ;  P0H-01/02/03 + DEC-05 ─► HR-05
DEC-08 ─► INV-02, INV-04, INV-05, INV-06 ;  INV-01 (evidence received) ─► INV-02
DEC-07 ─► N01-01 ─► N01-02
DEC-10 ─► FIV-01 ─► FIV-02 ─► FIV-03
DEC-20 ─► SEC-03 ─► SEC-04 (needs ENB-01/02)
DEC-19 ─► LA1-01 ; LA1-02 (ready) ─► LA1 evidence
DEC-16 ─► ACC-03 ;  DEC-06 ─► ACC-05 ─► HR-03 fixtures ;  DEC-14/15 ─► ACC-09 ─► ACC-10
P0H/P0M ─► P0-GATE ─► Phase 1 build ─► P1-GATE ─► Phase 2 (REL-01 first)
```

## 14. Status roll-up (computed from the tables)

**Counting basis.** Distinct package IDs with ranges expanded: **94 distinct IDs = 89 packages with an allowed status + 5 aliases** (aliases carry no status of their own and no separate closure). Earlier figures quoted in conversation ("86 rows / 81 with a status") were table-row counts, not package counts (`WP-P0M-01…06` is one row; two gate rows were missed by the counting pattern); the content of the register did not change because of that. The count changed from 93 to 94 only because `WP-LA1-03` was added in this correction. The single `(excluded)` row in the N01 table is a scope note, not a package.

| Status | Packages | IDs |
|---|---|---|
| READY FOR PLANNING | 23 | WP-GOV-01, WP-DOC-01, WP-INV-03, WP-INV-07, WP-VER-01, WP-VER-04, WP-P0H-01, WP-P0H-02, WP-P0H-03, WP-P0H-04, WP-P0H-05, WP-P0H-06, WP-P0H-07, WP-P0H-08, WP-P0H-09, WP-P0M-01, WP-P0M-02, WP-P0M-03, WP-P0M-04, WP-P0M-05, WP-P0M-06, WP-ENB-01, WP-ARCH-01 |
| READY FOR IMPLEMENTATION | 9 | WP-DOC-02, WP-AUD-01, WP-PAY-01, WP-SEC-01, WP-SEC-02, WP-LA1-02, WP-LA1-03, WP-VER-03, WP-ACC-01 |
| BLOCKED | 33 | WP-AUD-05, WP-PAY-02, WP-PAY-03, WP-PAY-04, WP-PAY-05, WP-PAY-06, WP-COM-01, WP-INV-02, WP-N01-01, WP-FIV-01, WP-FIV-03, WP-SEC-03, WP-SEC-04, WP-SEC-05, WP-SEC-06, WP-LA1-01, WP-ACC-03, WP-ACC-05, WP-ACC-07, WP-ACC-08, WP-ACC-09, WP-HR-04, WP-HR-05, WP-HR-07, WP-REL-01, WP-P2-02, WP-P2-03, WP-P2-04, WP-P2-05, WP-P2-06, WP-P2-07, WP-P2-08, WP-P2-09 |
| AWAITING EVIDENCE | 24 | WP-AUD-02, WP-AUD-03, WP-AUD-04, WP-AUD-06, WP-AUD-07, WP-PAY-07, WP-PAY-08, WP-INV-01, WP-INV-04, WP-INV-05, WP-INV-06, WP-INV-08, WP-N01-02, WP-FIV-02, WP-VER-02, WP-ACC-04, WP-ACC-06, WP-ACC-10, WP-HR-03, WP-HR-08, WP-P1-01, WP-ENB-02, WP-P0-GATE, WP-P1-GATE |
| Alias / tracked elsewhere | 5 | WP-VER-05, WP-ACC-02, WP-HR-01, WP-HR-02, WP-HR-06 |
| **Total distinct IDs** | **94** | |

## 15. Consistency notes

- Every finding PA-01…PA-42 is mapped in the plan §4 (checked by script); every DEC-xx cited here is defined in the decision brief.
- No package is READY FOR IMPLEMENTATION if an unresolved accounting policy, safety boundary, required authorisation or essential technical fact would make it speculative: e.g. AUD-03 (DEC-01), PAY-03/04 (DEC-03/04), HR-05 (DEC-05), INV-04..06 (DEC-08), ACC-03 (DEC-16) are BLOCKED.
- Packages marked READY FOR IMPLEMENTATION are read-only analyses, reviews, documentation or verification artefacts (GOV excluded); none changes product code, schema, UI, permissions or configuration.
- Aliases (WP-ACC-02, HR-01, HR-02, HR-06) point to the owning stream and carry no separate status or closure.
