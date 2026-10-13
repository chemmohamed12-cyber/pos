# DAII — Independent review: scope, split and readiness for N-02, PA-33, WP-INV-10 and WP-AUD-08 — 2026-10-13

**Status: `INDEPENDENT REVIEW PENDING`.** No finding is independently accepted. WP-REV-01 was deferred by the CTO on 2026-10-12 for lack of a qualified engineer; the owner's directive of 2026-10-13 asks for direct coordination with a qualified reviewer. **Coordination result:** the only sessions reachable from this repository are AI sessions that belong to the same lineage (the listing shows no human reviewer and no one outside the register of the pack index §3.1); none qualifies. No substitute is claimed. This document makes the pack complete so the review can start the day an eligible person arrives. It supplements `DAII-INDEPENDENT-REVIEW-EVIDENCE-PACKAGE-INDEX-2026-10-11.md` (independence register, per-finding checklists) and `test-program/INDEPENDENT-REVIEW-EVIDENCE-PACK-2026-10-11.md`; it does not replace them.

## 1. Independence register — additions since 2026-10-11
| Party | Did | Excluded for |
|---|---|---|
| Handover/closeout session (2026-10-13) | wrote and committed `4dc3862` (teardown retry); ran T-03/T-04/T-00 on `b8ed9c2`/`4dc3862`, the 91-spec regression, the CI gate; wrote the closure reports | WP-AUD-08 evidence, the harness, CI; every item whose evidence it produced |
| LA-1 / WP-4.1 lane (this repository's multi-company track) | wrote the Layer-2 admission code swept into `60b9bdf` | LA-1 items (not a subject of this review) |
Everything else in the 2026-10-11 register stands. The reviewer may not be anyone in either register.

## 2. Two separate reviews (not to be merged into one sign-off)
**Track A — code review (reads source and diffs; runs nothing unless it needs to).** **Track B — test-evidence review (reads headers, manifests, result files and specs; judges whether the evidence proves what is claimed).** A reviewer may do both but must record them separately, per finding.

| Finding | Fix commit(s) → files | Track A — questions to answer | Track B — evidence and what to check |
|---|---|---|---|
| **N-02 H3** `fulfillReservation` double dispatch (and order-level) | `a798d9d`, `5c5b791` → `domains/inventory-warehouse/application/inventory.service.ts` | Lock key shared with `reserveStock`/`releaseReservedQuantity`; re-read after locking; status flip and movement in one transaction; sorted up-front locking at order level; lock ordering reservation → valuation → audit; rollback restores reservation and movement; retry semantics (second call → 409) | `evidence-clean-snapshot-2026-10-11/71e5f5e-final/` (T-21 13, T-20 H3), `71e5f5e-reviewer-rerun/`; baseline `a6002fa`; header `commit`/`dirtyPaths`/`sourceKind`; result files counted, not narrative |
| **N-02 H1** limit engine | `5c5b791` → `foundation/limit-engine/limit.service.ts` | `consume`/`release` apply the shared transaction rule unchanged; `check()` is read-only; counters after rollback | T-24 (12 allowed vs cap 10 before, PASS after); `961dacd-t24-baseline-unfixed/` |
| **N-02 H2** `releaseReservedQuantity` | `5c5b791` → `inventory.service.ts` | over-release impossible; siblings (`relocateReservedStock`, `releaseReservedQuantityForReference`, `releaseReservation`) share the idiom | T-24/T-20 H2; **siblings NOT RUN** (WP-INV-09) — state this limit in the verdict |
| **N-02 H4** racing `ProcessEngine.start` | `5c5b791` → `foundation/process-engine/process-engine.service.ts` | `INSERT … ON CONFLICT DO NOTHING` target equals `IDX_process_instances_unique`; the index exists in every database (migration `1755841300000`) | T-24/T-20 H4 |
| **N-02 H5-D1 / WP-INV-10** shipment transition | `03900acb` → `domains/shipment/application/shipment.service.ts` | `transitionShipment` runs in one transaction via `runInTransaction`; custody transfer failure rolls back state, events, movements, reservations; outer-transaction rollback | `0390ac-wp-inv-10/` (T-25 11/11; six regression specs); residuals R1–R4 of the closeout report §2 |
| **PA-33 / F-AUD-003** | `c764fc5` → `foundation/audit/audit.service.ts` | `nextval` drawn after the head read under the chain lock; explicit insert covers all 13 columns; hash format unchanged (golden vector); gaps harmless to verification; no other writer of `audit_records` | T-22/T-23 on `71e5f5e` and `bcfce72`; T-22 case X is an intentional characterisation (`save()` ignores an explicit `seq`) |
| **WP-AUD-08 / Option B** | `4d4ed0d` → `audit.service.ts`; tests `t26`, `t28`, `t29`, `biz-run.js` | refusal occurs **before** `nextval` (no sequence consumed by a refusal); `setval` appears only in a comment (the executable writer never realigns); the post-`nextval` check is a second guard; reliance on increment 1 / cache 1 (only test B9 asserts it); `SELECT … FROM <sequence>` uses the name returned by `pg_get_serial_sequence` | `evidence-clean-snapshot-2026-10-12/1ae0ae7-option-b/`, `bcfce72-audit-regression/` (T-28 12/12, T-26 3/3 relabelled as refusals, T-23 7/7, T-22), `evidence-clean-snapshot-2026-10-13/4dc3862-harness-retry/T-04/` (Option B writer); **T-26 was changed in `b4821ab`, not only relabelled:** the L1/L2 cases used to PASS when the unguarded writer succeeded (`l1.ok`/`l2.ok` and a valid chain); they now PASS only when the writer refuses with `AuditSequenceLagError`, no row is added, the chain stays valid and the sequence is unchanged (`sequenceLastValue === 1`; row counts compared). The expectation was inverted to match the CTO-ruled Option B, with stronger post-conditions; no assertion was deleted. The reviewer should confirm that this inversion is faithful to the ruling and that the original baseline (commit `9b52e46`, evidence `9b52e46-t26/`) is preserved as the record of the unguarded behaviour |

## 3. Facts the reviewer should have (from the closeout re-check, 2026-10-13)
1. The standalone T-04 PASS of 2026-10-12 (`0dd0074`) ran against the withdrawn Option A writer; T-04 alone on the Option B writer passes on `4dc3862` (additional evidence, both kept).
2. All run headers of the 2026-10-12/13 evidence match their folders' `SOURCE_COMMIT.txt`, `dirtyPaths: []`, `sourceKind: clean-git-archive-snapshot`; all manifests verify (0 mismatches).
3. Isolation regression on `4dc3862`: 89 executed-PASS · 1 SKIPPED · 1 BLOCKED · 0 FAIL on the first pass; BLOCKED = `release-migration-registry` (21 tests, needs the 5544 pin), SKIPPED = `t0-clean-company-baseline` (opt-in). Neither executed its tests.
4. The runner prints the BLOCKED spec as `RESULT FAIL` and the SKIPPED one as `RESULT PASS`; classification comes from the Jest summaries.
5. Logs are git-ignored; only their SHA-256 are committed.

## 4. Requirements to run the review
| Need | State |
|---|---|
| A named eligible person (not in either register; competent in PostgreSQL locking, NestJS/TypeORM transactions, hash-chain integrity) | **not available** |
| Read access to the repository and the evidence folders only (no production or hosting access) | ready |
| Intake data for the CTO (name, role, prior involvement, access) and the CTO's fixing of scope | defined in the pack index §3.3 |
| Tests re-run | **not requested**; the reviewer asks for a specific re-run only for a specific gap |
| Per-finding decision form | accepted / needs additional evidence (state the gap) / needs another remediation, per finding and per track |

## 5. Exit statement
Until a qualified reviewer records decisions, every item above stays `IMPLEMENTED` and (author-track) `VERIFIED`, never `INDEPENDENTLY ACCEPTED`. Verified scope and limits: single-instance, isolated disposable databases, READ COMMITTED; no multi-instance, production, hosting or real-data evidence.
