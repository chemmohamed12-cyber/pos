# DAII — Master Execution Plan — 2026-10-11

**Status: PROPOSED for CTO review; not yet the approved execution baseline. It authorises no implementation, no schema/UI/permission/configuration change, no production or hosting access and no release.** Release status: **NOT APPROVED**.
Part A of the planning package. Companions: `DAII-WORK-PACKAGE-DEPENDENCY-REGISTER-2026-10-11.md` (B, per-package detail) and `DAII-CTO-DECISIONS-AND-BLOCKERS-2026-10-11.md` (C, decisions DEC-01…DEC-24).
**Single source of truth.** Strategy remains in `DAII-MASTER-DEVELOPMENT-ROADMAP-2026-10-11.md` (`50b3fc1`); this plan **refines** it into stable, dependency-aware work packages and does not compete with it. The roadmap's working labels are mapped to the stable WP IDs in §13; where this plan and the roadmap would differ, the difference is recorded in §12 with its evidence, not silently resolved. The six audit documents (`2c6ccf3`) and the Evidence Reconciliation Note (`fe77c01`) are immutable historical records; updates go in separate, traceable commits (WP-DOC-02).

## 1. Executive summary and planning assumptions

**What this plan does.** It sequences the work the audit says is needed: first make the integrity controls true (audit chain, payroll-to-ledger, reservations), then decide the policies that gate HR, then build and verify HR and Accounting end to end, then the rest of the ERP. It keeps each integrity stream separate so one closure never implies another.

**Priorities in one line each**
1. **Audit-chain integrity (PA-33)** — every rollback-heavy verification depends on it.
2. **Payroll ↔ GL ↔ Treasury integrity (PA-34/35/36)** — validate at runtime first, decide the accounting shape, then fix; HR is a Phase 1 target.
3. **N-02 reservation/inventory** — evidence exists on a clean snapshot; the independent review and the remaining findings are open.
4. **N-01** — recorded local-scope closure preserved; independent review requested; scope not expanded.
5. **Security, guards, dependencies, F-INV-001, LA-1** — triage and decisions first; no bulk upgrades.
6. **Phase 0 (HR, Manufacturing contracts only)** in parallel; **Phase 1 (HR + Accounting)**; **Phase 2**.

**Planning assumptions** (stated so they can be challenged)
- A1. Planning only: no product code, schema, UI, permission or configuration changes occur under this plan until the specific packages are approved.
- A2. Team 3 is read-only/independent; implementation belongs to the owning tracks; the other two teams continue their assignments and are not asked to stop or repeat work.
- A3. The guarded cluster is shared and serialised: every database-backed step needs a window agreed with the track that reserves it, on clean snapshots, with evidence headers pinned.
- A4. No dates are given; sizes are relative. Sequencing is by dependency and risk.
- A5. Business-owner inputs (accounting treatment, statutory rules, requirement scopes) will be supplied by named owners; Team 3 will not infer them.
- A6. Evidence is never merged across commits or classes; clean-snapshot, working-tree, blocked and unrun are always labelled.
- A7. The roadmap's phase sequence (Phase 0 → Phase 1 → Phase 2) and the "no rewrite unless evidence shows incremental remediation inadequate" rule are binding.

**State of the evidence at planning time** (audit cutoff `b591d1f`; no product-source change since): isolation specs 80/1/19 (committed report) and 90/9/1 (verification status record, now committed) are separate states of the same 100-spec population — 90 PASS is not 90 independently verified clean-snapshot passes (20 are clean-snapshot on `a6002fa`; 70 working-tree); N-01 PASS on clean `a6002fa` with owner-recorded local-scope closure, CTO sign-off pending; **N-02 fix now has clean-snapshot evidence on `b591d1f`** but no independent review; PA-33 reproduced on a clean snapshot; PA-34/35/36 are confirmed by code reading only; six adaptation diffs remain pending line-level review.

## 2. Evidence update log (reasons recorded; nothing rewritten)

| # | New evidence (source) | Effect on the plan | Historical documents |
|---|---|---|---|
| EV-1 | Clean-snapshot evidence for `b591d1f` committed by the verification track (`1dea0db`, `a33f769`): business suite T-00…T-22, T-20 H3 PASS in plain and transaction style, 16/16 reservation-path isolation specs, unit 59/430, guard 50/50; T-21 case H and T-22 rollback case FAIL-DEFECT (PA-33) | WP-INV-01 evidence received (review pending); PA-42 resolved for the N-02 part; PA-33 now confirmed on a clean snapshot (WP-AUD-01 reduces to a root-cause note); LA-1 Layer 2 has no dedicated clean-snapshot run in that set (the admission spec is not among the 16) → WP-LA1-02 | Audit documents keep "working-tree class" wording; corrected only by WP-DOC-02 |
| EV-2 | Verification status record committed (`a33f769`) | Trigger for WP-DOC-02 (PA-22 counts, F-02, scorecard) satisfied; the guard groups are now stated in a committed record (DEC-09) | Reconciliation note stays as written; DOC-02 adds Figure B with labels |
| EV-3 | No committed product-source change after `b591d1f` | Audit cutoff and findings remain valid | — |
| EV-4 | Observation at planning time (HEAD `a33f769`): **uncommitted** working-tree changes produced by session `cece860d` implement the audit-chain remediation (`audit.service.ts` draws `nextval` under the chain lock and hashes and inserts that same value explicitly; hash format and existing rows untouched; the returned entity is now built with `create` instead of `save`, a point for the reviewer), a new regression spec `t23-audit-seq-hash.biz.real-pg.spec.ts` (step T-23), an edit to the T-22 reproducer (+7 lines) and a `biz-run.js` registration (+1 line); T-22/T-23 run evidence is working-tree class (T-23 before the change 4 FAIL-DEFECT + 3 PASS, after 7 PASS; headers `a33f769` + 3 to 4 dirty paths). The change is not committed, not independently reviewed and not clean-snapshot verified; Team 3 neither commits, extends nor relies on it. **Authorization provenance:** a CTO directive delivered in that session (2026-10-11T04:46Z, "F-AUD-003 — authorized, narrowly scoped remediation") authorises local remediation with stated constraints (actual persisted sequence as hash input; no hash-format change; no rewrite, rehash or deletion of existing history; regression coverage for rollback, appends, concurrency and existing-chain verification; independent review and clean-snapshot evidence before closure). No repository-recorded authorization exists, and the CTO's planning directive to Team 3 states that the change is not authorized merely because it appeared in another working tree. Whether that earlier directive covers this exact change is for the CTO to confirm (DEC-01); until then it is treated as isolated, unreviewed work in progress. | WP-AUD-03/04 stay BLOCKED until the CTO confirms that the earlier directive covers this exact change (DEC-01); if confirmed and the owning track commits and publishes clean-snapshot evidence, intake rule §10 applies and AUD-06/07 become actionable; the change must still go through independent review, and already-broken chains stay a separate decision (DEC-02) | — |
| EV-5 | N-02 independent review: no reviewer conclusion is committed; the committed N-02 report §7 lists it as outstanding. The CTO directive delivered in session `cece860d` (2026-10-11T04:46Z) does not pre-accept another session's review and requires demonstrated independence, the exact fix commit and tested snapshot, code and evidence inspection (lock ordering, transaction ownership, re-read after lock, rollback, retries, duplicate movements, reservation consistency, deadlocks), documented limitations and an explicit statement on the fulfillReservation criteria | WP-INV-02 stays BLOCKED on DEC-08 (reviewer naming) and now carries these review criteria; N-02 as a whole stays OPEN | — |
| (future) | Any new result from the other teams | Intake rule in §10: record source, commit, class; change status only per closure criteria; note the reason here | — |

## 3. Prioritised work packages (stable IDs; detail in the register)

**Wave 0 — now, no further approval beyond approving this baseline (WP-GOV-01):** read-only analysis, reviews, documentation, verification artefacts.
`WP-GOV-01` · `WP-DOC-02` · `WP-AUD-01` · `WP-PAY-01` · `WP-SEC-01` · `WP-SEC-02` · `WP-LA1-02` · `WP-VER-03` · `WP-ACC-01` (READY FOR IMPLEMENTATION) and planning-ready: `WP-DOC-01`, `WP-INV-03`, `WP-INV-07`, `WP-VER-01`, `WP-VER-04`, `WP-ENB-01`, `WP-ARCH-01`, Phase 0 contract drafting `WP-P0H-01…09`, `WP-P0M-01…06`. "READY FOR IMPLEMENTATION" here never means a product-code change.

**Wave 1 — P0 streams, each unblocked by a named decision or result**
| Stream | Packages in order | Unblocked by |
|---|---|---|
| AUD (PA-33) | AUD-02 → AUD-03 → AUD-04 → AUD-05 → AUD-06 → AUD-07 | DEC-01 (fix), DEC-02 + AUD-02 (history policy) |
| PAY (PA-34/35/36) | PAY-01 → PAY-02 → PAY-03 → PAY-04 → PAY-05 → PAY-06 → PAY-07 → PAY-08 | PAY-01 result; DEC-03, DEC-04 |
| INV (N-02) | INV-01 (received) → INV-02 (review) ; INV-03 reach test ; INV-04/05/06 fixes ; INV-07 fixture ; INV-08 (after AUD) | DEC-08 |
| N01 | N01-01 → N01-02 | DEC-07 |
| FIV | FIV-01 → FIV-02 → FIV-03 | DEC-10 |
| SEC | SEC-01/02 (now) → SEC-03 → SEC-04 ; SEC-05 ; SEC-06 | DEC-20, DEC-09, host access |
| LA1 | LA1-02 (now) ; LA1-01 | DEC-19 |

**Wave 2 — Phase 0 exit:** `WP-P0H-01…09`, `WP-P0M-01…06` signed or deferred with owners → `WP-P0-GATE`. Phase 0 contains documents only.

**Wave 3 — Phase 1 build and verification:** Accounting `WP-ACC-01…10`; HR `WP-HR-03…05, 07, 08`, `WP-COM-01`; integrated `WP-P1-01`; enablers `WP-VER-01/02/04`, `WP-ENB-01/02`. Aliases `WP-ACC-02`, `WP-HR-01/02/06` point to PAY, AUD/ACC-05 and COM-01.

**Wave 4 — gate:** `WP-P1-GATE` (§9).

**Phase 2 (after the Phase 1 gate):** `WP-REL-01` first, then `WP-P2-02…09`.

**Critical path.** DEC-03/04 and DEC-05 (policy) gate the largest HR work; DEC-01 gates the audit-chain fix on which every rollback-sensitive verification depends; cluster windows gate every runtime proof. The work that does not wait: PAY-01 preparation, AUD-01 note, SEC-01/02, VER-03, ACC-01, DOC-02, Phase 0 drafting.

## 4. Finding → work package mapping (all 42; none left unmapped)

| Finding | Work package(s) | Finding | Work package(s) |
|---|---|---|---|
| PA-01 | ACC-09 (+ DEC-14) | PA-22 | SEC-05, VER-02, ENB-02, DOC-02 |
| PA-02 | P2-02 | PA-23 | VER-04, ENB-01, HR-08 |
| PA-03 | VER-01, ACC-10 | PA-24 | REL-01 |
| PA-04 | INV-01, INV-02, INV-03 | PA-25 | SEC-01, SEC-03, SEC-04, SEC-06 |
| PA-05 | INV-04, INV-05, INV-06, INV-07 | PA-26 | REL-01 |
| PA-06 | P2-04, P0M-04 | PA-27 | DOC-01 |
| PA-07 | P2-04, P0M-02 | PA-28 | ARCH-01 |
| PA-08 | ACC-09 (+ DEC-15) | PA-29 | SEC-02, FIV-01…03 |
| PA-09 | ACC-04, HR-07, P0H-06 | PA-30 | REL-01 (needs AUD) |
| PA-10 | ACC-03 (+ DEC-16) | PA-31 | P2-05, P2-09, P0M-01/05 |
| PA-11 | ACC-08 | PA-32 | ACC-01 |
| PA-12 | P2-06 | PA-33 | AUD-01…07, INV-08 |
| PA-13 | ACC-06 (+ DEC-13) | PA-34 | PAY-01…08, P0H-04, HR-07 |
| PA-14 | ACC-05, HR-03, P0H-05 | PA-35 | PAY-01…08, COM-01, P0H-04 |
| PA-15 | P2-07 (+ DEC-18) | PA-36 | PAY-01, PAY-04, PAY-05 |
| PA-16 | P0H-01/03, HR-05 | PA-37 | P0H-02, HR-04, HR-05 |
| PA-17 | HR-03, P1-01 | PA-38 | COM-01, P0H-08 |
| PA-18 | P2-03 | PA-39 | ACC-07 (+ DEC-17) |
| PA-19 | P2-09 | PA-40 | P0H-07, HR-04, P2-08 |
| PA-20 | P2-07 (+ DEC-12) | PA-41 | LA1-01, LA1-02 |
| PA-21 | N01-01, N01-02 | PA-42 | INV-01 (N-02 part, evidence received), LA1-02 (Layer 2 part), DOC-02 |
No finding is deferred without a package; findings whose package is Phase 2 are deferred to Phase 2 by the approved sequence, with the reason in §3.

## 5. Dependencies, blockers, owners, required decisions

The full dependency graph is in the register §13 and the per-package prerequisites in register §§1–12. The decision for each blocker, its owner, options and consequence of deferral are in the decision brief. Owner roles: *Implementer* (owning track), *Verification track* (Team 2 verification session), *Independent reviewer* (not the change's author, not an evidence producer), *Team 3* (read-only analysis/planning), *CTO / business owners* (decisions). Concrete assignments are for the CTO; this plan names roles only.

## 6. Scope boundaries and explicit exclusions

**In scope for execution once approved:** the packages in the register, each limited to its stated artefacts.
**Explicitly excluded**
- Any product-code, schema, migration, UI, permission or configuration change under this planning assignment and under Phase 0 at any time.
- N-01: multi-instance, hosting and production behaviour (separate package WP-REL-01 if wanted); no reopening because an older report predates the fix.
- Merging streams: closure of N-02, PA-33, payroll/GL/Treasury, N-01, F-INV-001 or security/dependencies never implies another's closure.
- F-INV-001: the HTTP 410 behaviour change stays unapproved for release until WP-FIV-01/02 complete.
- Security: no bulk upgrades, no manifest or lockfile change outside an approved scope (DEC-20).
- Protected items: `company-audit-access.real-pg.spec.ts` (NOT RUN, untouched), LA-1 files and protected baselines, guard policy (unchanged unless explicitly decided under DEC-09).
- Statutory payroll rules, accounting policy and financial behaviour: not invented; recorded as decisions (DEC-03/04/05/14/15/16/17).
- Production or hosting access; destructive operations; a full rewrite.
- A numeric quality score (DEC-21).

## 7. Acceptance criteria and evidence rules

**Rules for every package.** (1) Closure needs the package's own acceptance criteria met on a clean snapshot of a named commit, evidence header pinned with `dirtyPaths: []`. (2) Results are labelled clean-snapshot / working-tree / blocked / unrun and never merged across commits. (3) A skipped, blocked or unexecuted test is not a pass. (4) CR findings become confirmed only after a runtime demonstration. (5) The reviewer of a gate is not the author of the change. (6) Each package states its tests in the register; new primitives that take locks need a plain-manager concurrency probe.

**Key acceptance criteria per stream (detail in the register):**
| Stream | Criteria that must hold |
|---|---|
| AUD | `verifyCompanyChain` valid after every rollback scenario; stored `seq` = hashed `seq` for 100 % of test writes; concurrent writers with interleaved rollbacks give one valid chain; no existing hash changes; existing-history policy executed (DEC-02) |
| PAY | Σ run lines = Σ journal = Σ cash paid for randomised cent amounts; Wages Payable = undisbursed net; no duplicate posting or payment under replay, retry, concurrency or partial failure; rollback leaves consistent state; payroll in the oracle (R11); cash/bank reconciliation clean; A/B isolation |
| INV | Exactly one dispatch per reservation under ≥ 8-way concurrency (plain and transaction); retries refused without side effect; rollback restores quantities; no negative stock; audit-chain case passes after AUD; H1 cap never exceeded; H2 releases ≤ reserved; H4 no database error; H5 transition limits hold |
| N01 | Reviewer's written conclusion; scope unchanged |
| FIV | Usage evidence for every Company; compatibility conclusion; release decision recorded |
| SEC | Every runtime-reachable advisory has a reachability verdict and a targeted change/test/rollback; runtime critical = 0 after approved T1; guards unchanged; role × route tests for any gap |
| LA1 | A real-Postgres spec per wired site; "a path opens a Company DataSource without admission" no longer true |
| Phase 1 | See §9 |

## 8. Independent-review and closure requirements

| Workstream | What closes it | What it does **not** close | Independent reviewer needed |
|---|---|---|---|
| N-02 (fulfil part) | INV-01 evidence reviewed (INV-02) and criteria met | PA-33; H1/H2/H4/H5 (each closes on its own criteria); N-01 | Yes (DEC-08) |
| N-02 remainder | each of H1, H2, H4, H5 on its own tests | the fulfil part | Yes |
| PA-33 | AUD-04/06 acceptance + AUD-07 review + history policy (AUD-05) | N-02; payroll integrity | Yes |
| PAY (PA-34/35/36) | PAY-05/06/07 acceptance + PAY-08 review | PA-33; statutory payroll (HR-05) | Yes |
| N-01 | already recorded for local scope; WP-N01-01 review conclusion | multi-instance/hosting/production; N-02 | Yes (DEC-07) |
| F-INV-001 | FIV-01/02 evidence + FIV-03 release decision | anything else | Reviewer of the operator evidence |
| SEC | SEC-01/03/05/06 per approved scope | release approval | Yes |
Every conclusion is recorded in the package report with the evidence it examined. A reviewer who disagrees keeps the package open.

## 9. Phase gates and exit criteria

### 9.1 Phase 0 — HR and Manufacturing contracts only
Scope: domain boundaries, data ownership, workflow contracts, financial-event contracts, authorization requirements, failure/recovery behaviour and acceptance scenarios for each contract (WP-P0H-01…09, WP-P0M-01…06). **Exit (WP-P0-GATE):** each contract signed by the CTO or deferred with a named owner; open policy questions listed with owner and blocked package; **no code, schema, UI, permission or configuration artefact exists for these contracts.** Contracts that need policy (DEC-03/04/05/06/23/24, DEC-18/22) may exit as "signed with explicit open items" only if the open items do not make an implementation package speculative.

### 9.2 Phase 1 — HR and Accounting (integrated plan)
Entry: Phase 0 exit; P0 streams at least at the state the gate allows (see 9.3). The integrated plan covers each element the CTO named; policy-dependent items are tagged with their decision.

| Element | What is planned | Packages | Key checks | Policy dependencies |
|---|---|---|---|---|
| Attendance facts | Import/mapping/approval verified with clean-snapshot evidence and browser checks; approved days as the only payroll input (read contract) | HR-08, HR-04 | idempotent re-import; unmapped queues; approval-batch immutability; business-date fixtures | DEC-06 |
| Targets / performance | Targets approval verified; date derivation under the business-date rule; non-sales performance management stays Phase 2 (unspecified) | HR-08, ACC-05, P2-08 | approved target for a date at 23:30–03:30 Cairo | DEC-06, DEC-18 |
| Commissions | Policy → result → approval → adjustment verified; reversal/queue; GL recognition via payroll; cut-off against in-flight adjustments | COM-01, HR-03, HR-08 | replay of invoice/collection events creates no duplicate result; void/return/credit cases | DEC-04 |
| Payroll | Statutory computation, rules, payslip on top of the corrected ledger path | PAY-*, HR-05, HR-04 | golden fixtures per rule; immutability after posting; adjustments only | DEC-03, 05, 23 |
| General Ledger | Posting amount per contract; disbursement entry; period gate; control accounts | PAY-04, P0H-04, ACC-07 | journals balanced; amounts equal lines; posting gate on closed periods | DEC-03, 04, 17 |
| Treasury | Disbursement lock, duplicate guard, partial/failed disbursement, batch/instrument, statement matching | PAY-04/05, HR-07, ACC-04 | no duplicate payment; rejection/re-issue; cash/bank reconciliation | DEC-24 |
| Auditability | Audit record per action; chain valid under rollback | AUD-*, PAY-05 | chain verification after failure scenarios | DEC-01, 02 |
| Idempotency | Event keys (run id + line id); replay safe; retry-after-failure | PAY-03/05, COM-01 | duplicate dispatch tests | DEC-03 |
| Reconciliation | R1–R10 plus payroll R11; payroll gap detector; wages-payable | PAY-06, HR-07, ACC-01 | Σ lines = Σ journal = Σ cash | DEC-03 |
| Period-close controls | Closing audit category for unposted/undisbursed runs; snapshot includes payroll balances; reopen effects; year-end approach | HR-07, ACC-03, P1-01 | close blocked/flagged per policy; statements unchanged by close | DEC-16 and the close policy for payroll (part of DEC-03) |

Build order inside Phase 1: **1A** ledger and integrity (PAY, AUD, INV closure); **1B** test net (ACC-01, VER-01/04, HR-03, ENB-01); **1C** HR master and rules (HR-04, HR-05 after contracts); **1D** commission and treasury (COM-01, HR-07, ACC-04); **1E** integrated scenario (P1-01) and gate.

### 9.3 Phase 1 exit gate (WP-P1-GATE) — all must hold
1. HR and Accounting each meet their exit criteria on a clean snapshot of a named commit; headers pinned; no other track's uncommitted files in the tested tree.
2. No open High finding in HR or Accounting; Medium findings have owners.
3. P0 streams: AUD closed with independent review; PAY closed with independent review; INV fulfil part independently reviewed and the remainder closed or explicitly accepted; N01 review recorded.
4. Integrated scenario P1-01 PASS with reconciliation clean; integrated payroll E2E no longer BLOCKED and extended with journal-amount and post-disbursement assertions.
5. Capability matrix updated with commit-tagged evidence; scorecard re-issued categorically (numeric only if DEC-21 approved).
6. The gate evidence is reviewed by someone other than the author of the changed code.
7. CTO internal acceptance recorded. **Internal acceptance is not production or release approval.**

### 9.4 Phase 2
Starts after the Phase 1 gate. Retains all security, data-integrity, independent-verification and release gates (register §0, roadmap §8). `WP-REL-01` (staging host, targets, multi-instance, restore/rollback drills, monitoring) is the first package and the precondition of any release discussion.

## 10. Parallel workstreams and coordination rules

| Track | Owns (this plan respects) | Team 3 role |
|---|---|---|
| Verification track (Team 2) | Cluster windows, clean-snapshot evidence, guard-related runs, status records | Consume results; never ask to repeat; record dependencies |
| Implementation/foundation track | Product-code changes once authorised; N-01/N-02 code | Plan, review inputs, not parallel implementation |
| Team 3 | Audit, planning, coordination, read-only analysis | Independent; edits only its own documents |

**Coordination rules**
1. **Intake.** When a track publishes evidence, Team 3 records source commit, evidence class (clean-snapshot / working-tree / blocked / unrun), and what it changes in §2 of this plan; statuses move only per closure criteria.
2. **No silent rewrites.** Historical conclusions stay; changes are recorded with reason and evidence reference; documents already committed are updated only by a separate commit.
3. **Windows.** Database-backed steps are scheduled with the track that reserves the cluster; nothing is rerun that another track is running.
4. **Ownership.** Other tracks' files and work are not edited; protected files untouched; no guard weakening.
5. **Pending-result dependencies** are listed per package (register "Prerequisites") so the plan advances without overstating certainty.
6. **Decisions** are asked once, through the decision brief, with owner and consequence of deferral.
7. **Change control.** Any change to this plan or the register is a new dated version, committed separately, with the reason.

## 11. Unresolved questions and the evidence needed

| # | Question | Evidence needed to resolve | Where it lands |
|---|---|---|---|
| Q1 | Are PA-34/35/36 true at runtime? | WP-PAY-01 validation record | DEC-03/04 inputs |
| Q2 | Did Commission's `f2d15fa` fix the timezone failure? | Canonical serial regression on a clean commit (WP-HR-03) | PA-14/17 |
| Q3 | How many Companies already have broken audit chains and why? | WP-AUD-02 inventory | DEC-02 |
| Q4 | Was the race in `fulfillReservation` reachable through the delivery API? | WP-INV-03 HTTP reach test | PA-04 severity |
| Q5 | Does LA-1 Layer 2 as committed pass on a clean snapshot? | WP-LA1-02 | PA-41/42 |
| Q6 | Do the six pending adaptation diffs change only names/locations? | WP-VER-03 line-by-line review | DEC-09, PA-22 |
| Q7 | Which advisories are reachable at runtime? | WP-SEC-01 triage | DEC-20 |
| Q8 | Do the four controllers lacking Company/platform guards need one? | WP-SEC-02 | PA-29 |
| Q9 | What did ADR-071 intend for commission corrections and cut-off? | WP-COM-01 reading | DEC-04 |
| Q10 | What is the statutory rule set and who signs it? | Owner-supplied rules (DEC-05) | HR-05 |
| Q11 | What do external callers of the stock-movement endpoint do? | Operator evidence (DEC-10) | FIV-03 |
| Q12 | What matching rules should bank-statement reconciliation use? | A specification (none exists) | ACC-04 |
| Q13 | Does the F03 retry still hold after N-01's transaction-scope change? | WP-ACC-06 run on HEAD | DEC-13 |
| Q14 | Which requirements are real (quotation, lot/serial, FIFO/standard, FX revaluation, e-invoicing, HR contracts)? | Owner-signed scope per item (DEC-18) | Phase 0/2 ordering |
| Q15 | Is a frontend test runner chosen and how will browser E2E run in CI? | Strategy (WP-VER-04) | ENB-01 |

## 12. Material conflicts between the roadmap and new evidence

| # | Roadmap statement (`50b3fc1`) | New evidence | Resolution recorded here |
|---|---|---|---|
| X-1 | P0A-1: reproduce PA-33 on a clean snapshot (needs window); PA-33 "working-tree class" | `b591d1f` clean snapshot: T-22 rollback case FAIL-DEFECT | WP-AUD-01 reduces to a root-cause note; severity and priority unchanged; the audit documents' wording stays and is corrected by WP-DOC-02 |
| X-2 | P0C-1: clean-snapshot pipeline of the post-fix HEAD pending; PA-42 open | `b591d1f` clean-snapshot results committed | WP-INV-01 evidence received; review (INV-02) still pending; PA-42 remains open for the LA-1 part → WP-LA1-02 |
| X-3 | §12 item 1: Figure B "uncommitted" | Verification status record committed | WP-DOC-02 is unblocked; both historical figures remain |
| X-4 | Roadmap implies LA-1 verified through the same run | The 16 specs of the `b591d1f` run do not include the LA-1 admission spec | Not assumed; WP-LA1-02 |
| X-5 | Roadmap: the audit-chain fix awaits DEC-01 authorisation | Uncommitted implementation of the proposed fix and a T-23 regression spec observed in the working tree (EV-4) | Recorded, not relied on: no status change; an authorization record exists in the producing session (not in the repository) and conflicts in wording with the CTO's planning directive, so the CTO is asked to confirm (DEC-01) |
No evidence contradicts the priority order; none of the conflicts changes a dependency. Nothing is called closed that has not met its criteria.

## 13. Crosswalk (roadmap labels → stable IDs) and consistency checks

| Roadmap label | Stable ID | Roadmap label | Stable ID |
|---|---|---|---|
| P0A-1…P0A-7 | WP-AUD-01…07 | ACC-1…ACC-10 | WP-ACC-01…10 |
| P0B-1…P0B-8 | WP-PAY-01…08 | PH1-HR-1 / PH1-HR-2 | WP-HR-01 (alias PAY) / WP-HR-02 (alias AUD, ACC-05) |
| P0C-1…P0C-5 | WP-INV-01…08 (split per finding) | PH1-HR-3…7 | WP-HR-03, HR-04, HR-05, COM-01 (HR-06 alias), HR-07 |
| P0D-1…P0D-3 | WP-N01-01, N01-02 | ENB-1 / ENB-2 / DOC-1 / ARCH-1 | WP-ENB-01 / ENB-02 / DOC-01 / ARCH-01 |
| SEC-1…SEC-5 | WP-SEC-01…06, WP-LA1-01/02, WP-FIV-01…03 | REL-1 / PH2-2…9 | WP-REL-01 / WP-P2-02…09 |
| PH0-HR (H0-1…9) / PH0-MFG (M0-1…6) / PH0-GATE | WP-P0H-01…09 / WP-P0M-01…06 / WP-P0-GATE | (new in this plan) | WP-GOV-01, WP-DOC-02, WP-VER-01…05, WP-HR-08, WP-P1-01, WP-P1-GATE |

**Package count (reconciled):** 93 distinct package IDs = 88 with an allowed status (READY FOR PLANNING 23, READY FOR IMPLEMENTATION 8, BLOCKED 38, AWAITING EVIDENCE 19) + 5 aliases; earlier "86 / 81" figures were table-row counts, not package counts (register §14).

**Consistency checks performed (script and reading):** every PA-01…PA-42 appears in §4; every WP ID cited here exists in the register; every DEC cited exists in the decision brief and none is duplicated; Phase 0 contains documents only; no package is READY FOR IMPLEMENTATION where a pending policy, authorisation or essential fact would make it speculative; no stream's closure implies another's; N-01 is kept as "closed for the local scope by its owner, independent review requested"; N-02 and PA-33 are separate and open; release status NOT APPROVED.

**Proposed commit scope (documentation-only, after CTO review of these checks):** exactly three files — `DAII-MASTER-EXECUTION-PLAN-2026-10-11.md`, `DAII-WORK-PACKAGE-DEPENDENCY-REGISTER-2026-10-11.md`, `DAII-CTO-DECISIONS-AND-BLOCKERS-2026-10-11.md` — nothing else; not committed until approved.
