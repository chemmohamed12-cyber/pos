# Final report after the reviewer's database verification — 2026-10-11

Prepared by the verification track from the evidence actually on disk. It does **not** close any finding: **N-02 OPEN · PA-33 OPEN · CI NOT GREEN · Release NOT APPROVED**. Working-tree runs are not counted as clean-snapshot evidence. Status vocabulary: PASS / FAIL(-DEFECT) / SKIPPED / BLOCKED.

## 1. Tested commit and clean-snapshot provenance
| Run | Snapshot / tested commit | Provenance proof |
|---|---|---|
| Verification track pipeline | `71e5f5e` (clean `git archive`, `dist` built from it) | `evidence-clean-snapshot-2026-10-11/71e5f5e-final/SOURCE_COMMIT.txt` = `71e5f5ecbff0…`; all 23 business run headers carry `71e5f5e…`, `sourceKind: clean-git-archive-snapshot`, `dirtyPaths: []` (re-checked by the reviewer) |
| Reviewer's database re-run (T-03, T-20, T-21, T-22, T-23, T-24) | **`f881e53`** (clean `git archive`; despite its folder name `71e5f5e-reviewer-rerun`) | `…/71e5f5e-reviewer-rerun/SOURCE_COMMIT.txt` = `f881e53aecf9…`; the six latest run headers carry `f881e53`, `sourceKind: clean-git-archive-snapshot`, `dirtyPaths: []`; log `n02-review-db-run-2.log` (6 steps PASS at jest level) |
| Equivalence of the two trees | `git diff --stat 71e5f5e f881e53 -- src tools` is **empty**: the only differences are documentation and evidence, so the product and test code is identical | verified now |
Notes: the reviewer's folder also contains the older run directories inherited from the committed evidence (their headers are working-tree class; the reviewer's helper flags 25 of 31 as `HEADER-PROBLEM` for exactly that reason). Only the `f881e53` / `dirtyPaths: []` runs are counted below. The reviewer's evidence folder was **not yet committed** by the reviewer when this report was written.

## 2. Case-by-case results (reviewer re-run at `f881e53`; reconciliation lines R1–R10 excluded and listed separately)
| Test | Reviewer `f881e53` | Verification track `71e5f5e` | Difference |
|---|---|---|---|
| T-03 / T-04 (concurrency) | 10 PASS; reconciliation R1–R10 10 PASS | 10 PASS (+ R1–R10 PASS) | none (the earlier step failure was the cluster-collision artefact, `otherDatabasesUnchanged`) |
| T-20 (N-02 probes) | 8 PASS, 1 BLOCKED (H5 shipment transition) | 8 PASS, 1 BLOCKED | none |
| T-21 (`fulfillReservation`) | 13 PASS (A, A-tx, B, C, D, E, E2, F, I, J, G, H, H-after-D) | 13 PASS | none |
| T-22 (F-AUD-003 reproducer) | 2 PASS + 1 FAIL-DEFECT = case X "explicit seq honoured by save" | same | none — case X is an intentional characterisation (TypeORM ignores an explicit seq), not a product failure |
| T-23 (audit seq/hash) | 7 PASS (R1, R2, C1, C2, H, P1, P2) | 7 PASS | none |
| T-24 (limit / release / start) | 10 PASS, 1 BLOCKED (H5) | 10 PASS, 1 BLOCKED | none |
**No difference in classification** between the two independent snapshot runs; no change of classification is proposed. SKIPPED: none of these six; the only skipped suite in the programme is the opt-in `t0-clean-company-baseline` (isolation run: 91 files = **89 executed-PASS / 1 SKIPPED / 1 BLOCKED**, corrected in `520f2e0`). Always report Executed-PASS, SKIPPED and BLOCKED separately; "90 PASS" must not be used.

## 3. N-02 — status of each finding (separately; N-02 as a whole OPEN)
| Finding | Status |
|---|---|
| `fulfillReservation` duplicate dispatch | fix `a798d9d`; verified on two clean snapshots (`71e5f5e`, `f881e53`); reviewer's code review done, the reviewer's independence is limited (it wrote `runInTransaction` and the T-20 probes) — **acceptance is the CTO's decision** |
| Overlapping-order deadlock (review finding) | reproduced (12 deadlocks / 24 calls) and fixed in `5c5b791`; T-21 I and J PASS on both snapshots; reviewer withdrew the override-warehouse variant as not substantiated (valuation locks are not taken inside the fulfilment transaction) |
| H1 limit engine (`consume`/`release`) | fixed (`5c5b791`); T-24/T-20 PASS on both snapshots; not closed |
| H2 `releaseReservedQuantity` | fixed (`5c5b791`); same |
| H4 `ProcessEngine.start` | fixed (`5c5b791`); same |
| H5 shipment transition | **BLOCKED** — fixture not built; a test specification now exists (`DAII-N02-SIBLING-PROBES-AND-H5-FIXTURE-TEST-SPECIFICATION-2026-10-11.md`), no probe executed |
| Sibling methods (`relocateReservedStock`, `releaseReservedQuantityForReference`, `limit.check`, …) | **NOT RUN** — same idiom, unprobed, unchanged (specification above) |

## 4. PA-33 = F-AUD-003 (kept separate from N-02)
Fix `c764fc5` (`audit.service.ts`): `nextval` drawn under the audit advisory lock, hashed and inserted explicitly; hash format unchanged; history untouched. Evidence: T-22/T-23 PASS on both clean snapshots; Team 3's diff-scope review (`DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md`) found the diff conforms to the authorised scope with no extra product scope, raw-INSERT equivalence checked (356 call sites, none uses the return value), and lists residuals: sequence lag after an import/restore (proposal `DAII-F-AUD-003-SEQUENCE-LAG-GUARD-PROPOSAL-2026-10-11.md`, not implemented), the raw INSERT must follow entity changes, two extra statements per audited write, historical broken chains untouched (DEC-02 open). Disclosure from that document: the Team 3 session states that it created commits `a798d9d` and `60b9bdf` at the user's instruction — this supersedes my earlier "committer cannot be established" note for those two commits (stated by that session, not independently verifiable from git). **PA-33 stays OPEN** until the CTO accepts the independent verification (reviewer independence caveat above) and decides the residuals.

## 5. New defects, guard failures, scope deviations
- **New defects:** none found in this round.
- **Guard failures:** none — guard suite 50/50 on `71e5f5e` and in the reviewer's CI run; the guard policy and approved entry are unchanged. The 9 BLOCKED isolation specs (6 on the 5544-pinned helper, 3 role-creating) and the held `company-audit-access` spec are unchanged and not run.
- **CI: NOT GREEN.** The reviewer's CI script at `f881e53`: install, build, structure, doc-links, unit (59/430), db-guard PASS; **lint FAIL** — 2 unused imports (`RolesGuard`, `RequireRole`) in `installation-audit.controller.ts` and 1 cross-domain import in `company-lifecycle-admission.real-pg.spec.ts`, both introduced by the LA-1 track's commit `60b9bdf`; they belong to the LA-1 owner and were not touched.
- **Scope deviations:** none in product code beyond the authorised files (`audit.service.ts`; `limit.service.ts`, `process-engine.service.ts`, `inventory.service.ts` for N-02). Process deviations, recorded: one pipeline of mine was aborted (partial log kept), two cluster collisions between sessions (both affected runs re-run), one snapshot folder deleted before its `node_modules` junction was removed (node_modules unaffected, procedure fixed), and the reviewer's evidence folder is still uncommitted.

## 6. Gates and what is outstanding
| Gate | State |
|---|---|
| N-02 | OPEN — H5 and sibling methods unprobed; acceptance of the independent review is the CTO's decision |
| PA-33 | OPEN — independent verification evidence exists (reviewer, clean snapshot `f881e53`); acceptance/independence ruling, residual decisions (seq-lag guard, DEC-02 recovery policy if real chains are broken) pending |
| CI | NOT GREEN until the LA-1 lint errors are fixed by their owner and the gate passes on the resulting tree |
| F-INV-001 / D-9, D-10 capacity, hosting | unchanged: blocked on operator access, targets and an authorised environment |
| Release | **NOT APPROVED** |
