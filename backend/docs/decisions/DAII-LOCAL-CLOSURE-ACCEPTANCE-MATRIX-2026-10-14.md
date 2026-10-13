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

## 3. Reading of the result
* **Class A, authorised, executable locally:** rows 1–13 are complete and PASS at `8ec6de4` (= final candidate). Nothing more can be proven locally for them without a source change; re-running would only repeat evidence.
* **Class A not authorised/possible:** row 28 and the sibling-method probes wait for authorisation.
* **Class B:** 22–25 are physically impossible locally and are recorded as NOT RUN / BLOCKED with the risk: T1 is undeployable-until-checked, capacity is unknown, hosted behaviour is unmeasured. None is claimed passed.
* **Class C:** 14–21, 26, 27 are open mandatory conditions. Their unmet state is what keeps the phase **NOT CLOSED**; they cannot be satisfied by engineering.
* **Local development/verification statement (separate from phase closure and from release):** for everything authorised and executable without a decision, the final candidate `c74a728` (source = `8ec6de4`) has **local verification PASS** with the listed characterizations, SKIPPED and BLOCKED cases visible. This is *not* "PHASE CLOSED — LOCAL VERIFICATION PASSED": that decision requires the mandatory decisions and the independent review (§10 of the order), and neither exists.
