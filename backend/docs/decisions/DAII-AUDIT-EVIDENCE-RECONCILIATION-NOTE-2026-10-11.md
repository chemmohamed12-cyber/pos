# DAII — Audit Evidence Reconciliation Note: real-Postgres isolation results (80 / 1 / 19 versus 90 / 9 / 1) — 2026-10-11

Team 3, documentation only, read-only. Responds to the CTO directive to reconcile the figure cited in the six audit documents (committed unchanged in `2c6ccf3`) with the newer verification status record. **The six audit documents are not edited by this note.** Audit cutoff `b591d1f`; evidence baseline `a6002fa`. No test was run by Team 3; everything below is read from committed logs, spec lists, commit history and file timestamps, and each source states how it was obtained.

## 1. The two figures and their sources

| | Figure A (cited by the audit documents) | Figure B (newer) |
|---|---|---|
| Result | **80 PASS · 1 BLOCKED · 19 NOT RUN** | **90 PASS · 9 BLOCKED · 1 NOT RUN** |
| Source | `test-program/VERIFICATION-CLOSURE-AND-RELEASE-DECISION-REPORT-2026-10-11.md` §2 and §8 (committed in `74920fc`) | `test-program/VERIFICATION-DIRECTIVE-STATUS-2026-10-11.md` §3 (**untracked in the working tree at the time of this note**; parent of record `b591d1f`) |
| Committed? | Yes | **No** |
| Used as audit evidence? | Yes (PA-22, matrix F-02, scorecard) | **No** — it is not in any commit |

## 2. Reconciliation: same population, different statuses

**Figure A and Figure B are two separate historical states of the same population and are kept as such; neither replaces the other.** In particular, **Figure B's "90 PASS" is not 90 independently verified passes**: 20 of them are clean-snapshot results on `a6002fa`; the other 70 are working-tree results produced by the implementing/verification track, none independently reviewed, none attributable to a verified commit (§3, §4). The 10 newly passing specs are executed results of that track's own adapted runs, not independently reviewed.

Both figures sum to 100 specs. Arithmetic and name-level cross-check (spec lists `tools/testing/regression-specs*.txt` and the coverage inventory, verified disjoint by script: 16 + 60 + 5 + 7 + 3 = 91 distinct listed specs, no overlaps):

| Group | Specs | Figure A | Figure B | What changed |
|---|---|---|---|---|
| Harness-based isolation (list 1) | 16 | PASS | PASS | nothing |
| Harness-based isolation (list 2, includes the `products` and `delivery` renames) | 60 | PASS | PASS | nothing |
| Mock-only / no database of their own (list 3) | 4 | PASS | PASS | nothing |
| `release-migration-registry.real-pg.spec.ts` (list 3) | 1 | BLOCKED (executed; failed its own safety assertion pinned to port 5544) | BLOCKED | nothing |
| Fixed-name specs adapted by namespace (list 4): `memberships-mine`, `company-membership-provisioning`, `database-provisioning.service`, `company-datasource-factory-impact`, `company-datasource-registry-isolation`, `restore-manager-audit-chain`, `company-migration-runner` | 7 | NOT RUN | **PASS 7/7** | executed after an adaptation described as test-only, line-level review pending for 5 of the 7 (§5) (`regression-4.log`) |
| Product-named / child-process specs adapted (list 5): `installation-bootstrap`, `company-fanout`, `company-database-pool.multi-process` | 3 | NOT RUN | **PASS 3/3** | executed after an adaptation described as test-only, line-level review pending for 1 of the 3 (§5) (`regression-5b.log`); the first attempt `regression-5.log` ended 2/3 (the multi-process spec failed because its pooled database names lacked the `daii_test_` prefix) and is preserved |
| Product-named, role-creating specs: `company-database-allocation.http`, `company-registry.controller.database-creation`, `company-database-pool.full-flow` | 3 | NOT RUN | **BLOCKED** | classified, **not executed**: need `CREATE ROLE`/`GRANT`/`DROP ROLE` (CREATEROLE, deliberately not held by the test role) and the product allocator's `company_<uuid>` names, which the guard refuses |
| Pinned-helper specs: `module-add-existing-company`, `new-company-default-administrator`, `provisioning-lifecycle`, `ui-created-company-admin`, `limits-scope` | 5 | NOT RUN | **BLOCKED** | classified, **not executed**: shared helper pinned to port 5544 and issuing a `pg_terminate_backend` statement the guard refuses |
| Held: `company-audit-access.real-pg.spec.ts` | 1 | NOT RUN | NOT RUN | nothing (other track's uncommitted edits; untouched) |
| **Totals** | 100 | **80 / 1 / 19** | **90 / 9 / 1** | **10 newly passed** (NOT RUN→PASS, executed); **8 newly blocked** (NOT RUN→BLOCKED, classification without execution); **1 remaining unrun** (the protected `company-audit-access` spec) |

Check: A PASS 16 + 60 + 4 = 80; A NOT RUN 7 + 3 + 3 + 5 + 1 = 19; B PASS 80 + 7 + 3 = 90; B BLOCKED 1 + 3 + 5 = 9. **The populations are identical; the figures are not equivalent.** Figure B is not "10 more passes and 8 more failures": 8 of the 9 BLOCKED are specs that have never been executed against the intended cluster, and their status is the result of a statement-by-statement guard evaluation (`NARROW-GUARD-DECISIONS-FOR-REMAINING-SPECS-2026-10-11.md`, committed in `a314e18`). BLOCKED and NOT RUN are both "no pass"; neither counts as a pass in either figure.

## 3. Source commit and working-tree state of each result

The regression logs carry **no commit header or `dirtyPaths` field** (unlike business-suite runs from `6d062cb` on). **The "HEAD at that time" column below is INFERRED PROVENANCE, not verified commit attribution.** It is derived from the log file's last-write time compared with commit timestamps (all +0300, 2026-10-10/11) and from the commit that first added the file; file times can be changed by copying or re-writing, and the uncommitted working-tree contents at run time are **not recorded** and cannot be reconstructed.

| Log | Specs | Last write | HEAD at that time (INFERRED provenance) | Working-tree state | Evidence class |
|---|---|---|---|---|---|
| `regression-1.log` (16/16) | list 1 | 10-10 23:38 | `cff8a53` (23:11); log first committed in `e9be53a` | uncommitted files of the shared tree; not recorded | Working-tree run |
| `regression-2.log` (60/60) | list 2 | 10-11 01:10 | `e9be53a` (23:56); log first committed in `f14f162` | not recorded | Working-tree run |
| `regression-3.log` (4/5; 1 failed on its own port-5544 assertion) | list 3 | 10-11 01:16 | `e9be53a`; first committed in `f14f162` | not recorded | Working-tree run |
| `regression-4.log` (7/7) | list 4 | 10-11 01:36 | `1829794` (01:34), after the N-01 code commit `23e5ec1` (01:26); the adaptations were **uncommitted** then and were committed in `a314e18` (02:22) | not recorded | Working-tree run |
| `regression-5.log` (2/3) then `regression-5b.log` (3/3) | list 5 | 10-11 01:38 / 10-11 01:45 | `1829794`; adaptations uncommitted, committed in `a314e18` | not recorded | Working-tree runs |
| `regression-registerdoc.log` (20/20) | 20 specs whose fixtures call `registerDocumentType` | 10-11 06:46 (committed in `a205666`) | **`a6002fa`, stated by the run itself** (`SOURCE_COMMIT.txt` in the snapshot; clean `git archive`, `dist` rebuilt) — not inferred | `dirtyPaths: []` recorded | **Clean-snapshot run (verified attribution)** |

Consequences: by inferred timestamps, the runs behind Figure A's 76 harness-based PASS (lists 1–2) predate the N-01 code commit and may or may not have had that code in the working tree; the 10 newly passing specs ran after it. **No working-tree log is a verification of a named commit.** Only the `regression-registerdoc.log` run, whose commit is stated by the run itself, is a verified attribution.

## 4. Clean-snapshot results (verified attribution) versus working-tree-only evidence

**Clean-snapshot verified, separately identified:** only the **20-spec subset** in `evidence-clean-snapshot-2026-10-11/a6002fa/regression-specs-registerdoc.txt` — 5 specs of list 1 and 15 of list 2 — **20/20 PASS on a clean snapshot of `a6002fa`**. Therefore, of the 90 PASS in Figure B (and of the 80 in Figure A), **20 are clean-snapshot verified; 70 are working-tree results** (lists 1–2 minus the 20 = 56; list 3 mock-only = 4; lists 4–5 = 10). Also clean-snapshot verified on `a6002fa` but outside this population: business suite T-00…T-20 (exit 0), unit 59 suites / 430 tests, guard 50/50. The code changed after `a6002fa` (N-02 fulfil fix `a798d9d`/`b591d1f`; LA-1 Layer 2 `60b9bdf`) has no clean-snapshot isolation run; the N-02 report's pipeline section is a placeholder.

## 5. What remains blocked, unrun or unverified

**Boundary statement.** The 8 newly blocked specs (3 role-creating, 5 pinned-helper) were **not executed against the intended cluster**; their BLOCKED status comes from the guard-statement evaluation alone. The ninth BLOCKED spec (`release-migration-registry`) was executed and failed its own port-5544 safety assertion. The two decisions below are explicit and open; the guard is unchanged and is not weakened by this note. `company-audit-access.real-pg.spec.ts` is protected: it is **NOT RUN**, was not modified and is not bypassed.

| Item | Status | Needs |
|---|---|---|
| 5 pinned-helper specs + `release-migration-registry` | BLOCKED (6; 5 not executed, 1 executed and failed its own assertion) | **Helper decision (DEC-09, part 1):** decision on the test-helper adaptation (replace `pg_terminate_backend` by the allowed `DROP DATABASE … WITH (FORCE)`; extend the port assertion) — guard stays unchanged either way |
| 3 role-creating specs | BLOCKED (not executed) | **CREATEROLE decision (DEC-09, part 2):** approve a CREATEROLE alternative with a role-name pattern, or keep these specs NOT RUN/BLOCKED; the test role stays least-privilege until decided |
| `company-audit-access.real-pg.spec.ts` | NOT RUN | Owner's uncommitted edits resolved; protected |
| All 70 working-tree PASS | PASS but not commit-attributable | Re-run on a clean snapshot of a named commit |
| Post-`a6002fa` delta | No clean-snapshot isolation run | Pipeline on the then-current HEAD (PA-42) |
| Adaptation scope (10 specs changed by `a314e18`, test-only intent) | **Line-level review status:** 4 of 10 diffs read by Team 3 — `memberships-mine`, `database-provisioning.service`, `installation-bootstrap`, `company-fanout` — which showed database-name changes via `DAII_TEST_DB_NS` and (fanout) migration-fixture folders moved from the OS temp directory into `backend/.test-tmp`; this is a reading by the audit author, not an independent review and not a safety proof. **6 of 10 diffs have NOT been reviewed line by line and are PENDING REVIEW:** `company-membership-provisioning`, `company-datasource-factory-impact.characterization`, `company-datasource-registry-isolation`, `company-migration-runner`, `restore-manager-audit-chain`, `company-database-pool.multi-process`. Line counts are not evidence of safety and no safety claim is made for these six (or beyond the observed name/location changes for the four) until that review is complete. | Line-by-line independent review of all ten diffs, including that no assertion, guard-relevant statement or cleanup behaviour changed |

## 6. Recommended handling of the audit documents (not done here)

1. Leave `2c6ccf3` unchanged. Figure A is correct for the committed evidence.
2. After the verification track **commits** its status record, make one separate documentation commit that (a) states Figure B alongside Figure A with this reconciliation, (b) updates PA-22 (80/1/19 → 90/9/1 with the BLOCKED-by-analysis caveat), the matrix F-02 row and the scorecard counts, and (c) restates that only 20 isolation specs are clean-snapshot verified. Until then, readers should treat this note as the authoritative reconciliation.
3. Do not describe the working tree as fully verified on the strength of the `a6002fa` clean snapshot.
4. The later update must preserve both historical figures (80/1/19 and 90/9/1) and label every claim as *clean-snapshot verified*, *working-tree tested*, *blocked* or *unrun*; it must carry the provenance label (inferred versus stated) and the pending-review status of the six adaptation diffs until that review is done.
5. This note changes no source, test, guard or configuration, and does not update PA-22, the matrix F-02 row or the scorecard.

## 7. Update of 2026-10-11 (WP-DOC-02) — sections 1–6 above remain the historical record and are not rewritten

Reference documentation commit at the time of writing: `49cc7d5cb639cd492823a803019758fd2abe216e`. Sources added since the note: the verification track's consolidated status and final report (`f881e53`, `f37a87f`, `ba8b5b9`), the clean-snapshot pipeline of `71e5f5e` (clean `git archive`; 23 of 23 business run headers carry `71e5f5e…`, `dirtyPaths: []`, `sourceKind: clean-git-archive-snapshot`; folder `evidence-clean-snapshot-2026-10-11/71e5f5e-final/`), and the reviewer's database re-run at `f881e53` (reviewer's re-run; 6 of 6 run headers carry `f881e53…`, `dirtyPaths: []`, clean snapshot; code identical to `71e5f5e` — `git diff --stat 71e5f5e f881e53 -- src tools` is empty per the verification report; folder `…/71e5f5e-reviewer-rerun/`, despite its name).

### 7.1 Provenance verification performed by Team 3 (read-only; nothing was re-run)
| Check | Result |
|---|---|
| `SOURCE_COMMIT.txt` of each folder | `71e5f5ecbff0fd4a51b0f862d722950e22006a91` and `f881e53aecf9461edd1d9e583224b315fd6450f2` |
| Run headers of the business steps (read from the JSON headers) | 71e5f5e-final: **23 of 23** headers: commit `71e5f5e`, `dirtyPaths: []`, `sourceKind: clean-git-archive-snapshot`. Reviewer re-run: **6 of 6**: commit `f881e53`, `dirtyPaths: []`, clean snapshot |
| Code identity of the two trees | Stated by the verification report (`git diff --stat 71e5f5e f881e53 -- src tools` empty); not recomputed by Team 3 |
| Isolation-spec run (`regression-all.log`, 91 files) | Attributed by the folder's `SOURCE_COMMIT.txt` and `regression-specs-all.txt`; **the log itself carries no commit header** (the same limitation as the earlier regression logs), so its attribution is by folder, not by a header |
| Case results | Counted by Team 3 from the result files, not from the narrative |

### 7.2 Isolation population — three historical states, kept side by side
| State | Source | Executed PASS | SKIPPED | BLOCKED | NOT RUN | Clean-snapshot coverage |
|---|---|---|---|---|---|---|
| A (original) | committed verification report (`74920fc`) | 80 | — | 1 | 19 | 20 specs on `a6002fa`; the rest working-tree |
| B (newer) | verification status record (`a33f769`) | "90 PASS" | included in the 90 | 9 | 1 | not stated per spec |
| B corrected | `520f2e0` (runner's "90 PASS" included the opt-in `t0-clean-company-baseline`, which jest reports as skipped) | 89 | 1 | 9 | 1 | — |
| C (clean-snapshot run) | `71e5f5e-final/regression-all.log`: 91 files run, 90 `RESULT PASS` lines, 1 `RESULT FAIL` | 89 | 1 | 1 (the known `release-migration-registry` spec failing its own port-5544 safety assertion) | — | **all 91 files on one clean snapshot (`71e5f5e`)** |
Population: 100 specs = the 91 files run in C + 9 not run (5 helper-pinned specs BLOCKED by guard evaluation, 3 role-creating specs BLOCKED, 1 held `company-audit-access.real-pg.spec.ts` NOT RUN). Totals reconcile: executed PASS 89; skipped 1; BLOCKED 9 (1 executed-and-failed + 5 + 3); NOT RUN 1. State A and State B are **not equivalent** (8 specs moved from NOT RUN to BLOCKED by guard evaluation without being executed) and neither replaces the other. "90 PASS" must not be used.

**Supersession, explicitly:** §4 of this note said 20 results were clean-snapshot verified and 70 were working-tree. That was true when written. Run C extends clean-snapshot coverage to all 91 files that can run; it does not change any earlier result and does not make working-tree runs into clean-snapshot ones retroactively. Consequences: the 10 specs that moved NOT RUN→PASS after adaptation have now also run on a clean snapshot; **the six adaptation diffs listed in §5 remain pending line-by-line review (no review record exists)**, and the nine blocked specs and the held spec are unchanged.

### 7.3 `T-03` step: what "20 PASS" is made of
The harness step named `T-03` executes the combined spec `t03-t04-concurrency`. Its result file holds **20 entries, all PASS**, on both clean snapshots (`71e5f5e` run and `f881e53` reviewer run):
| Group | Entries | Count |
|---|---|---|
| T-03 | `T-03-N10`, `T-03-N25`, `T-03-N50`, `audit-chain-after-T-03` | 4 |
| T-04 | `T-04-N10`, `T-04-N25`, `audit-chain-after-T-04`, `T-04b`, `invariant-no-negative-stock`, `audit-chain-after-T-04b` | 6 |
| Reconciliation | `T-10/T-03/R1` … `R10` | 10 |
So "T-03 = 20 PASS" is the **step total**. T-04 has results inside the same documented run (6 PASS) but **no separate, individual run**; the harness cannot run it alone without a spec change. Whether the combined step satisfies the CTO decision that T-03 and T-04 be re-run individually on a quiet cluster is for the CTO; it is recorded here as: T-03 step 20 PASS on clean snapshots; T-04 PASS within that step only.

### 7.4 Other clean-snapshot results now on record (case level, counted from result files)
| Step | `71e5f5e` | `f881e53` (reviewer) | Note |
|---|---|---|---|
| T-20 | 8 PASS, 1 BLOCKED (H5) | 8 PASS, 1 BLOCKED | H5 not executed |
| T-21 | 13 PASS | 13 PASS | `fulfillReservation` cases A–J, E2, G, H |
| T-22 | 2 PASS, 1 FAIL-DEFECT | same | the FAIL-DEFECT is the by-design characterisation that TypeORM ignores an explicit `seq` |
| T-23 | 7 PASS | 7 PASS | audit seq/hash regression |
| T-24 | 10 PASS, 1 BLOCKED (H5) | 10 PASS, 1 BLOCKED | limit / release / start |
| Business suite (23 steps) | exit 0; T-06 keeps the known T-06x legacy-wrapper probe FAIL-DEFECT; T-18 keeps 3 FAIL-DEFECT (schema drift) | — | classification unchanged |
Unit 59 suites / 430 tests and guard 50/50 PASS (verification report). CI script: **lint FAIL** (3 errors in LA-1 files), everything else PASS: **CI NOT GREEN**.

### 7.5 What this update does not change
No finding is closed. N-02 OPEN, PA-33 OPEN, PA-43 OPEN, CI NOT GREEN, release NOT APPROVED. The peer reviews are evidence, not an accepted independent review. Evidence from the clean snapshots covers the scenarios run and is not generalised.
