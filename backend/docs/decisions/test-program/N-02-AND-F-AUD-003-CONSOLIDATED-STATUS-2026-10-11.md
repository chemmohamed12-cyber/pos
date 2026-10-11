# N-02 and F-AUD-003 — consolidated status (verification track), 2026-10-11

Scope: local, non-production, dedicated cluster 127.0.0.1:5546, unchanged database guard. Release status: **NOT APPROVED**. Closing any item below does not approve the release. Status words: PASS / FAIL-DEFECT / BLOCKED / NOT RUN. **No item in this document is closed**: every closure needs the CTO's decision on the independent reviews (§4).

## 1. Commits and changed-file scopes
| Commit | What | Files (product code in bold) |
|---|---|---|
| `a798d9d` | `fulfillReservation` fix (complete) | **`inventory.service.ts`** (4 hunks, +11/−2), `t21` spec, `f-aud-rollback-reproducer` spec, `biz-run.js` |
| `b591d1f` | evidence only | T-21/T-22 evidence, logs |
| `c764fc5` | **F-AUD-003** | **`foundation/audit/audit.service.ts`** (+27/−9); `t23-audit-seq-hash` spec; `f-aud-rollback-reproducer` extended (TypeORM explicit-seq characterisation); T-22/T-23 evidence |
| `5c5b791` | remaining N-02 findings + order-level deadlock | **`limit.service.ts`** (consume/release), **`inventory.service.ts`** (`releaseReservedQuantity`, `fulfillReservationsForOrder`), **`process-engine.service.ts`** (`start`); `t24` spec; `t21` extended; T-20/T-21/T-24 evidence |
| `71e5f5e` | tests/evidence only | T-21 case J (override warehouse) and E2 (order-level idempotency); T-24 baseline on a clean snapshot of `961dacd`; partial log of the pipeline I aborted for `5c5b791` |
Provenance note: the patch of `a798d9d` was authored by this (verification) session; **which session ran `git commit` for `a798d9d` cannot be established** (both sessions share one git identity and one working tree). `a798d9d`, `60b9bdf` (LA-1 track) and `b591d1f` carry the same minute. `inventory.service.ts` is unchanged between `a798d9d` and `b591d1f`.

## 2. Baseline versus post-fix
| Finding | Baseline (reproduced before the change) | After |
|---|---|---|
| `fulfillReservation` duplicate movements | T-20 H3, clean snapshot `a6002fa`: 6 movements for a reservation of 3, on-hand −18 (both styles); T-21 unfixed: 8 movements, −24 in a transaction | T-21 A–H PASS; T-20 H3 PASS both styles |
| Order-level fulfilment | T-21 unfixed: 4 movements per product (−8) | E PASS (1 success, 3 × 409, 1 movement per product); E2: repeat call = idempotent no-op |
| Deadlock between overlapping orders (found by the independent review) | T-21 case I with the `a798d9d` code: **12 deadlocks (40P01) in 24 calls**, 12 of 24 movements | after sorted up-front key locking: 0 deadlocks, 24/24 (case I); override-warehouse variant (case J): 0 deadlocks, 24/24 |
| **F-AUD-003** audit chain after a rolled-back audit write | T-22 / T-23 on the old code: chain invalid from seq 5 (R1, R2, C1, C2 FAIL-DEFECT); stored seq ≠ hashed seq; TypeORM `save()` ignores an explicit seq (requested 9000, stored 5) | T-23 R1, R2, C1 (40 concurrent appends), C2 (20 commit + 20 rollback, concurrent), H (hash golden vector unchanged), P1 (existing healthy chain keeps verifying), P2 (existing broken chain preserved byte-for-byte, still reported, new rows link to its tail) all PASS; T-22 PASS; T-21 H-after-D PASS |
| H1 limit engine | T-24 on clean snapshot `961dacd`: 12 allowed vs cap 10; concurrent release left counter 4 instead of 0 | T-24 H1 PASS (cap respected, rollback restores quota, release floors at 0); T-20 H1 PASS |
| H2 `releaseReservedQuantity` | T-24 baseline: 12 of 12 releases succeeded for 5 reserved, 2 still active, reserved 1 | T-24 H2 PASS (5 succeed, 7 × 409, 0 active, outer rollback restores, retries refused); T-20 H2 PASS |
| H4 `ProcessEngine.start` | T-24 baseline: errors on racing starts (plain 2, transaction 9) | T-24 H4 PASS (10/10 callers succeed with one instance id; rollback-then-retry idempotent); T-20 H4 PASS |

## 3. Clean-snapshot evidence and provenance
Working-tree runs (`dirtyPaths` ≠ 0) are marked as such and are **not** counted as clean-snapshot proof. Clean `git archive` snapshots (headers pinned with `DAII_SOURCE_COMMIT`, `dirtyPaths: []`): `961dacd` T-24 baseline (`evidence-clean-snapshot-2026-10-11/961dacd-t24-baseline-unfixed/`); `b591d1f` fulfil fix (`…/b591d1f-n02/`); final pipeline of `71e5f5e` (`…/71e5f5e-final/`):
Clean `git archive` snapshot of **`71e5f5e`** (= `a798d9d` fulfilReservation fix + `c764fc5` F-AUD-003 + `5c5b791` remaining N-02 + test/evidence commits; the tree also contains the LA-1 track's `60b9bdf` and the reviewer's documents), `dist` built from the snapshot (tsc 0 errors), evidence headers pinned to `71e5f5e` with `dirtyPaths: []`. Commands: `DAII_SOURCE_COMMIT=<sha> node tools/testing/biz-run.js --continue-after-failure`; `REGRESSION_NS=biz_t91_ node tools/testing/biz-run.js --regression tools/testing/regression-specs-all.txt`; `npm run test:unit`; `npm run test:db-guard`. Evidence: `evidence-clean-snapshot-2026-10-11/71e5f5e-final/`.
| Check | Result |
|---|---|
| Business suite T-00…T-24, one sequential run (`biz-full.log`, exit 0) | all steps PASS at jest level; case level: T-10 reconciliation PASS (R1–R10); T-20 **8 PASS + H5 BLOCKED**; T-21 **13/13 PASS** (A–J, E2, G, H); T-23 **7/7 PASS**; T-24 **10 PASS + H5 BLOCKED**; T-22 2 PASS + 1 informational characterisation (`explicit-seq-honoured-by-save` = FAIL-DEFECT by design: it proves TypeORM ignores an explicit seq, the reason for the fix); T-19 15/15; T-06 keeps the known T-06x legacy-wrapper probe; T-18 keeps the parallel track's 3 FAIL-DEFECT |
| All namespaced real-Postgres isolation specs (91 files, includes every inventory / reservation / delivery / fulfilment / treasury / payment / audit area) | **90 PASS, 1 FAIL** — the single failure is `release-migration-registry.real-pg.spec.ts`, the already-classified BLOCKED spec whose own safety assertion hard-codes port 5544 ("Refusing to run … DB_PORT=5544", unchanged, not a product result) |
| Unit | 59 suites / 430 tests PASS |
| Guard | 50/50 PASS |
Not part of this run: the other 9 BLOCKED specs (6 on the 5544-pinned helper — the one above is among them — and 3 role-creating), `company-audit-access.real-pg.spec.ts` (held), multi-instance and hosting checks.

## 4. Independent review — identity, role, conclusion
Two review documents by the reviewer session, committed in this repository: `N-02-FULFIL-RESERVATION-INDEPENDENT-REVIEW-2026-10-11.md` (patch `a798d9d`) and `N-02-F-AUD-003-AND-REMAINING-INDEPENDENT-REVIEW-2026-10-11.md` (`c764fc5`, `5c5b791`). **Independence is limited and disclosed, not proven:** the reviewer did not write the audited patches, but it wrote `runInTransaction` (N-01, used by them) and the T-20 baseline probes, shares the repository, cluster and git identity, and is another Claude session. As instructed, the CTO's gate is: independence of the reviewer from the author, exact commit and snapshot identified, code AND evidence inspected, limitations documented, explicit statement on the fulfillReservation acceptance criteria. The reviews meet the last four; the first is for the CTO to judge — **if it is not accepted, another reviewer is needed**. Review findings and what was done: deadlock risk → reproduced (case I) and fixed; override-warehouse variant → probed (case J, PASS); the reviewer then verified in the code that valuation locks are not taken inside the fulfilment transaction (cost is resolved when the outbox event is processed after commit) and withdrew the concern as not substantiated (addendum committed by the reviewer); the only unproven edge is a path that takes a valuation lock before its first audit write in the same transaction — none exists for fulfilment; order-level repeat now succeeds as a no-op → asserted (E2) and documented; audit seq-lag after restore/import → documented residual (no code path inserts explicit seq today; optional guard `GREATEST(nextval, max(seq)+1)` not implemented, needs a decision); no defect found in the F-AUD-003 patch.

## 5. Status of each N-02 finding (separately)
| Finding | Status |
|---|---|
| `fulfillReservation` double dispatch | fix implemented; local verification complete (T-21, clean snapshots); **independent review pending the CTO's acceptance** |
| `fulfillReservationsForOrder` atomicity and overlapping-order deadlock | fixed (`a798d9d`, `5c5b791`); same status as above; residual: a transaction that wrote an audit record before entering the fulfilment can still form a lock cycle (global audit lock held to the end of the transaction) — not probed |
| H1 limit engine (`consume`/`release`) | fixed (`5c5b791`); verified T-24/T-20; review of the diff by the reviewer (no defect reported); **not closed** |
| H2 `releaseReservedQuantity` | fixed (`5c5b791`); same |
| H4 `ProcessEngine.start` | fixed (`5c5b791`, atomic insert on `IDX_process_instances_unique`, present in every database via migration `1755841300000`); same |
| H5 `ShipmentService.transitionShipment` | **BLOCKED / NOT RUN** — needs a full shipment fixture; no probe |
| Same idiom, **not probed and not changed**: `relocateReservedStock`, `releaseReservedQuantityForReference`, `limit.service.check`, `fulfill*` siblings | NOT RUN — exposure INFERRED from the code, needs its own probe/decision |
| N-02 as a whole | **OPEN** |

## 6. F-AUD-003
Remediated in `c764fc5` as authorised: the hash input is the sequence value actually stored (drawn with `nextval` under the existing audit advisory lock, inserted explicitly); no hash-format change (golden vector), no rewrite of history. **Existing broken chains:** none were repaired, rehashed, deleted or normalised; P2 proves a broken chain is preserved and still reported. Whether production chains are already broken is **unknown** (no real-data access); a read-only check is `verifyCompanyChain` on each Company database under the same operator authorisation as D-9. If any chain is found broken, a separate recovery-policy proposal (not part of this work) is needed — options to consider then: keep and annotate, add a signed checkpoint record, or re-anchor from a verified restore point. Status: implemented and locally verified; **not closed** (independent review + CTO acceptance).

## 7. Blocked, skipped, not executed
H5 shipment transition (BLOCKED); sibling reservation/limit methods (NOT RUN); the 6 specs on the 5544-pinned helper and the 3 role-creating specs (BLOCKED, unchanged guard); `company-audit-access.real-pg.spec.ts` (held); multi-instance, concurrency above 8–40 way, hosting (NOT RUN, not authorised); T-18 (parallel track) keeps its 3 FAIL-DEFECT; HEAD lint is red because of the LA-1 track's commit (not touched).

## 8. New risks and decisions required
1. Accept or replace the independent review (§4).
2. Decide the optional audit sequence-lag guard (§4).
3. Authorise probes for the unprobed sibling methods and H5 fixture.
4. Decide the recovery policy only if broken audit chains are found in real data (needs the operator access that is still missing).
5. An aborted pipeline run (my own, for `5c5b791`) and two cluster collisions between the sessions are documented; runs on the shared cluster must stay serialised.
