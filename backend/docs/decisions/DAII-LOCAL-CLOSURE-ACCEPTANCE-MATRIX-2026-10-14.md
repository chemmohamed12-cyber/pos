# DAII — Local closure acceptance matrix — 2026-10-14

One matrix for the "Final Local Execution & Phase Closure Order" of 2026-10-14: every acceptance criterion linked to its files, tests and evidence, and classified **A** (Local Acceptance), **B** (External Deployment Verification — cannot be done without the hosting environment) or **C** (Mandatory Decision / Independent Acceptance). No mandatory condition was moved to a weaker class to ease closure: a criterion is B only if it physically needs the host, and C if it needs an authority or a person. Results: PASS / FAIL / BLOCKED / SKIPPED / NOT RUN.

## 1. Baseline verified by command (not assumed)
| Fact | Evidence (run 2026-10-14) |
|---|---|
| Current HEAD at the start of this order | `c74a728`, working tree clean except untracked `_release-output/` |
| `094dc30 → c74a728` | 5 files, all `backend/docs/decisions` (closure report added; register, proposal, one role request, previous report edited) |
| `8ec6de4 → c74a728`, everything outside `backend/docs/decisions` | **0 paths** |
| Last commit touching any path outside `backend/docs` | `8ec6de4` (lockfile) — it contains every code, test, tool and manifest change of this program (`d3ad24b`, `4dc3862` precede it) |
| Last commit whose source was verified end to end | `8ec6de4` (fresh install, build, lint, unit, db-guard, 92 isolation specs, ambient suites, business suite). Because the source tree of `c74a728` equals it, that verification applies to the final candidate; **no new run was needed or made**, and no run is claimed *on* `c74a728` |
**Final candidate for local closure: `c74a728` (source identical to `8ec6de4`).**

## 2. Matrix
| # | Criterion | Class | Files / tests | Evidence (source commit) | Result | Open part |
|---|---|---|---|---|---|---|
| 1 | Clean install + build from the committed lockfile | A | `package-lock.json` | `8ec6de4-final-verification/ci/` (`8ec6de4`) | PASS | — |
| 2 | Lint / static / structure / doc-links | A | CI script | same; lint 0 errors, 5 warnings; doc-links re-checked at this commit: 0 unresolved | PASS (warnings retained) | — |
| 3 | Unit and db-guard | A | 60 suites / 436 tests; guard 50/50 | same | PASS | — |
| 4 | Company isolation and authorization regression (92 specs) | A | `tools/testing/regression-specs-all.txt` | same, isolation log (`8ec6de4`) | 90 PASS · 1 SKIPPED (`t0-clean-company-baseline`) · 1 BLOCKED (`release-migration-registry`, needs an approved staging host → also B) · 0 FAIL | BLOCKED/SKIPPED stay listed, never counted as pass |
| 5 | Ambient suites on a seeded disposable DB | A | 24 suites | same `ambient-results.json` | 22 PASS · 1 SKIPPED · 1 selection error (name filter; passes in #4) | — |
| 6 | Business suite T-00…T-29 | A | `biz-run.js` | `business-runs/` (`8ec6de4`) | all steps PASS; 280 cases PASS · 5 FAIL-DEFECT (known characterizations) · 2 BLOCKED (T-20/T-24 H5 probes) | characterizations retained |
| 7 | Audit chain: fail-closed sequence lag, no `setval`, rollback protection | A | `audit.service.ts`; T-22, T-23, T-26, T-28, T-29 | business runs (`8ec6de4`); fix `c764fc5`, `4d4ed0d` | PASS (T-22 case X = intentional characterization) | independent acceptance → #19 |
| 8 | N-02 reservation integrity | A | fixes `a798d9d`, `5c5b791`, `03900acb`; specs in the isolation list | `8ec6de4` runs | PASS | sibling methods unprobed (WP-INV-09) → NOT RUN; acceptance → #19 |
| 9 | `wages_payable` in the `ifrs-sme` template, new Companies only | A | `ifrs-sme.template.ts`; `wages-payable-control-account.company-isolation.spec.ts` (8 tests) | `d3ad24b`; isolation run at `8ec6de4` | PASS | no existing-chart change (verified by design/spec); acceptance → #19 |
| 10 | WP-PAY-01 characterization (payment vs gross vs commission vs disbursement) | A | `payroll-gl-runtime-characterization.spec.ts` | `3bf740b-wp-pay-01/`; ambient run at `8ec6de4` | PASS 3/3 — **pins the unfixed behaviour**; it is not proof of a sound payroll cycle | posting decision → #14 |
| 11 | T1 lockfile scope equals rehearsal (22 changed / 6 packages, 8 MIT added, `package.json` unchanged, 0 removed, 0 other-field changes) | A | `package-lock.json` | `t1-review-packet/mechanical-checks.json` (`8ec6de4`) | PASS (author) | independent review → #20 |
| 12 | Teardown retry in test harness | A | `test-teardown-retry.ts` | `4dc3862-harness-retry/` | PASS (mitigation); root cause unproven | root cause → OPEN |
| 13 | F-INV-001 collector/summarizer work on a real PostgreSQL | A | `tools/ops/f-inv-001-usage-*.js` | `f-inv-001-collector-rehearsal/` | PASS on a **synthetic** fixture only | real measurement → #16 |
| 14 | Payroll posting shape, commission, disbursement, reconciliation (PA-34/35) | C | decision A1, A2, R1 | register | BLOCKED — OWNER DECISION | implement + regression + end-to-end reconciliation after the decision |
| 15 | GRNI account 2115 (and fixed-asset configuration, H2-R) | C | proposal §1, §2, §2a | register A4/C11 | BLOCKED — OWNER DECISION | code/name/purpose/template, then red-first spec + change + regression |
| 16 | F-INV-001 real measurement (DEC-10) | C (+ resource) | operator kit | register C5/O1/E1 | NOT RUN — BLOCKED (operator, database list, role) | 410 release decision |
| 17 | LA-1: 10 sites in 6 files wired, per-site A/B + lifecycle specs | C | tracker + appendix | register C7/O6 | BLOCKED — OWNER DECISION (owners; Q-L1…Q-L3) | per-site implementation and tests |
| 18 | D-04 Company-scoped integrations | C | readiness doc | register C6/O5 | BLOCKED — OWNER DECISION | PROCEED/HOLD, [REVIEW] answers |
| 19 | Independent review of N-02, PA-33/WP-AUD-08, WP-INV-10, PA-43 pilot, template, the audit track | C | review pack | register C4/O2 | BLOCKED — INDEPENDENT REVIEW (no eligible reviewer) | per-item ACCEPT/REJECT/NEEDS EVIDENCE |
| 20 | Independent review of the T1 packet | C | `t1-review-packet/` | register C4/C13 | BLOCKED — INDEPENDENT REVIEW | review |
| 21 | DEC-02 / DEC-25 / DEC-01b policies and co-signatures | C | decision package | register C1–C3/S1 | BLOCKED — OWNER DECISION | signatures; PA-43 assessment needs role + list |
| 22 | Host proxy compatibility H1–H5 for T1 | B | protocol | `DAII-T1-HOST-PROXY-CHECK-PROTOCOL-2026-10-14.md` | **NOT RUN — HOST ACCESS UNAVAILABLE** | must pass before any deployment of T1; source trace is not a substitute |
| 23 | Release-migration registry on a staging host | B | `release-migration-registry` spec | isolation log | BLOCKED — needs approved staging host | before deployment |
| 24 | Capacity / load test | B (+ C targets) | `STAGING-CAPACITY-PROFILE-2026-10-11.md` §6 (abort criteria added today) | — | NOT RUN — BLOCKED (targets, host, generator, authoriser) | measured results, never estimates |
| 25 | Hosted CI runner / multi-instance behaviour | B | — | never run | NOT RUN — HOST ACCESS UNAVAILABLE | before deployment |
| 26 | T2 (bcrypt 6 → `tar` critical, NestJS, react-router, Jest) | C | outline | register C9/O7 | BLOCKED — OWNER DECISION; not started | separate approval per upgrade |
| 27 | Phase 0 contracts (H0-1…M0-6) | C | contracts + fixture catalog | register A/P/R/M/S items | BLOCKED — OWNER DECISION | owner answers or recorded CTO deferral |
| 28 | R11 payroll in the integrity oracle | A in principle, not authorised | — | does not exist (PH1-HR-3) | NOT RUN — Phase 1 work, no authorisation | after PH0-GATE |
| 29 | WP-INV-09 sibling probes (relocateReservedStock, releaseReservedQuantityForReference, releaseReservation, limit-gated creation) | A | `t30-n02-sibling-probes.biz.real-pg.spec.ts` (test only) | `evidence-clean-snapshot-2026-10-13/d68fd10-t30-sibling-probes/` (`d68fd10`, clean snapshot; CI script on it: Overall PASS) | MEASURED: 8 PASS · 6 FAIL-DEFECT (candidate defects: plain-manager misuse of the lock idiom in 2 methods; no lock in `releaseReservation`) · 0 BLOCKED | fix/accept decision → register C14 (BLOCKED — MANDATORY OWNER DECISION for any product change) |
| 30 | Internal verification checklist (separate from the code under test) | A | `internal-verification-2026-10-14/internal_verification.py` | same folder, run on `d68fd10` | 18 checks · 18 PASS · 0 FAIL — INTERNAL VERIFICATION, not an independent review | independent review → rows 19–20 |
| 31 | PA-36 float arithmetic in payroll totals | A | `pa36-float-characterization-2026-10-14/` | standalone, synthetic, no product code | MEASURED for the sum idiom: no wrong cent for totals up to ~5e10; wrong cents at ~5e12 | accept vs integer-cent/decimal → with H0-4 (row 14) |
| 32 | Teardown race root cause | A | `teardown-race-root-cause-2026-10-14/` | direct experiment on the dedicated cluster | ESTABLISHED (autovacuum worker in the database at drop time); mitigation `4dc3862` stands; residual: vacuum longer than the 3.75 s retry window | optional harness/cluster hardening (not required by any criterion) |

## 3. Reading of the result
* **Class A, authorised, executable locally:** rows 1–13 are complete and PASS at `8ec6de4` (= final candidate). Nothing more can be proven locally for them without a source change; re-running would only repeat evidence.
* **Class A not authorised/possible:** row 28 and the sibling-method probes wait for authorisation.
* **Class B:** 22–25 are physically impossible locally and are recorded as NOT RUN / BLOCKED with the risk: T1 is undeployable-until-checked, capacity is unknown, hosted behaviour is unmeasured. None is claimed passed.
* **Class C:** 14–21, 26, 27 are open mandatory conditions. Their unmet state is what keeps the phase **NOT CLOSED**; they cannot be satisfied by engineering.
* **Local development/verification statement (separate from phase closure and from release):** for everything authorised and executable without a decision, the final candidate `c74a728` (source = `8ec6de4`) has **local verification PASS** with the listed characterizations, SKIPPED and BLOCKED cases visible. This is *not* "PHASE CLOSED — LOCAL VERIFICATION PASSED": that decision requires the mandatory decisions and the independent review (§10 of the order), and neither exists.

## 4. Final outcomes under the CTO "Close Local Development Phase" order (Step 8, 2026-10-14)
**Step 1 re-verified:** HEAD `003cf41`, tree clean (only untracked `_release-output/`); 0 paths differ from `8ec6de4` outside `backend/docs` (and 0 outside `backend/docs/decisions`). **Evidence integrity re-checked:** `sha256sum -c` over all 29 `MANIFEST.sha256` of `8ec6de4-final-verification/`, `715c22d-ci-full-tree/` and `0810300-ci-full-tree/` — 235 files OK, 0 problems; `SNAPSHOT-IDENTITY.json` `dirtyPaths: []`, source commit `8ec6de4a615c4e9962317ce6a6e9c5b6c91d37ec`. No source change, so no test was re-run (nothing in the matrix requires it).
**Steps 3–5:** no owner response and no reviewer appointment exist as of this check; the register's 37 requests stand (C14 was added later) (nothing resent, no approval inferred). No decision-dependent change was authorised, so Step 4 has nothing to implement and Step 6 nothing new to verify.
| Rows | Final outcome (order's vocabulary) | Note |
|---|---|---|
| 1, 2, 3, 5, 6, 9, 11, 13 | **PASS — LOCAL PHASE ACCEPTED** (technical criterion, author evidence at `8ec6de4`) | rows 9 and 11 additionally need independent review (rows 19–20) |
| 4 | **PASS — LOCAL PHASE ACCEPTED** for the 90 executed specs; `release-migration-registry` → **DEFERRED — DEPLOYMENT VERIFICATION**; `t0-clean-company-baseline` → **NOT RUN** (opt-in, skipped) | not counted as pass |
| 7, 8 | local technical criteria **PASS — LOCAL PHASE ACCEPTED**; independent acceptance → row 19 | WP-INV-09 sibling probes **NOT RUN** |
| 10 | characterization **PASS**; the behaviour it pins (PA-34/35) → row 14 | not proof of a sound payroll cycle |
| 12 | mitigation **PASS**; root cause of the teardown race **OPEN — LOCAL DEFECT** (test harness only, no product impact shown; no approved acceptance criterion requires its root cause) | stays visible |
| 14, 17, 21, 27 | **BLOCKED — MANDATORY OWNER DECISION** | tied to approved exit criteria: no open High (PA-34/35/16), Company-isolation mandatory gate (LA-1), P0-A (DEC-02/01b), PH0-GATE |
| 15, 16, 18, 26 | **NOT RUN — authorization/decision pending; NOT a local-closure blocker** (CTO decision 2026-10-14, §5). GRNI/fixed-asset template, F-INV-001 measurement, D-04, T2: each stays pending and is not claimed complete | D-04 HOLD would preserve current safe behaviour |
| 19, 20 | **BLOCKED — INDEPENDENT REVIEW** | no reviewer appointed |
| 22, 23, 24, 25 | **DEFERRED — DEPLOYMENT VERIFICATION** (22 and 25 also **NOT RUN**); retained as pre-deployment gates | risks: T1 untested behind the real proxy (rate-limiter client address; the advisory is not reachable through application code per source trace, which is not a substitute); capacity unknown; hosted/multi-instance behaviour unmeasured; registry migrations unproven on a staging host |
| 28 | **NOT RUN** (Phase 1 work, not authorised) | — |
**Decision: `NOT CLOSED`.** No mandatory local technical criterion is open or failing. The precise unmet mandatory criteria are: (1) **independent acceptance** — rows 19–20 (Phase 1 exit criteria 3 and 5; the order forbids recording it without a reviewer) — accountable: CTO (appointment, register C4/C13); (2) **mandatory owner decisions** — rows 14, 17, 21, 27 (register A1/A2/R1, C7/O6, C1–C3/S1, Phase 0 items) — accountable: Accounting Policy Owner and Treasury Owner, site owners with the CTO, Security/Audit Owner with the CTO, the Phase 0 owners. Hosting-only checks (22–25) and rows 15, 16, 18, 26 do **not** hold the phase open. "PHASE CLOSED — LOCAL VERIFICATION PASSED" will be declarable when rows 19–20 hold ACCEPT decisions and rows 14, 17, 21, 27 have recorded decisions (and any change they require is implemented and verified at a new final commit).

## 5. CTO decision "Final Local Phase Closure" (2026-10-14) — recorded; no acceptance criterion changed
| Point | Effect on this matrix | Status now |
|---|---|---|
| 1. GRNI/fixed assets, F-INV-001, D-04, T2 are not automatic blockers | rows 15, 16, 18, 26 leave the blocking set (§4 updated); decisions remain pending in the register (A4/C11, C5/O1, C6/O5, C9/O7) | NOT RUN — pending authorization |
| 2. Independent review of rows 19–20 stays mandatory | register C4 now states the mandate and the hand-over (evidence pack + this matrix → ACCEPT/REJECT/NEEDS EVIDENCE per finding and for the T1 packet); the reviewer **is not yet appointed** — only the CTO can appoint | BLOCKED — INDEPENDENT REVIEW |
| 3. Rows 14, 17, 21, 27 pursued with their owners | already one consolidated request per role (`owner-requests-2026-10-14/`); not resent; no approval assumed; no accounting or security change made | BLOCKED — MANDATORY OWNER DECISION |
| 4. Source-changing decisions | none has been issued, so no source change; if one is, it is implemented at a new commit with the affected suites re-run on that commit | n/a |
| 5. Re-evaluation after decisions and review | the criteria will be re-assessed on actual evidence; no re-run without a source change or reviewer request | pending inputs |
| 6. Hosting/load checks | stay NOT RUN as deferred deployment verification | DEFERRED — DEPLOYMENT VERIFICATION |
| 7. PHASE CLOSED — LOCAL VERIFICATION PASSED | **not declared**: rows 19–20 and 14, 17, 21, 27 are unmet | NOT CLOSED |
| 8. Phase 0 / 1 / 2 / Release | separate: PH0-GATE NOT MET · Phase 1 exit NOT MET · Phase 2 NOT READY · release NOT APPROVED | unchanged |
**The shortest path to closure** is now exactly: (a) the CTO appoints the reviewer; (b) four owner decisions — payroll posting/commission/disbursement (A1, A2, R1), LA-1 ownership and Q-L1…Q-L3 (C7, O6), DEC-02/DEC-25/DEC-01b with Security/Audit co-signature (C1–C3, S1), Phase 0 contract answers or CTO deferral (P1–P4, S2, A3, M1–M3, C12). Engineering has nothing further it can execute for those rows without them.

## 6. Local technical work executed under the CTO decision "No external reviewer available" (2026-10-14)
* **New commit:** `d68fd10` — one test-only spec (T-30) and one line in `biz-run.js`; no production source changed (internal check IV-05). It is the first source change since `8ec6de4`, so it was verified on its own clean snapshot: CI script Overall PASS and T-30 exit 0 (row 29). Nothing else needed re-running: the commit changes no code those suites exercise.
* **Source after this order:** product code identical to `8ec6de4`; tests/tools differ by `d68fd10` only. Latest verified source commit for the new probes: `d68fd10`; the rest of the evidence still stands on `8ec6de4`.
* **Rows 29–32** are new, all Class A and now executed. They produced evidence, not closure: row 29 is a *new set of candidate defects* awaiting a decision (C14), row 31 an accepted-or-fix decision, row 32 an explanation.
* **What remains executable locally without a decision:** nothing identified. The remaining local items are all decision- or review-gated: product fixes for row 29 (C14), LA-1 wiring (C7/O6), payroll/accounting changes (A1/A2/R1, A4), D-04 (C6), and optional teardown hardening (row 32, no criterion requires it).
