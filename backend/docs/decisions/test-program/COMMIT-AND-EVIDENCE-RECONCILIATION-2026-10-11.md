# Commit and evidence reconciliation (verification track) — 2026-10-11

Purpose (CTO directive §8): state exactly which commit each piece of evidence belongs to, which files were inherited from the parallel TEST-03 track, and which uncommitted changes were in the working tree. Nothing here claims a commit was verified unless the evidence was produced from a **clean `git archive` snapshot of that commit**. Single committer identity for every commit below: `DAII Workspace` (git user name; the two sessions share one working tree and one identity, so authorship cannot distinguish them).

## 1. How evidence is attributed
- Every business-suite run writes `run-header.json` with `commit` and `dirtyPaths`. Before 2026-10-11 these were read from the shared repository (`git rev-parse HEAD`, `git status`): the value is the HEAD **at run time plus the uncommitted files listed in `dirtyPaths`** — it is **not** a statement that the commit alone was tested.
- From commit `6d062cb` a run started with `DAII_SOURCE_COMMIT=<40 hex>` pins the snapshot's own commit (`sourceKind: clean-git-archive-snapshot`, `dirtyPaths: []`). That is how the clean-snapshot runs below are attributed. (The first clean-snapshot attempt, 23e5ec1, ran before this fix: its T-10 correctly refused because HEAD moved during the run — see §3.)
- The tests resolve migrations from the compiled `dist/database/migrations` directory: a snapshot must be built (`tsc -p tsconfig.build.json`, 0 errors) before any real-Postgres run; the first two snapshot attempts failed for that reason (no `dist`) and for leftover disposable databases of the failed first attempt (dropped; logs kept).

## 2. Commit map (verification track and parallel track)
| Commit | Content | Track |
|---|---|---|
| `fc9282d`, `6814643`, `a55ed87`, `28829d9` … | defect remediation (F-AUD-002/F-TRS-001/F-PAY-001/F-INV-001/T-06x), business suite, reports | verification |
| `cff8a53` | BOM wired in harness (T-02d), T-15, `@deprecated` wrapper, F-INV-001 queries, closure report | verification |
| `e9be53a` | namespaced real-PG regression path, T-16, workload proposal, final report | verification |
| `f14f162` | parallel track's TEST-03 assessment commit; it **also contained files authored by the verification track** that were in the shared working tree: `regression-specs-2/3.txt`, `capacity-loadgen.js`, `STAGING-CAPACITY-PROFILE`, `CAPACITY-DECISION-BRIEF`, `F-INV-001-OPERATOR-EXECUTION-GUIDE`, `EVENT-OUTBOX-DISPATCH-BEHAVIOUR`, the products/delivery prefix renames, T-17 probe spec, evidence of the 60-spec run | mixed (shared tree) |
| `74920fc` | verification closure report (docs only) | verification |
| `23e5ec1` | **N-01 code**: `run-in-transaction.ts`, numbering, process-engine, audit, treasury, payment-apply | parallel (code), verified by verification |
| `1829794`, `258965f`, `d51a751`, `153cd8c`, `0ba4c82`, `4548d0c`, `20bf525` | R1/R2/lint, status records, dependency audit D-01, untracking D-05, T-20 probe, D-02 tooling | parallel |
| `a314e18` | 10 more specs under the namespace (+`fanout` fixtures moved inside the project root), T-19 spec, `REGRESSION_NS`, narrow-decision record, offline dependency inventory | verification (re-applied on top of the parallel track's lint-fixed multi-process spec) |
| `6d062cb`, `4011365` | evidence header pins snapshot commit; T-19 customer wiring | verification |
| `7097796` | **registerDocumentType atomic insert** (N-02 fix) | parallel (code) |
| `a6002fa` | T-19 HTTP-level `POST /customers` and registerDocumentType probes | verification |

## 3. What was tested on which commit
| Evidence | Source of truth | Commit actually exercised | Status |
|---|---|---|---|
| Earlier working-tree runs T-00…T-17 (e.g. `T-00…T-15` headers `fc9282d` + 13 dirty paths, `T-16` `cff8a53` + 15, `T-17` `74920fc` + 21) | `evidence-2026-10-10-biz/T-xx/<run>/run-header.json` | HEAD at the time **plus** uncommitted files | historical evidence; **not** claimed as a verification of a commit |
| Clean snapshot of `23e5ec1` | `evidence-clean-snapshot-2026-10-11/23e5ec1/` | `23e5ec1` exactly, `dist` built from it | business suite: all steps PASS except T-10, which STOPPED only on its "one consistent commit" rule because the repository HEAD moved during the run (the snapshot headers carried 4 different parent-repo HEADs); the R1–R10 checks themselves reported no problem — **tool artifact, fixed in `6d062cb`** |
| Clean snapshot of `4011365` | `evidence-clean-snapshot-2026-10-11/4011365/` | `4011365` exactly | business suite T-00…T-19 PASS except T-07 (STOP: the parallel track created `daii_test_biz_t20_*` on the shared cluster during the run — evidence in `post-cleanup.json`; **T-07 re-run alone PASS**, log kept) and the known informational FAIL-DEFECTs (T-06x legacy wrapper; T-18 schema-drift probe of the parallel track); T-19: customer/price-list/sales-rep 80/80, **supplier first use 71/80 (N-02)**; unit 59/430; guard 50/50 (after adding the docs folders the guard tests read) |
| Clean snapshot of `74920fc` + T-19 spec overlay (before the fix) | `evidence-clean-snapshot-2026-10-11/74920fc-before-fix-T19/` | `74920fc` (pre-N-01) + the T-19 spec | contrast: customer 18/80, supplier 9/80, price list 8/80, sales rep 25/80 succeed under concurrency; transaction-wrapped controls 80/80 |
| Clean snapshot of `a6002fa` (final) | `evidence-clean-snapshot-2026-10-11/a6002fa/` | `a6002fa` exactly (contains N-01 `23e5ec1` + N-02 `7097796`) | see §4 |

## 4. Final-commit results (`a6002fa`)
Clean `git archive` snapshot of `a6002fa` (= `23e5ec1` N-01 fix + `7097796` N-02 `registerDocumentType` fix + verification-track test commits), `dist` built from the snapshot (tsc 0 errors), evidence headers pinned to `a6002fa` with `dirtyPaths: []`. Evidence: `evidence-clean-snapshot-2026-10-11/a6002fa/`.
| Check | Result |
|---|---|
| Business suite T-00…T-20, single sequential run (`biz-full.log`, exit 0) | all steps PASS: T-00 1, T-01/T-02 18 (T-02d PASS), T-03/T-04 20, T-05 13, T-06 15 + T-06x-INFO FAIL-DEFECT (known legacy-wrapper probe), T-07 13, T-08 13, T-09 36, T-10 PASS (R1–R10, one consistent commit), T-11 15, T-12 14, T-13/T-14 2+2, T-15 13, T-16 13, T-17 6, **T-19 15/15** |
| T-19 (per-endpoint N-01) | customer / supplier / price-list / sales-rep creates 80/80 each in plain and transaction style with distinct codes; **HTTP `POST /api/customers` 120/120 → 201 with 120 distinct codes**; `registerDocumentType` first-use probe PASS (plain and transaction, 10/10 rounds, 1 row each). Contrast before the fix (`74920fc`): 18/80, 9/80, 8/80, 25/80 |
| Isolation specs that call `registerDocumentType` (20 of the 24 files that mention it; the other 4 are business-suite T-specs) | **20/20 PASS** (`regression-registerdoc.log`) |
| Unit suite | **59 suites / 430 tests PASS** |
| Guard suite | **50/50 PASS** |
| Not mine and not N-01: T-18 (schema-drift probe, 3 FAIL-DEFECT) and T-20 (parallel track's diagnostic probes: 6 FAIL-DEFECT, 2 PASS, 1 BLOCKED — limit engine, reservation release/fulfil double-dispatch, process start) | recorded, open, not remediated; outside the N-01 authorisation |

## 5. Uncommitted changes present in the shared working tree during the working-tree runs (excluded from the clean-snapshot claims)
`preliminary-hold-expiry.scheduler.ts` + `.spec.ts`, `approval-expiry.scheduler.ts` + `.spec.ts`, `installation-audit.controller.ts`, `company-audit-access.real-pg.spec.ts` (other tracks, uncommitted), `company-lifecycle-admission.ts` + `.real-pg.spec.ts` and the LA-1 specification (LA-1), `FINAL-CLOSURE-PACKAGE.md`. None is imported by the business-suite specs (`src/foundation/testing/*` has no import of them) and the two scheduler specs are not in the unit-mode list, so the working-tree results are not expected to differ; the clean snapshots remove the question. These files were not staged or modified by the verification track.

## 6. Residual caveats
- All commits share one author identity; the sessions share one working tree and one database cluster — runs must be serialised (two collisions happened and are documented: T-07 on 4011365, T-19 on 03:07).
- The clean snapshots contain `src`, `tools`, package/tsconfig/jest files and the specific `docs` folders the guard tests read; `node_modules` is a junction to the installed dependencies (same versions as the lock file at that commit was not re-installed: `npm ci` from the lock file was not run in the verification track — the parallel track's CI script did run install/build/lint/unit/guard from a clean archive at `258965f`).
