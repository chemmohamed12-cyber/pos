# DAII — Independent review: evidence package index, independence register and reviewer profile — 2026-10-11

Prepared by Team 3 (documentation and coordination) for the reviewer who will be named under DEC-08. **Team 3 cannot name a person** (no identity is known to it) and its own review is not a substitute for the independent review (CTO decisions of 2026-10-11). The coordinator of the team is asked to nominate a qualified candidate who meets §3. This document is an index and checklist; it closes nothing and changes no evidence.

Reference: documentation `5639554`; repository HEAD at writing `6793607`. Official status: **N-02 OPEN · PA-33 OPEN · PA-43 OPEN · CI NOT GREEN · RELEASE NOT APPROVED.**

## 1. What the reviewer is asked to decide
For each finding below: **accepted for closure**, **needs additional evidence** (state the specific gap), or **needs another remediation**. Re-running everything is not requested; extra tests are requested only for a specific gap. Findings are decided separately; a decision on one never implies another.

## 2. Findings and their evidence (all provenance below was checked by Team 3 from the evidence files; nothing was re-run)
Clean-snapshot folders are under `backend/docs/decisions/evidence-clean-snapshot-2026-10-11/`. "Header check" = run headers read: commit, `dirtyPaths`, `sourceKind`.

| Finding | Fix / change (commit) | Clean-snapshot evidence | Header check | Peer review on record | Open points the reviewer should weigh |
|---|---|---|---|---|---|
| **H3** `fulfillReservation` double dispatch (and order-level) | `a798d9d` (patch content by the verification session); order-level sorted-key locking in `5c5b791` | Baseline (unfixed): clean snapshot `a6002fa` T-20 H3 (6 movements, on-hand −18); the unfixed T-21 baseline is working-tree class; fixed: `b591d1f-n02/`, `71e5f5e-final/`, `71e5f5e-reviewer-rerun/` (T-21 13 PASS, T-20 H3 PASS in both styles) | 71e5f5e: 23 of 23 clean, `dirtyPaths: []`; f881e53: 6 of 6 clean | `c804845` (patch), `89a0a2a`, `5104e1e`, `66c63b9` (consolidated; deadlock analysis, case I/J) | Lock ordering and the sorted-key change; reachability through delivery (INFERRED, no HTTP-level double-confirmation test: WP-INV-03); order-level repeat is now an idempotent no-op (E2); deadlock edge "valuation lock before first audit write" unproven |
| **H1** limit engine overshoot | `5c5b791` (`LimitService.consume`/`release` via the shared rule) | Baseline `961dacd-t24-baseline-unfixed/` (T-24: 12 allowed against a cap of 10; release left counter 4 instead of 0); fixed: T-24 and T-20 H1 PASS in `71e5f5e-final/` and the reviewer re-run | clean | `89a0a2a` (no defect reported) | `check()` is read-only and unchanged; limit-gated creation paths not probed (S4) |
| **H2** `releaseReservedQuantity` over-release | `5c5b791` | Baseline: 12 of 12 releases succeeded for 5 reserved; fixed: T-24/T-20 H2 PASS on both clean snapshots | clean | `89a0a2a` | siblings `relocateReservedStock`, `releaseReservedQuantityForReference`, `releaseReservation` have the same idiom and are NOT RUN (WP-INV-09) |
| **H4** racing `ProcessEngine.start` | `5c5b791` (`INSERT … ON CONFLICT DO NOTHING` on `IDX_process_instances_unique`) | Baseline: errors under racing starts (plain 2, transaction 9); fixed: T-24/T-20 H4 PASS | clean | `89a0a2a` (correct provided the unique index exists in every database; it is created by migration `1755841300000`) | none beyond the index assumption |
| **F-AUD-003 / PA-33** audit hash vs stored `seq` after rollback | `c764fc5` (`audit.service.ts`) | T-22/T-23 PASS in `71e5f5e-final/` and the reviewer re-run (T-23 7/7; T-22's explicit-seq case is a by-design characterisation); pre-fix reproduction: T-22 on `b591d1f-n02/` | clean | `89a0a2a`; Team 3 scope review `DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md` (conformity to the authorization only) | `save`→raw insert + `create` return (no hooks/subscribers/transformers; no caller uses the return value — see the scope review); historical broken chains untouched (DEC-02); sequence-lag after import/restore reproduced on current code by **T-26** (two failure modes), guard not implemented; PA-43 is a separate path |
| **H5** shipment transitions (measurement, not a fix) | `06ef615` (test fixture `t25`) | `06ef615-h5/`: 8 PASS, 1 FAIL-DEFECT (**H5-D1**: plain-manager pickup with a failing custody transfer leaves the shipment `picked_up` and a reservation drained) | 1 of 1 clean | `WP-INV-07-H5-SHIPMENT-TESTABILITY-REPORT-2026-10-11.md` | The H5-D1 fix is committed as `03900acb` (WP-INV-10; authorized by the CTO closeout directive; implemented / verification pending): one-line change in `ShipmentService.transitionShipment` to the shared `runInTransaction`, plus the T-25 case H5-3b and a regression-spec list. **Its clean-snapshot evidence has not been published; until it is, the row above is the pre-fix measurement and the fix is not part of the reviewable evidence.** Review H5-D1 only after that evidence exists. The T-25 doubles limit the claim to the tested shape |
| **T-26** sequence-lag baseline (observation) | `9b52e46` (test only) | `9b52e46-t26/`: L0 PASS, L1 FAIL-DEFECT (duplicate key, loud), L2 FAIL-DEFECT (silent out-of-order append, chain broken) | 1 of 1 clean | consolidated report `CONSOLIDATED-EXECUTION-REPORT-WP-INV-07-AND-PA33-BASELINE-2026-10-11.md` | guard design is an open decision (DEC-01b) |
| **T-03 / T-04** concurrency | none (not a fix) | `T-03` step 20 PASS on `71e5f5e` and `f881e53` (4 T-03 + 6 T-04 + 10 R1–R10) | clean | — | **T-04 alone has not been run**; CTO authorised a quiet-cluster individual run; the spec is one `it` (`T-03 + T-04 + T-04b`), so it needs a test-only split first |

Supporting evidence: unit 59 suites / 430 tests and guard 50/50 on `71e5f5e`; isolation run of 91 files on `71e5f5e` (89 executed PASS, 1 skipped opt-in suite, 1 known-BLOCKED failure; attribution by folder, the log has no commit header); N-01 evidence `a6002fa` (separate stream, not part of this review). Historical figures are kept in the reconciliation note §7.

## 3. Reviewer independence — exclusions and profile
### 3.1 Independence register (who did what; the git identity "DAII Workspace" is shared, so history alone cannot attribute work)
| Party | Wrote or did | Therefore excluded as reviewer for |
|---|---|---|
| Verification session (Claude, session `cece860d`) | Patch content of `a798d9d`; `c764fc5`; `5c5b791`; specs and fixtures T-21…T-26; clean-snapshot pipelines; the H5-D1 fix (`03900acb`) and its evidence | all findings above |
| Implementation / peer-review session (Claude) | `runInTransaction` (`23e5ec1`) and `registerDocumentType` (`7097796`); the T-20 baseline probes; the N-01 closure review; the peer reviews `c804845`, `89a0a2a`, `5104e1e`, `66c63b9`; the T-03 re-run at `f881e53` | all findings above (wrote the helper the fixes call) |
| Team 3 session (Claude, `9910b9fe`) | **Created the git commits `a798d9d` and `60b9bdf`** at the user's instruction (sweeping the verification session's and the LA-1 track's uncommitted edits); read the diffs; wrote the scope review and all planning documents | all findings above (CTO ruling) |
| LA-1 track | Code swept into `60b9bdf` (admission mechanism, schedulers, installation-audit controller) | LA-1/CI items |
No human has been identified in the records; every party above is an AI session working in the same repository, cluster and git identity.

### 3.2 Profile of the candidate to nominate (by the team coordinator)
1. Did not write the fixes, the tests, the fixtures, `runInTransaction`, or the peer reviews; did not take part in committing the reviewed changes; not Team 3.
2. Competent in PostgreSQL locking (advisory and row locks, READ COMMITTED behaviour, deadlock detection), NestJS/TypeORM transactions and entity manager semantics, and hash-chain integrity.
3. Has read access to the repository and the evidence folders only; no production or hosting access is needed or permitted.
4. Will record the decision per finding and the evidence examined, and will state limitations and conflicts of interest.
Until a candidate is named, the review does not start; no one in the register in §3.1 substitutes.

## 4. Review checklist (per finding)
**H3 / order-level:** lock key shared with `reserveStock` and `releaseReservedQuantity`; first read only learns `(warehouse, product)`; re-read under the lock; status flip and movement in one transaction; behaviour under `READ COMMITTED` only; lock ordering across reservation key → valuation key → audit key; sorted up-front locking in `fulfillReservationsForOrder`; retry semantics (second call refused 409 for a single reservation, no-op at order level); rollback restores reservation and movements; reach through `delivery.service.recordOutcome` and the shipment state machine.
**H1/H2/H4:** the shared transaction rule applied unchanged; `ON CONFLICT` target equals the unique index; counters and reservations after rollback; unchanged behaviour of successful single calls.
**F-AUD-003:** `nextval` drawn after the head read under the chain lock; explicit insert covers all 13 entity columns; hash format unchanged (golden vector); gaps harmless to verification; no other writer of `audit_records` (searched); effect on existing broken chains (none); residuals (sequence-lag, raw insert maintenance, two extra statements).
**All:** clean-snapshot headers match the claimed commit; `dirtyPaths` empty; results are counted from result files, not narrative; working-tree runs are not used as proof.

## 5. Items to finish before or alongside the review (not prerequisites for nominating a reviewer)
| Item | Owner | State |
|---|---|---|
| T-04 individual run on a quiet cluster (needs a test-only split of the combined spec; assertions unchanged) | Verification track | authorised, not run |
| Line-by-line review of six adaptation diffs (`company-membership-provisioning`, `company-datasource-factory-impact`, `company-datasource-registry-isolation`, `company-migration-runner`, `restore-manager-audit-chain`, `company-database-pool.multi-process`) | independent reviewer (may be the same person) | no review record |
| H5-D1 fix: clean-snapshot evidence of commit `03900acb` (T-25 incl. H5-3b both styles; six regression specs of `regression-specs-wp-inv-10.txt`) | Verification track | fix committed; evidence not yet published |
| LA-1 lint errors (3) | LA-1 owner | open; CI NOT GREEN |
| WP-AUD-09 need check | Audit/Architecture track | protocol ready; needs approved read-only access |
| Sibling probes | Verification track | specified, not run |

## 6. What the reviewer's pack must not be used for
It is not an acceptance of any finding and not a release decision. Evidence for one path is not generalised to the system.
