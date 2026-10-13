# DAII — Final program closure report (verification and engineering closeout) — 2026-10-13

One unified report for the owner's closing directive. It extends `DAII-HANDOVER-CLOSURE-REPORT-2026-10-13.md` (which stays valid for its runs) and does not repeat it. Supporting documents: `DAII-DEC-01B-AND-DEC-02-AUDIT-CHAIN-DECISIONS-2026-10-13.md`, `DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md`, `DAII-INDEPENDENT-REVIEW-SCOPE-AND-READINESS-2026-10-13.md`, `DAII-CARRIED-ITEMS-STATUS-2026-10-13.md`, and entries EV-22…EV-27 of `DAII-CTO-DECISIONS-AND-BLOCKERS-2026-10-11.md`.

**Verdict: the program is NOT ready to be declared closed. RELEASE = NOT APPROVED.** Initial statuses are unchanged: **N-02 = OPEN · PA-33 = OPEN · PA-43 = OPEN · Independent Review = PENDING.** CI = PASS on the documented source (see §2; it was re-run on the final HEAD because the tree changed). Everything that could be done with the authority and resources available was done; what remains needs an authority-holder, a qualified reviewer, or an external resource, and is listed with owners in §8.

Vocabulary: `IMPLEMENTED` (a commit contains it) · `VERIFIED` (clean-snapshot evidence of that commit, author track) · `INDEPENDENTLY ACCEPTED` (a reviewer outside the independence register recorded it — **none**) · `BLOCKED` · `DEFERRED`.

## 0. Baseline taken over
| Check | Result |
|---|---|
| HEAD at start | `247e6585055b924dddbaecd767044b9aefe7d968` (as expected); tracked tree clean; only untracked `_release-output/` release zips and notes |
| Documented source for the earlier CI | `c80395b` (CI Overall PASS); `247e658` differs from it only in documentation |
| CTO approval of `4dc3862` in the decision register | **was not recorded** — only the author's report existed. Recorded now as EV-23 from the owner's written directive of 2026-10-13 (not a separate CTO document) |
| IMPLEMENTED / VERIFIED / ACCEPTED kept apart | yes — see the status matrix in §9 |

## 1. Final HEAD and the source of every run
| Run | Commit | Evidence |
|---|---|---|
| T-03 alone | `b8ed9c2` (clean snapshot) and `4dc3862` | `evidence-clean-snapshot-2026-10-13/b8ed9c2-t03-standalone/`, `…/4dc3862-harness-retry/T-03/` |
| T-04 alone | `0dd0074` (Option A writer) and `4dc3862` (Option B writer) | `evidence-clean-snapshot-2026-10-12/0dd0074-t04-standalone/`, `…2026-10-13/4dc3862-harness-retry/T-04/` |
| T-22, T-23, T-26, T-28, T-29 | `1ae0ae7`, `bcfce72`, `5ecb6c3` | `evidence-clean-snapshot-2026-10-12/` (13 runs; headers, manifests re-verified on 2026-10-13) |
| 91-spec isolation regression | `68c2215` (2026-10-12) and `4dc3862` (2026-10-13, first pass 89/1/1/0) | `…/68c2215-isolation/`, `…/4dc3862-harness-retry/` |
| Full CI gate | `c80395b`; and again on the final HEAD (§2) | `evidence-clean-snapshot-2026-10-13/c80395b-ci-full-tree/` and the final-HEAD folder named in §2 |
No product, test or tool code changed after `4dc3862`; every commit of this closeout after it changes documentation and evidence only (`git diff 4dc3862 <HEAD> -- . ':(exclude)backend/docs'` is empty — verified at the final HEAD, §2).

## 2. CI and full regression
The full gate was re-run, as the owner required, on a clean full-tree `git archive` of **`715c22d02cb88f9187cb9f753d55c6e086d5025e`** — the commit that contains every document of this closeout (the one later commit only adds this CI evidence and this table; documentation only). No code, test or tool file differs from `4dc3862`.
| step | result |
|---|---|
| install (`npm ci`, fresh) | PASS |
| build | PASS |
| lint | PASS — 0 errors, 5 warnings (§7.1) |
| structure | PASS |
| doc-links | PASS — 82 files, 112 references, 0 unresolved |
| unit (unit mode) | PASS — 60 suites / 436 tests |
| db-guard | PASS — 50/50 |
| **Overall** | **PASS** (exit 0) |
Evidence: `evidence-clean-snapshot-2026-10-13/715c22d-ci-full-tree/` (logs on disk, git-ignored; `summary.md`, `CI-RESULT.md`). Caveats unchanged: the script prints `commit: unknown` on an archive (the commit is pinned by `SOURCE_COMMIT.txt` and `DAII_SOURCE_COMMIT`); it is database-free, so the real-PostgreSQL gates are the separate runs of §1/§3 on `4dc3862`; the run was made by the session that wrote the `4dc3862` harness change. The official line "CI NOT GREEN" stays until the CTO classifies the result.

Database-backed regression: not repeated — no code changed after the `4dc3862` run (which passed 89 executed-PASS · 1 SKIPPED · 1 BLOCKED · 0 FAIL, 598 tests passed / 1 skipped / 21 failed, all 21 inside the blocked spec). The earlier CI result is **not** used as proof for any code change: there is none.

## 3. Results by test (author track, clean snapshots; none independently accepted)
| Test | Result | Commit | Note |
|---|---|---|---|
| T-03 alone | PASS (N10/N25/N50 × 20 rounds) | `b8ed9c2`, `4dc3862` | first attempt failed before any test on a stale shell password; recorded, not counted |
| T-04 alone | PASS | `0dd0074` (Option A writer), `4dc3862` (Option B writer) | the earlier PASS did not exercise the final writer |
| T-22 | 2 PASS + case X intentional characterisation (`save()` ignores an explicit seq; reported FAIL-DEFECT by design) | `1ae0ae7`, `bcfce72` | not a failure of the fix |
| T-23 | 7/7 PASS | `1ae0ae7`, `bcfce72` | golden-vector hash unchanged |
| T-26 | 3/3 PASS **after its expectations were inverted** in `b4821ab` | `bcfce72` | L1/L2 used to pass when the unguarded writer succeeded; they now pass only on refusal with `AuditSequenceLagError`, no row added, chain valid, sequence unchanged. No assertion deleted, but this is a change of expectation, not a relabel — the wording "assertions kept" in `test-program/UNIFIED-VERIFICATION-REPORT-2026-10-12.md` is imprecise on this point. The original baseline (`9b52e46`) is preserved |
| T-28 | 12/12 PASS (incl. B9 increment 1 / cache 1, runbook-exact realignment on a disposable database) | `bcfce72` (11/11 on `1ae0ae7`) | |
| T-29 (PA-43 pilot) | P1 PASS, N1 PASS, S1 PASS on the corrected spec; attempt 1 marked failed by the teardown race, attempt 2 clean | `5ecb6c3` | disposable database, simulated only; see §5 |
| T-00, T-03 (post-change) | PASS | `4dc3862` | |
Not executed: `release-migration-registry` (BLOCKED, 21 tests, needs the 5544 pin), `t0-clean-company-baseline` (SKIPPED, opt-in), T-27 (Option A, withdrawn, not run), the six adaptation diffs without line-by-line review, the sibling-method probes of N-02.

## 4. Teardown retry and root cause
`4dc3862` — **IMPLEMENTED, VERIFIED** (unit 6/6; db-guard 15/15; T-00 and T-03 PASS; 91-spec regression with 0 teardown failures where 6 failed before; the retry recovered 2 real occurrences, each on the 3rd attempt after 750 ms). Reviewed here against the owner's conditions: retry is bounded (5 attempts, 250/500/1000/2000 ms); it handles only SQLSTATE `55006` and `42501` + "permission denied to terminate process"; the SQL statement is unchanged; no database privilege or server setting is changed (the test role is still non-superuser without terminate rights; autovacuum on); `teardown()` drops only the three databases the harness created; the original error, attempt count and outcome are logged and stored in `post-cleanup.json`; exhaustion raises a `TEST-INFRASTRUCTURE` error. **Root cause: NOT established** — not reproduced in 34 controlled attempts; autovacuum remains only a hypothesis. It is not described as found or closed.

## 5. N-02, PA-33, PA-43, WP-AUD-09
| Item | IMPLEMENTED | VERIFIED (author track) | INDEPENDENTLY ACCEPTED | Status / blocker |
|---|---|---|---|---|
| N-02 (H3, H1, H2, H4, H5-D1) | `a798d9d`, `5c5b791`, `03900acb` | T-21 13, T-20, T-24, T-25 11/11 on clean snapshots (`71e5f5e`, `0390ac…`) | no | **OPEN**; review pending (§6); siblings of H2 unprobed; residuals R1–R4 of H5-D1 |
| PA-33 / F-AUD-003 | `c764fc5` | T-22/T-23 PASS (above) | no | **OPEN**; review pending; DEC-02 undecided; DEC-01b holders unassigned |
| PA-43 | none (no repair has been changed or run) | pilot only | — | **OPEN**; risk confirmed by code reading and a simulation; real need `NEED NOT ESTABLISHED` |
| WP-AUD-09 | protocol ready | T-29 pilot (disposable DB, READ ONLY with write refused, repair never called, simulation in memory) | — | **BLOCKED**: no approved read-only role, no database list (owner: CTO / environment owner) |
Code read (not a test): the Option B writer takes the advisory lock, reads the head, reads the sequence state, refuses **before** `nextval` when the next value would not exceed the stored tail, draws `nextval`, refuses again if it did not exceed the tail, hashes the drawn value and inserts it explicitly; `setval` appears only in a comment.

## 6. WP-INV-10, WP-AUD-08 and the independent review
WP-INV-10 (`03900acb`) **IMPLEMENTED, VERIFIED**, not accepted. WP-AUD-08 (`4d4ed0d`, Option B) **IMPLEMENTED, VERIFIED**, not accepted; the runbook is an experimental scenario with virtual roles. **INDEPENDENT REVIEW PENDING:** no eligible reviewer exists (every reachable party is an AI session in the independence register; the closeout session is added to it); the pack is complete and split into a code review and a test-evidence review per finding (`DAII-INDEPENDENT-REVIEW-SCOPE-AND-READINESS-2026-10-13.md`). WP-REV-01 remains deferred by the CTO's 2026-10-12 decision.

## 7. Carried items
F-INV-001: IMPLEMENTED `fc9282d`, locally VERIFIED (T-09 36 PASS), release BLOCKED on the usage measurement (DEC-10). D-04: decided Company-scoped, implementation not authorised — BLOCKED. Dependencies: audit re-run 65 advisories (unchanged); tier T1 sized by dry run (22 changes / 9 additions) and **not applied** (DEC-20 open). Capacity targets: DEFERRED (unsigned). Staging host: BLOCKED (external). Details and owners: `DAII-CARRIED-ITEMS-STATUS-2026-10-13.md`.

### 7.1 The five lint warnings (`npm run lint`: 0 errors, 5 warnings — unchanged since `68c2215`)
| # | File:line | Directive | Why it exists | Still justified? |
|---|---|---|---|---|
| 1 | `src/foundation/database-registry/company-connection-manager.service.spec.ts:23` | `eslint-disable-next-line @typescript-eslint/no-var-requires` | guards a `jest.requireMock(...)` assignment | Redundant today: the rule reports nothing in this configuration. Harmless; kept |
| 2 | `src/foundation/testing/biz-harness-smoke.biz.real-pg.spec.ts:6` | `/* eslint-disable … no-var-requires */` | `require('../../../tools/testing/biz-evidence')` (a plain JS tool) | same |
| 3 | `src/foundation/testing/biz-support.ts:1` | `/* eslint-disable … no-var-requires */` | same `require` of the evidence tool | same |
| 4 | `src/foundation/testing/t10-reconciliation.biz.real-pg.spec.ts:4` | `/* eslint-disable … no-var-requires */` | same | same |
| 5 | `src/foundation/testing/t09-inventory-movements-http.biz.real-pg.spec.ts:23` | `/* eslint-disable … no-require-imports */` | `require('supertest')` | Redundant: `eslint.config.mjs` (R2 override, line 58–61) turns `no-require-imports` off for `src/foundation/testing/**` |
Decision: **none removed.** Removing is safe only while the rules stay off; each directive documents a deliberate `require` and would become necessary again if the configuration changes. The removal touches five unrelated files and is optional cleanup for the CTO (zero-warning goal). The `4dc3862` change introduces no new warning.

## 8. Decisions that need an authority-holder
| Decision / input | Owner | Blocks |
|---|---|---|
| Name an eligible independent reviewer (WP-REV-01 / DEC-08 part 1) and fix the review scope | CTO / team coordinator | acceptance of N-02, PA-33, WP-INV-10, WP-AUD-08 |
| DEC-02 — already-broken chains (recommendation: accept and annotate; no rewrite) | CTO + security/audit owner | WP-AUD-05/07; the Phase 1 gate |
| DEC-01b — assign holders to the four functions | CTO | any future operator realignment (none is authorised) |
| DEC-25 final and the WP-AUD-09 inputs: read-only role + explicit database list | CTO / environment owner → DBA | PA-43 |
| DEC-10 — F-INV-001 usage measurement operator and databases | CTO | releasing the 410 contract |
| DEC-20 — approve the T1 dependency scope (and name an owner for T2) | CTO | security gate before the Phase 1 gate |
| D-04 implementation authorisation, review items, owner | CTO | PA-20 |
| DEC-11 — capacity targets, staging host, load authoriser | CTO | PA-24/PA-26 |
| DEC-19 — owners for the seven unwired Layer 2 sites | CTO + site owners | PA-41 |
| DEC-03/04/05/06/18/22/23/24 (business and accounting policy for HR/Payroll/Manufacturing) | business owners | Phase 0 contracts and Phase 1 |
| Classify CI (official line still reads "CI NOT GREEN") | CTO | the release gate |

## 9. Status matrix
| Item | IMPLEMENTED | VERIFIED | INDEPENDENTLY ACCEPTED | BLOCKED | DEFERRED |
|---|---|---|---|---|---|
| N-02 | yes | yes (author) | no | — | review (WP-REV-01) |
| PA-33 / WP-AUD-08 | yes | yes (author) | no | DEC-02, DEC-01b holders | review |
| PA-43 / WP-AUD-09 | no repair exists or was run | pilot only | — | role + database list | — |
| WP-INV-10 | yes | yes (author) | no | — | review |
| Teardown retry | yes | yes | no | — | root cause unproven |
| CI | — | PASS (§2) | — | classification | — |
| F-INV-001 | yes | locally | no | DEC-10 | — |
| D-04 | no | — | — | authorisation | — |
| Dependencies | no | audit re-run only | — | DEC-20 | T2 |
| Capacity / staging | no | local baseline only | — | external inputs, DEC-11 | — |

## 10. Risks that prevent accepting the release
1. N-02, PA-33, PA-43 OPEN and nothing independently accepted. 2. The real-data audit-chain state and any UUID-repair history are unknown (no read access). 3. Already-broken chains have no decided policy. 4. Seven Layer 2 paths can still reach a suspended Company's database (PA-41). 5. 65 dependency advisories, three critical (one runtime-reachable `proxy-addr`), none remediated. 6. Capacity and hosting unverified; no staging host. 7. F-INV-001's 410 contract has no compatibility measurement. 8. D-04: integration connectors have no Company boundary. 9. Blocked/skipped specs and six unreviewed adaptation diffs. 10. HR/Payroll/Manufacturing policies undecided (DEC-03/04/05/22/23/24). 11. No release decision, hosting or production evidence exists in this program.

## 11. What is needed to move to the next roadmap stage
The roadmap's next stage is **Phase 0 contracts (documentation only) → PH0-GATE → Phase 1 (HR and Accounting) design start**, with the Phase 1 exit gate requiring independent reviews of P0-A…P0-D, dependency tier T1 applied, and gate evidence reviewed by someone other than the author. Concretely:
1. Appoint the independent reviewer and run the two-track review (§6) — required for the Phase 1 exit gate, not for starting Phase 0.
2. Take the §8 decisions marked as blocking the gate: DEC-02, DEC-20 (T1), DEC-25 inputs, DEC-01b holders.
3. Phase 0 can start in parallel and needs only documentation: the business owners answer DEC-03/04/05/06/18/22/23/24 so the HR/Accounting/Manufacturing contracts (PH0-HR, PH0-MFG) can be written and signed off.
4. Provide the environment inputs (staging host, authoriser, capacity targets; read-only role and database lists) so the verification items that depend on them can run.
5. Re-run the full gate on a named final commit when any code change is approved (T1 dependencies, D-04, LA-1 wiring); until then, no code change is pending.
No release decision is proposed.
