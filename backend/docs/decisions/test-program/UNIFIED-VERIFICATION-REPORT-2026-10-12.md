# Unified verification report — isolation regression, CI, Option B tests (reviewer-session audit of the Authorization session's evidence) — 2026-10-12

Terms: IMPLEMENTED / VERIFIED (author track, clean snapshot) / INDEPENDENTLY ACCEPTED (none). This report audits; it does not accept.

## 1. Source integrity
- Regression source `68c2215` vs the approved `ece3ae8`: the only difference is the added `tools/testing/regression-specs-all.txt`. Product code, guards and the test-database configuration (cluster pin `0dd0074`) are identical.
- Audit-regression source `bcfce72` vs `68c2215`: differs only in `t26`/`t28` specs, new `t29` spec and `biz-run.js` (all test files, commit `b4821ab`); no product code. So T-26/T-28 on `bcfce72` do test the relabelled Option B expectations (the gap flagged earlier is closed).
- Provenance: snapshots are `git archive` (no dirty paths possible); run headers for T-22/23/26/28/29 carry `bcfce72`, `dirtyPaths: []` (re-read with `review-snapshot-evidence.js`, 0 header problems of 5). The isolation runner records logs, not headers; log hashes in `LOG-SHA256.txt` re-computed and **match** (sha256 of both logs).

## 2. 91-spec isolation regression (`68c2215-isolation/`, cluster 5546 rebuilt, namespace biz_t90_)
Re-counted from the logs: first pass 84 `RESULT PASS` (= 83 executed-pass + 1 SKIPPED printed as PASS: `t0-clean-company-baseline`) + 6 FAIL + 1 BLOCKED (`release-migration-registry`, 21 tests refuse to run without the 5544 pin) = 91. The 6 FAIL are `fixed-asset`, `price-lists`, `commission`, `fulfillment`, `supplier-invoice`, `sales-returns` company-isolation specs: their tests passed; the suite failed in global teardown (`permission denied to terminate process` at `DROP DATABASE … WITH (FORCE)`). Re-run of exactly those 6: 6/6 PASS (log hashed). **Final: 89 executed-PASS · 1 SKIPPED · 1 BLOCKED · 0 FAIL — not "91 passed".** The two non-run specs did not execute their tests. The first-pass failures are recorded, not hidden; the set was re-run once, not retried until green.

## 3. Option B tests (`bcfce72-audit-regression/`, `5ecb6c3-t29/`)
T-28 12/12 PASS · T-26 3/3 PASS (L1/L2 asserted as refusals, assertions kept) · T-23 7/7 PASS · T-22 2 PASS + the expected characterization FAIL-DEFECT (`explicit seq honoured by save`) · T-29 (PA-43 pilot on a disposable DB, simulated only): P1 and N1 PASS, S1 `FAIL-DEFECT` by design = the simulated repair would break the chain at the first legacy row. Earlier on `1ae0ae7`: T-04 alone PASS (`d3655e1`), T-28 11/11. T-29 attempt 1 was marked failed by the same teardown race, attempt 2 passed; both kept.

## 4. CI (my run, commit `f8883e3`)
Full-tree clean snapshot of `89508b1`, commit-pinned: install, build, lint (0 errors), structure, doc-links (0 unresolved), unit 59/430, db-guard 50/50 → Overall PASS. The 5 warnings are redundant eslint-disable directives (analysis in `89508b1-ci-full-tree/CI-RESULT.md`); not changed. Unpinned runs show `commit: unknown` and fail db-guard's header test — a snapshot artefact, kept.

## 5. Open gaps and decisions
| Item | State | Recommendation |
|---|---|---|
| FORCE-drop teardown race (6+1 suites failed in teardown only) | open test-infrastructure item; cause unconfirmed (autovacuum suspected); the cluster-config change was not made | Harness-level bounded retry around `DROP DATABASE … WITH (FORCE)` in the test teardown (test-only, no permission broadening). Do not grant the test role terminate rights |
| Regression run not from a single HEAD | regression on `68c2215`, Option B tests on `bcfce72`, CI on `89508b1` — all product-identical | acceptable for the author track; the independent reviewer should confirm identity |
| 5 lint warnings | open, harmless | optional separate cleanup |
| T-03 (combined step) not re-run after the rebuild; T-04 alone PASS | open (DEC-08) | decide whether the combined T-03 run + standalone T-04 satisfies "individually" |
| H5-D1 and the guard (`4d4ed0d`) | implemented + verified (author track) | independent review still required |
| Independent reviewer | not nominated; the Authorization session declared a conflict (evidence audit only); this session is also ineligible | coordinator to nominate |
| WP-AUD-09 real need check | STOPPED: no approved read-only role / database list | CTO to provide or accept "need not established" |
| Carry-over: F-INV-001, D-04, dependencies, capacity/staging | see `CLOSEOUT-REPORT-2026-10-11.md` | unchanged |

## 6. What blocks release approval
No independent acceptance; N-02, PA-33, PA-43 OPEN; open harness teardown race; WP-AUD-09 real check not established; carry-over decisions. Passing tests does not close findings.

Official status: **N-02 OPEN · PA-33 OPEN · PA-43 OPEN · CI NOT GREEN (not changed by this audit) · RELEASE NOT APPROVED.**
