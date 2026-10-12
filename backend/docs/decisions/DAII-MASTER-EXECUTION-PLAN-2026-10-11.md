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

**State of the evidence at planning time** (audit cutoff `b591d1f`; no product-source change since): isolation specs 80/1/19 (committed report) and 90/9/1 (verification status record, now committed) are separate states of the same 100-spec population — 90 PASS is not 90 independently verified clean-snapshot passes (20 are clean-snapshot on `a6002fa`; 70 working-tree); N-01 PASS on clean `a6002fa` with owner-recorded local-scope closure, CTO sign-off pending; **N-02 fix now has clean-snapshot evidence on `b591d1f`** but no independent review; PA-33 reproduced on a clean snapshot, and its remediation (`c764fc5`) and the remaining N-02 remediation (`5c5b791`) are now committed but verified only on the working tree (clean-snapshot pipeline not yet published) and not independently accepted; PA-34/35/36 are confirmed by code reading only; six adaptation diffs remain pending line-level review.

## 2. Evidence update log (reasons recorded; nothing rewritten)

| # | New evidence (source) | Effect on the plan | Historical documents |
|---|---|---|---|
| EV-1 | Clean-snapshot evidence for `b591d1f` committed by the verification track (`1dea0db`, `a33f769`): business suite T-00…T-22, T-20 H3 PASS in plain and transaction style, 16/16 reservation-path isolation specs, unit 59/430, guard 50/50; T-21 case H and T-22 rollback case FAIL-DEFECT (PA-33) | WP-INV-01 evidence received (review pending); PA-42 resolved for the N-02 part; PA-33 now confirmed on a clean snapshot (WP-AUD-01 reduces to a root-cause note); LA-1 Layer 2 has no dedicated clean-snapshot run in that set (the admission spec is not among the 16) → WP-LA1-02 | Audit documents keep "working-tree class" wording; corrected only by WP-DOC-02 |
| EV-2 | Verification status record committed (`a33f769`) | Trigger for WP-DOC-02 (PA-22 counts, F-02, scorecard) satisfied; the guard groups are now stated in a committed record (DEC-09) | Reconciliation note stays as written; DOC-02 adds Figure B with labels |
| EV-3 | No committed product-source change after `b591d1f` | Audit cutoff and findings remain valid | — |
| EV-4 | **PA-33 fix committed.** The audit-chain remediation was committed as `c764fc5` (2026-10-11 13:27, verification session `cece860d`): `audit.service.ts` draws `nextval` under the chain lock, hashes and stores that value; plus `t23-audit-seq-hash` spec and the T-22 extension. Authorization provenance: the CTO directive delivered in that session (2026-10-11T04:46Z, item 2, "F-AUD-003 — authorized, narrowly scoped remediation"); the CTO has now **confirmed that authorization narrowly**: it applies only if the actual diff conforms. Team 3 scope review (`DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md` (Team 3, uncommitted)): the committed diff conforms to each stated condition; it is working-tree-tested only (T-23: 4 FAIL-DEFECT + 3 PASS before, 7 PASS after), **not clean-snapshot verified and not independently accepted** (a partial peer review `89a0a2a` exists; its reviewer wrote `runInTransaction`). Existing broken chains are untouched (DEC-02 open) | WP-AUD-03/04 are implemented and move to AWAITING EVIDENCE; AUD-06 (clean snapshot) and AUD-07 (independent review) gate closure; AUD-05 (history policy) stays BLOCKED on DEC-02 | — |
| EV-5 | **N-02 reviews.** Two peer-session reviews are committed: `N-02-FULFIL-RESERVATION-INDEPENDENT-REVIEW-2026-10-11.md` (commit `c804845`) and `N-02-F-AUD-003-AND-REMAINING-INDEPENDENT-REVIEW-2026-10-11.md` (commits `89a0a2a`, `5104e1e`, `66c63b9`). Both state they are evidence for the CTO's decision, not an acceptance. **CTO ruling:** the disclosed conflict (the reviewer wrote the transaction rule the patch uses) means they do not satisfy the independent-review gate; a reviewer who authored neither the patch nor the rule is required. Review content (fulfil part): patch minimal and correct as written; lock key shared with reserve/release; re-read under the lock; deadlock concern raised → reproduced for same-warehouse overlap (case I, 12/24 deadlocks pre-fix, 0 after the sorted-key change); override-warehouse variant probed (case J, 0/24) and downgraded to not substantiated with an inferred edge; order-level repeat is now an idempotent no-op (asserted, case E2); T-03/T-04 re-run alone on a quiet cluster still open | WP-INV-02 BLOCKED on DEC-08 (reviewer to be named); WP-INV-01 carries the T-03/T-04 quiet-cluster re-run; WP-INV-03 carries the deadlock evidence; N-02 stays OPEN | — |
| EV-6 | **Remaining N-02 findings implemented.** `5c5b791` (H1 limit engine, H2 `releaseReservedQuantity`, H4 `ProcessEngine.start`, plus sorted up-front key locking in `fulfillReservationsForOrder`) with `t24` spec; working-tree results PASS; authorised by the CTO directive item 3; partial review found no defect; H5 shipment transitions remain BLOCKED; unprobed sibling methods (`relocateReservedStock`, `releaseReservedQuantityForReference`, `limit.service.check`) are NOT RUN | WP-INV-04/05/06 move to AWAITING EVIDENCE (clean snapshot, independent review); WP-INV-07 unchanged; each finding keeps its own acceptance; N-02 stays OPEN | — |
| EV-7 | **LA-1 / CI lint.** The CI script on clean snapshots of `a33f769` and `5c5b791` reports lint FAIL with 3 errors, all in LA-1 files from `60b9bdf`: `installation-audit.controller.ts` 5:10 `'RolesGuard'` and 6:10 `'RequireRole'` unused (`@typescript-eslint/no-unused-vars`); `company-lifecycle-admission.real-pg.spec.ts` 5:1 restricted cross-domain import of `preliminary-hold-expiry.scheduler`; plus 5 warnings (unused `eslint-disable`, not LA-1). All other steps pass (install, build, structure, doc links, unit 59/430, guard). Not attributed to N-02. Evidence preserved in `test-03/evidence/ci-run-n02-head-snapshot.log` and `ci-run-n02-final-head-snapshot.log` | New WP-LA1-03 (fix within the authorised LA-1 scope; CI not called green until it passes on the resulting tree); PA-41, PA-22 | The audit documents' "lint 0 errors" refers to earlier commits and is corrected only by WP-DOC-02 |
| EV-8 | **Commit provenance disclosure.** Commits `a798d9d` (N-02 `fulfillReservation` patch, specs, evidence) and `60b9bdf` (LA-1 Layer 2) were created by the Team 3 session (`9910b9fe`) at the user's instruction to commit the working tree (scope chosen: code and docs only), which swept the verification session's and the LA-1 track's uncommitted edits into those commits. The statements in the committed review and in the verification track's records that the committer "cannot be established" can therefore be answered: the Team 3 session ran `git commit` for both. Authorship of the patch content remains the verification session's and the LA-1 track's. Team 3 did not author the patch or `runInTransaction` but did read the diff while committing, which the CTO should weigh if Team 3 is considered as a reviewer | Recorded for the independence assessment (DEC-08); no status change | — |
| EV-9 | **Clean-snapshot pipeline for the tree `71e5f5e` published** (`f881e53`, corrected in `520f2e0`): business suite T-00…T-24 exit 0; T-21 13/13, T-23 7/7, T-24 10 PASS + H5 BLOCKED, T-20 8 PASS + H5 BLOCKED; 89 executed-PASS + 1 skipped (`t0-clean-company-baseline`, opt-in) + 1 FAIL (the known 5544-pinned BLOCKED spec) of 91 isolation specs; unit 59/430; guard 50/50; headers pinned, `dirtyPaths: []`. It verifies that **tree** (which contains `a798d9d`, `c764fc5`, `5c5b791`, the LA-1 commit `60b9bdf` and the reviewers' documents), for the scenarios run only; it is not an independent review and not a verification of any commit alone | WP-AUD-06 and WP-INV-01/04/05/06 evidence received (statuses stay AWAITING EVIDENCE for independent review and, for T-03/T-04, the dedicated quiet re-run); PA-42 resolved for the N-02/PA-33 code; LA-1 Layer 2 code is in the tree but its own specs are not named in the run (WP-LA1-02) | Audit documents keep their wording; corrected only by WP-DOC-02 |
| EV-10 | **CTO decisions of 2026-10-11 (nine items).** (1) N-02 OPEN: needs clean-snapshot evidence on the commits concerned, an accepted independent review, and the remaining findings resolved or dispositioned by an approved decision. (2) PA-33 OPEN and separate: no historical-record change; clean-snapshot verification and an independent review covering sequence/hash correctness and rollback. (3) Reviewer independence: no connection to writing the fix, the helper it uses or committing the changes; Team 3 documents and coordinates but does not certify independent closure. (4) LA-1 lint: the three errors go to the LA-1 owner as a separate change; Team 3 changes no product file; CI is not called green before it passes on the resulting tree. (5) Sequence-lag guard: no implementation; a proposal first. (6) Sibling probes: local tests allowed, no logic change. (7) H5 fixture: allowed, not a fix or closure. (8) T-03/T-04: not before the cluster is released and the pipeline has ended, then individually on a quiet cluster with evidence preserved. (9) Keep implementation, verification and independent review separate; working-tree results are never counted as clean-snapshot evidence; one path's result is never generalised | WP-AUD-07 and WP-INV-02 carry the independence rule; WP-LA1-03 referred to the LA-1 owner; new WP-AUD-08 (proposal), WP-INV-09 (sibling probes); WP-INV-07 READY FOR IMPLEMENTATION; WP-INV-01 carries the T-03/T-04 hold | — |
| EV-11 | **UUID-repair risk registered as a separate finding, PA-43** (CTO decision 2026-10-11). Code reading shows the active `src/database/uuid-repair.core.ts`, reached through the Release Center's Controlled Data Repair (`foundation/release/data-repair.service.ts:212`), executes `UPDATE "<table>" SET "<col>" = new WHERE "<col>" = old` for every `SOFT_REFERENCES` entry (line 461), and the list includes `audit_records.actorUserId` (line 116) and `audit_records.organizationId` (line 187); those columns are audit-hash inputs; no hash recomputation or chain check exists in that file. Whether any Company needs the repair, and whether any other safeguard applies in the full execution path, is unknown | New WP-AUD-09 (read-only trace and need check) and DEC-25 (policy); kept separate from PA-33 and from DEC-02; the repair is not run | The six audit documents (2c6ccf3) stay unchanged; PA-43 is carried in this plan §14 until WP-DOC-02 appends it to the audit register |
| EV-12 | **Documentation reference and WP-DOC-02 executed.** Latest documentation reference: `49cc7d5cb639cd492823a803019758fd2abe216e`. PA-43 is now also recorded in the audit register (addendum §6.1); status/evidence updates for PA-04, 05, 22, 33, 41, 42 are in register §6.2, matrix §8, scorecard §9, report §13 and reconciliation note §7. Original texts are unchanged (the diff is insertions only) | WP-DOC-02 executed (CTO acceptance pending); PA-43 now exists in both the audit register and this plan §14 | — |
| EV-13 | **Evidence intake: verification report `f37a87f` and reviewer re-run at `f881e53`, provenance verified.** SOURCE_COMMIT files: `71e5f5ecbff0…` and `f881e53aecf9…`; run headers: 23 of 23 at `71e5f5e` and 6 of 6 at `f881e53`, all `dirtyPaths: []`, clean snapshots; code identity of the two trees as stated by the verification report. The `T-03` step (spec `t03-t04-concurrency`) has **20 PASS entries** on the clean snapshots `71e5f5e` and `f881e53` (`dirtyPaths: []`, headers verified): 4 T-03 entries (N10, N25, N50, audit chain), 6 T-04 entries (N10, N25, T-04b, invariant, two chain checks) and 10 reconciliation entries R1–R10. T-04 therefore has results **inside the same documented run** but no separate individual run; whether the combined step satisfies decision 8 ("individually") is for the CTO. Isolation: 91 files run on `71e5f5e` (89 executed PASS, 1 skipped, 1 known-BLOCKED failure), attribution by folder (the log has no commit header). **Correction to EV-9:** the LA-1 admission spec IS in that 91-file run and passed; the scheduler specs and the protected `company-audit-access` spec are not | WP-INV-01 (T-03 step 20 PASS; T-04 inside the same run), WP-LA1-02 (partly received) updated; N-02, PA-33, PA-43 stay OPEN; no status is called closed | Historical counts kept in the reconciliation note §7.2 |
| EV-14 | **CTO decisions after Phase 1 (2026-10-11), five items.** (1) WP-DOC-02 accepted as documentation evidence, reference `563955434f06b6482de247f05d3857ef141cfcf5`; acceptance proves no actual damage in any Company. (2) T-04 must be run alone on a quiet cluster after conflicting runs have ended; T-03 is not repeated unless a new gap appears. (3) WP-AUD-09 step 2 authorised narrowly: read-only, non-production, approved access only, counts only; stop if no approved access. (4) DEC-08: the independence condition stands; the CTO has no person to name; the team coordinator must submit a qualified candidate before the closure review; neither Team 3 nor the fix authors may substitute. (5) DEC-25 interim policy: no UUID repair on a path that rewrites hashed audit fields until a chain-preserving handling is approved; no rewrite, re-hashing or normalisation of history in routine repair; the read-only check decides the need; a final decision follows. Official status unchanged: N-02 OPEN · PA-33 OPEN · PA-43 OPEN · CI NOT GREEN · RELEASE NOT APPROVED | WP-INV-01 (T-04 alone, READY FOR IMPLEMENTATION after a test-only split); WP-AUD-09 (trace done, protocol ready); new WP-REV-01 (reviewer nomination); DEC-25 interim; DEC-08 part (1) stays open | — |
| EV-15 | **New clean-snapshot evidence, provenance verified by Team 3 from the run headers.** `T-25` at `06ef615` (clean snapshot; `dirtyPaths: []`): 8 PASS, 1 FAIL-DEFECT (H5-D1, plain-manager pickup leaves partial custody). `T-26` at `9b52e46` (clean snapshot; `dirtyPaths: []`): 1 PASS, 2 FAIL-DEFECT (sequence-lag: loud duplicate key; silent out-of-order append). Pre-fix baseline `T-24` at `961dacd` (clean snapshot) reproduces H1, H2, H4 (5 FAIL-DEFECT). **Observed, not evidence:** an uncommitted product change in the working tree (`shipment.service.ts`, H5-D1) | WP-INV-07 measured; new WP-INV-10 (H5-D1 fix, BLOCKED on explicit authorization confirmation); WP-AUD-08 baseline step done; independent-review pack index updated (WP-REV-01) | — |
| EV-16 | **CTO closeout directive of 2026-10-11 (documentation reference `c22f193`).** (1) WP-INV-10 (H5-D1) AUTHORIZED within the specified scope; fix already committed as `03900acb`; Team 3 checked the actual diff (an import and one changed statement (+4/−1 lines including comments) in `shipment.service.ts` using the existing `runInTransaction`; test case H5-3b; a regression-spec list; nothing in schema, permissions or shared infrastructure) and corrected the register state to IMPLEMENTED / VERIFICATION PENDING (roll-up status AWAITING EVIDENCE); **no clean-snapshot evidence of the fix exists yet**. (2) Reviewer: the coordinator appoints now; no name received. (3) T-04 alone after a test-only split: verification track, not run. (4) WP-AUD-09 step 2: Audit/Architecture track, requires approved read-only role and database list; stops without them. (5) WP-AUD-08: design delivered (`DAII-WP-AUD-08-SEQUENCE-LAG-GUARD-DESIGN-2026-10-11.md`), nothing implemented. (6) DEC-25 interim policy stands; final recommendation after WP-AUD-09 results. (7) LA-1 lint with its owner | WP-INV-10 state corrected; WP-AUD-08 design recorded; register count unchanged at 99 IDs; N-02, PA-33, PA-43 stay OPEN; CI NOT GREEN; release NOT APPROVED | — |
| EV-17 | **WP-INV-10 evidence intake and second CTO directive of 2026-10-11 (after `a5e656a`).** Commit `29e0247` published the clean-snapshot evidence of `03900acb`; provenance verified by Team 3 (header commit, `dirtyPaths: []`, manifest sha256 OK, cleanup complete). T-25 11 of 11 PASS (H5-1 and H5-2 8-way concurrent pickup/deliver, plain and transaction, one winner and seven 409; H5-3 custody failure all-or-nothing in both styles — the previously failing plain-manager case now PASS; H5-3b no reservation lost (6 → 6) and retry succeeds, both styles; H5-4 outer rollback; H5-5 legal end-to-end; H5-6 illegal and unauthorized refused without side effects); regression list 6 of 6 PASS (`reg.log`); unit 59 suites / 430 tests; guard 50 of 50. Limits: the T-25 test doubles (recorder event bus, fixed order contracts) bound the claim to the tested shape; event effects are asserted through the recorder (`deliveredEventsPublished`) and not through a real outbox; the evidence was produced by the verification track that wrote the fix, so it is VERIFIED (author-run), not independently accepted. The same commit adds the verification track's own WP-AUD-08 design and an evidence pack under `test-program/`; the pack states that its author is not eligible as reviewer, consistent with the independence register. The directive's other tracks (T-04 alone, lint, reviewer, WP-AUD-09) have produced no evidence yet | WP-INV-10: IMPLEMENTED and VERIFIED (author's track), INDEPENDENT REVIEW PENDING; WP-AUD-08: two designs for the decision; N-02, PA-33, PA-43 OPEN; CI NOT GREEN; release NOT APPROVED | — |
| EV-18 | **Mandatory Sequential Closeout Directive; single closeout report `DAII-CONSOLIDATED-CLOSEOUT-REPORT-2026-10-11.md` (HEAD `1b694f5`).** State found: no T-04 split or run, no LA-1 fix, no reviewer, no WP-AUD-09 approval. Team 3 re-ran `npm run lint` read-only on the clean tree at `1b694f5`: 3 errors, 5 warnings (unchanged; working-tree run). WP-INV-10 coverage reviewed against the published evidence (no re-run). DEC-01b single recommendation and the WP-AUD-09 approval request prepared | No package changed status; N-02, PA-33, PA-43 OPEN; CI NOT GREEN; release NOT APPROVED | — |
| EV-19 | **CTO decision of 2026-10-12: WP-REV-01 deferred.** Independent review waits for a qualified engineer; no substitute reviewer, no claim of review; pack (index, register, companion pack, evidence folders including H5-D1) preserved; other authorized work continues without waiting; independent acceptance recorded as pending | WP-REV-01 held as a deferred item (roll-up status BLOCKED, counts unchanged); N-02, PA-33, PA-43 OPEN; CI NOT GREEN; release NOT APPROVED | — |
| EV-20 | **Observed at HEAD `f42c6ba`:** `d202f2c` (T-04 split, test-only) and `e344ca1` (sequence-lag guard, option A, product change in `audit.service.ts`). `e344ca1` — `feat(WP-AUD-08)`: the audit sequence-lag guard implemented as **option A** in `audit.service.ts` (head read now selects `seq`; on `nextval ≤ tailSeq` it calls `setval(seq, tailSeq, true)`, draws again, throws `AuditSequenceLagError` if still not ahead, logs a warning; +26/−3 lines) with spec `t27-audit-seq-lag-guard` and a `biz-run.js` registration. **No CTO approval of option A, and no authorization to implement, is recorded in the repository or in the directives Team 3 received; the CTO had reserved the choice ("no implementation before an explicit decision"), and the author's own closeout report (`4e90b7a`, 4 minutes earlier) says "awaiting CTO option; nothing implemented".** It differs from Team 3's recommendation (fail-closed pre-check) and has no audit record of the realignment (warning log only). It is **IMPLEMENTED, not verified** (no clean-snapshot evidence of T-27), not reviewed, and **not approved**; the CTO is asked to confirm whether it is authorized or must be withdrawn before any further work builds on it. | WP-INV-01: split implemented, run pending; WP-AUD-08: implemented without a recorded approval — flagged to the CTO; PA-33 stays OPEN | — |
| EV-21 | **CTO ruling and sequential directive of 2026-10-12.** (1) WP-AUD-08: Option A (`e344ca1`) not approved; preserved, not reverted; Option B restoration specified in `DAII-WP-AUD-08-OPTION-B-RESTORATION-IMPACT-AND-CHANGE-SPECIFICATION-2026-10-12.md` (impact I1–I8, minimal change, test plan T-28, evidence requirements); to be applied and verified by the verification track. (2) T-04: run alone from `d202f2c` with `DAII_T0304_PART`. (3) WP-REV-01 stays deferred. (4) LA-1 owner fixes lint and re-runs CI. (5) WP-AUD-09: no database access until the read-only role and explicit non-production list are approved. Team 3 applied none of these product or test changes | WP-AUD-08 BLOCKED pending the correcting commit; WP-INV-01 ready for the individual run; PA-33 OPEN | — |
| EV-22 | **Directive "Execute Remaining Verification Work" and evidence intake `63c44db`.** Runbook drafted (`DAII-RUNBOOK-AUDIT-SEQUENCE-LAG-2026-10-12.md`, DRAFT, not approved): when appends are blocked, what is stopped, escalation levels, read-only diagnosis, the authorised-remediation template (advisory-lock-guarded `setval` to `max(seq)`, designated DBA and written approval first), post-remediation verification, prohibitions; no person is named. Evidence intake `63c44db` (folder `e344ca1-wp-aud-08/`, all run headers `e344ca1`, `dirtyPaths: []`, clean-git-archive-snapshot, manifests OK): this evidence is for **Option A as committed in `e344ca1` (not approved)** — T-21 13 PASS, T-23 7 PASS, T-27 6 PASS, T-26 3 PASS (Option-A expectations), T-22 2 PASS + 1 FAIL-DEFECT (the by-design characterisation `F-AUD-003-X`), unit 59/430, guard 50/50, isolation regression interrupted at 64 of 92 with 0 failures. It is **not** evidence for Option B and does not verify the corrected behaviour. The Option B correcting commit, T-28 and the individual T-04 run are not yet published at HEAD `63c44db`; LA-1 lint fix not published | No status change; PA-33 OPEN; WP-AUD-08 BLOCKED pending the Option B commit and its clean-snapshot evidence | — |
| EV-23 | **Directive "Execution Continuation" (reference `61caf8a`) and state at HEAD `a491c47`.** No Option B commit, T-28 evidence, individual T-04 result or LA-1 fix is published yet. **Contradiction found at HEAD `a491c47` (verification session, committed after the CTO ruling `70939df`):** `test-program/CLOSEOUT-REPORT-2026-10-11.md` (update section) is headed "DEC-01b approved: option A" and states WP-AUD-08 as IMPLEMENTED and VERIFIED; and `test-program/INDEPENDENT-REVIEW-EVIDENCE-PACK-2026-10-11.md` adds `e344ca1` ("DEC-01b A") to the review scope. **The CTO ruled on 2026-10-12 that Option A is NOT approved and that Option B (fail closed, no automatic realignment) must be restored.** Team 3's records are authoritative on this point: no approval of Option A exists; the evidence in `63c44db` verifies the Option A code only; the review scope for the guard must be the Option B commit once it exists, with `e344ca1` kept as history. Those two documents should be corrected by their author; Team 3 does not edit them. The same update says the T-04 run is being done by the "external-review session" (which declared a conflict of independence for the N-02 and PA-33 patches and is limited to evidence audit — not a reviewer) and that the isolation regression of `e344ca1` stopped at 64 of 91 with 0 failures (27 not run; not counted as passed) | WP-AUD-08 stays BLOCKED (Option B not implemented); WP-INV-01 individual run pending; PA-33 OPEN; the runbook stays DRAFT and unexecutable (no names, no approved databases, no per-execution approval mechanism; an unexplained lag is a possible data-integrity incident) | — |
| (future) | Any new result from the other teams | Intake rule in §10: record source, commit, class; change status only per closure criteria; note the reason here | — |

## 3. Prioritised work packages (stable IDs; detail in the register)

**Wave 0 — now, no further approval beyond approving this baseline (WP-GOV-01):** read-only analysis, reviews, documentation, verification artefacts.
`WP-GOV-01` · `WP-DOC-02` · `WP-AUD-01` · `WP-PAY-01` · `WP-SEC-01` · `WP-SEC-02` · `WP-LA1-02` · `WP-VER-03` · `WP-ACC-01` (READY FOR IMPLEMENTATION) and planning-ready: `WP-DOC-01`, `WP-INV-03`, `WP-INV-07`, `WP-VER-01`, `WP-VER-04`, `WP-ENB-01`, `WP-ARCH-01`, Phase 0 contract drafting `WP-P0H-01…09`, `WP-P0M-01…06`. "READY FOR IMPLEMENTATION" here never means a product-code change.

**Wave 1 — P0 streams, each unblocked by a named decision or result**
| Stream | Packages in order | Unblocked by |
|---|---|---|
| AUD (PA-33) | AUD-03/04 implemented (`c764fc5`) → AUD-06 (clean snapshot) → AUD-07 (independent review); AUD-02 → AUD-05 (history policy) | DEC-01 confirmed narrowly; DEC-02 + AUD-02 for history |
| PAY (PA-34/35/36) | PAY-01 → PAY-02 → PAY-03 → PAY-04 → PAY-05 → PAY-06 → PAY-07 → PAY-08 | PAY-01 result; DEC-03, DEC-04 |
| INV (N-02) | INV-01 (evidence received; T-03/T-04 individual quiet re-run open) → INV-02 (reviewer with no connection to the fix, helper or commits) ; INV-03 reach test + deadlock evidence ; INV-04/05/06 implemented (`5c5b791`), clean-snapshot evidence received for tree `71e5f5e`, independent review pending ; INV-07 H5 fixture and INV-09 sibling probes (authorised, no logic change) ; INV-08 | DEC-08 (reviewer) |
| N01 | N01-01 → N01-02 | DEC-07 |
| FIV | FIV-01 → FIV-02 → FIV-03 | DEC-10 |
| SEC | SEC-01/02 (now) → SEC-03 → SEC-04 ; SEC-05 ; SEC-06 | DEC-20, DEC-09, host access |
| LA1 | LA1-02 and LA1-03 (lint fix, authorised) ; LA1-01 | DEC-19 (for LA1-01) |

**Wave 2 — Phase 0 exit:** `WP-P0H-01…09`, `WP-P0M-01…06` signed or deferred with owners → `WP-P0-GATE`. Phase 0 contains documents only.

**Wave 3 — Phase 1 build and verification:** Accounting `WP-ACC-01…10`; HR `WP-HR-03…05, 07, 08`, `WP-COM-01`; integrated `WP-P1-01`; enablers `WP-VER-01/02/04`, `WP-ENB-01/02`. Aliases `WP-ACC-02`, `WP-HR-01/02/06` point to PAY, AUD/ACC-05 and COM-01.

**Wave 4 — gate:** `WP-P1-GATE` (§9).

**Phase 2 (after the Phase 1 gate):** `WP-REL-01` first, then `WP-P2-02…09`.

**Critical path.** DEC-03/04 and DEC-05 (policy) gate the largest HR work; DEC-01 gates the audit-chain fix on which every rollback-sensitive verification depends; cluster windows gate every runtime proof. The work that does not wait: PAY-01 preparation, AUD-01 note, SEC-01/02, VER-03, ACC-01, DOC-02, Phase 0 drafting.

## 4. Finding → work package mapping (all 42; none left unmapped)

| Finding | Work package(s) | Finding | Work package(s) |
|---|---|---|---|
| PA-01 | ACC-09 (+ DEC-14) | PA-22 | SEC-05, VER-02, ENB-02, LA1-03, DOC-02 |
| PA-02 | P2-02 | PA-23 | VER-04, ENB-01, HR-08 |
| PA-03 | VER-01, ACC-10 | PA-24 | REL-01 |
| PA-04 | INV-01, INV-02, INV-03, REV-01 | PA-25 | SEC-01, SEC-03, SEC-04, SEC-06 |
| PA-05 | INV-04, INV-05, INV-06, INV-07, INV-09, INV-10 | PA-26 | REL-01 |
| PA-06 | P2-04, P0M-04 | PA-27 | DOC-01 |
| PA-07 | P2-04, P0M-02 | PA-28 | ARCH-01 |
| PA-08 | ACC-09 (+ DEC-15) | PA-29 | SEC-02, FIV-01…03 |
| PA-09 | ACC-04, HR-07, P0H-06 | PA-30 | REL-01 (needs AUD) |
| PA-10 | ACC-03 (+ DEC-16) | PA-31 | P2-05, P2-09, P0M-01/05 |
| PA-11 | ACC-08 | PA-32 | ACC-01 |
| PA-12 | P2-06 | PA-33 | AUD-01…08, INV-08, REV-01 |
| PA-13 | ACC-06 (+ DEC-13) | PA-34 | PAY-01…08, P0H-04, HR-07 |
| PA-14 | ACC-05, HR-03, P0H-05 | PA-35 | PAY-01…08, COM-01, P0H-04 |
| PA-15 | P2-07 (+ DEC-18) | PA-36 | PAY-01, PAY-04, PAY-05 |
| PA-16 | P0H-01/03, HR-05 | PA-37 | P0H-02, HR-04, HR-05 |
| PA-17 | HR-03, P1-01 | PA-38 | COM-01, P0H-08 |
| PA-18 | P2-03 | PA-39 | ACC-07 (+ DEC-17) |
| PA-19 | P2-09 | PA-40 | P0H-07, HR-04, P2-08 |
| PA-20 | P2-07 (+ DEC-12) | PA-41 | LA1-01, LA1-02, LA1-03 |
| PA-21 | N01-01, N01-02 | PA-42 | INV-01 (N-02 part, evidence received), LA1-02 (Layer 2 part), DOC-02 |
| PA-43 (added after the audit cutoff; see §14) | AUD-09 (+ DEC-25) | | |
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
| X-5 | Roadmap: the audit-chain fix awaits DEC-01 authorisation | The fix was committed (`c764fc5`); the CTO confirmed the earlier authorization narrowly (conditional on conformity) | Recorded: Team 3 scope review finds conformity; closure still needs AUD-06/07; DEC-01 confirmed, DEC-02 open |
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

**Package count (reconciled):** 99 distinct package IDs = 94 with an allowed status (READY FOR PLANNING 22, READY FOR IMPLEMENTATION 10, BLOCKED 35, AWAITING EVIDENCE 27) + 5 aliases; the earlier "86 / 81" figures were table-row counts, not package counts (register §14); the count moved 93 → 94 → 96 → 97 → 99 only because WP-LA1-03, WP-INV-09, WP-AUD-08, WP-AUD-09, WP-INV-10 and WP-REV-01 were added.

**Consistency checks performed (script and reading):** every PA-01…PA-42 appears in §4; every WP ID cited here exists in the register; every DEC cited exists in the decision brief and none is duplicated; Phase 0 contains documents only; no package is READY FOR IMPLEMENTATION where a pending policy, authorisation or essential fact would make it speculative; no stream's closure implies another's; N-01 is kept as "closed for the local scope by its owner, independent review requested"; N-02 and PA-33 are separate and open; release status NOT APPROVED.

**Final status line (CTO, 2026-10-11): N-02 OPEN · PA-33 OPEN · CI NOT GREEN · RELEASE NOT APPROVED.**

**Commit scope (documentation-only):** the baseline commit `961dacd` contains exactly three files; this version is the CTO-authorised correction of the same three files (no product code) — `DAII-MASTER-EXECUTION-PLAN-2026-10-11.md`, `DAII-WORK-PACKAGE-DEPENDENCY-REGISTER-2026-10-11.md`, `DAII-CTO-DECISIONS-AND-BLOCKERS-2026-10-11.md` — nothing else; not committed until approved.

## 14. Findings added after the audit cutoff (the six audit documents in `2c6ccf3` stay immutable)

### PA-43 — UUID Repair May Invalidate Historical Audit Hash Chains
| Field | Content |
|---|---|
| **Finding ID / domain / severity** | PA-43 · Audit integrity / Release Center data repair · **provisional Medium–High**: the consequence is conditional on the repair being needed and run; severity to be re-rated by WP-AUD-09 |
| **Status** | **OPEN — CODE-REVIEW FINDING.** Registered by CTO decision of 2026-10-11 as a separate finding; **not merged with PA-33** (PA-33 concerns the `seq` value and the hash at rollback; PA-43 concerns a different path that rewrites historical fields) |
| **Observation** | `uuid-repair.core.ts` repairs non-RFC-4122 ids by updating the primary key and then every referencing column. Its `SOFT_REFERENCES` table (unenforced references) includes `audit_records.actorUserId` (under `users`, line 116) and `audit_records.organizationId` (under `org_units`, line 187). For each entry the core runs `UPDATE "<table>" SET "<column>" = <new id> WHERE "<column>" = <old id>` (line 461). Both columns are inputs of the audit hash (`computeAuditHash`: `actorUserId`, `organizationId`). The core's own header says ids embedded in the JSON columns `before`/`after` are deliberately **not** rewritten ("rewriting history is the wrong default"), but the two scalar columns are. No hash recomputation, chain check or audit exemption exists in that file |
| **Evidence source** | Code reading by Team 3: `src/database/uuid-repair.core.ts` lines 38, 95–116, 187, 458–476; `src/foundation/release/data-repair.service.ts` lines 10–11, 212, 220, 280; `src/database/migrations/core/1755853200000-AddDataRepairRunTable.ts` (permission leaf `system.release.*` for the data-repair routes, per its comment); `src/foundation/audit/audit-hash.ts` (hash inputs). **Code review only; nothing was executed** |
| **Reproduction** | Read-only: follow the lines above. Not reproduced at run time and **must not be run against real or shared data**: a runtime demonstration, if ever approved, would be on a disposable database with a seeded non-compliant id referenced by audit rows, comparing `verifyCompanyChain` before and after, under a separate authorization |
| **Impact (potential)** | If the repair runs on a database whose audit rows reference a repaired id, those rows change in hashed fields, so the chain would verify as broken from the first affected row, and historical audit rows would be altered. The effect would be an integrity-verification failure of historical evidence, not a loss of business data. **This is an inferred risk, not an observed incident** |
| **What is proved** | By code reading: the rewrite list includes the two audit columns, the `UPDATE` is generic over the list, and the audit hash includes those columns |
| **What is inferred** | That executing the repair would invalidate the chain for affected rows |
| **What is unknown** | Whether any Company actually has non-compliant ids needing repair; whether the repair has ever been run anywhere; whether another safeguard in the complete execution path (gates, approvals, pre-repair backup, post-repair checks) prevents or detects the effect (the post-repair integrity check inspects references, and no chain verification was found in the code read) |
| **Confidence** | VERIFIED for the code facts; INFERRED for the consequence; UNVERIFIED for the need and for compensating controls |
| **Disposition** | Implemented — needs verification (investigation first) |
| **Closure acceptance criteria** | (1) The complete repair path is traced and the trace reviewed; (2) the actual need is established or excluded per Company by a read-only audit under authorised access; (3) if a need exists, a policy that preserves the audit chain is approved (DEC-25) before any repair is run, with a defined post-repair chain verification; (4) no historical audit row is modified, rehashed or normalised by this finding's work |
| **Constraints** | The UUID repair is not run; no historical audit record is altered, re-hashed or normalised; any future handling needs independent review, explicit authorization and a separate scope |
| **Dependencies** | Authorised read-only access (need check); DEC-25; DEC-02 is related but independent (recovery of already-broken chains) |
| **Proposed owner** | Foundation/Release owner; reviewer independent of the code path |
| **Package** | WP-AUD-09 |
