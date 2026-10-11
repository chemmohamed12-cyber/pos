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
