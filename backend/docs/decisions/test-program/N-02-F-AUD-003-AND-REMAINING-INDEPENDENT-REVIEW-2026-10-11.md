# F-AUD-003 and the remaining N-02 patches — independent review (reviewer session), 2026-10-11

**Subjects:** `c764fc5` (F-AUD-003: `audit.service.ts`, specs T-22/T-23) and `5c5b791` (remaining N-02: `limit.service.ts`, `process-engine.service.ts`, `inventory.service.ts` `releaseReservedQuantity` + `fulfillReservationsForOrder`, specs T-21 case I and T-24). HEAD reviewed: `5c5b791`.
**Status of this review: PARTIAL — code review and evidence reading complete; database clean-snapshot verification is NOT complete** (the verification session's clean-snapshot pipeline of `5c5b791` — business T-00…T-24 + 91 isolation specs + unit + guard, ≈2.5 h — is still running on the cluster; this session ran no database tests, to avoid a third collision). Like the previous review, this is evidence for the CTO's decision, not an acceptance.

## 1. Authorship and independence
| Item | Author |
|---|---|
| Patches `c764fc5`, `5c5b791`, specs T-22/T-23/T-24, baselines | the **verification session** ("Authorization") |
| The deadlock concern that led to the sorted-key change in `fulfillReservationsForOrder` | raised by this (reviewer) session in its previous review; the same session now reviews the fix for it — a self-confirmation risk, flagged |
| `runInTransaction`, relied on by every patch here | this session |
| Commits | made by the verification session; all sessions share the git identity "DAII Workspace" |
This session wrote none of the code under review.

## 2. F-AUD-003 (`c764fc5`) — what was inspected
**Change:** the audit hash is computed with a sequence value drawn by `nextval(pg_get_serial_sequence('audit_records','seq'))` **under the audit advisory lock**, then the row is inserted with that explicit `seq` (raw `INSERT`), replacing the `MAX(seq)+1` prediction plus `repo.save()` (which ignores the supplied `seq`).
- **Mechanism confirmed independently** (reviewer's own code read before this patch): `audit_records.seq` is `SERIAL` (`CreateAuditRecords`), the entity is `@PrimaryGeneratedColumn()`, the old hash used `MAX(seq)+1`; a rolled-back insert burns a sequence value, so every later row was stored with a different `seq` than the one hashed.
- **Correctness of the new flow:** the lock is held to the end of the writer's transaction (`runInTransaction`), `prevHash` is read by `ORDER BY seq DESC LIMIT 1` under that lock, `nextval` is drawn after it, so seq order = lock order; hash format and `computeAuditHash` inputs are unchanged (golden vector T-23 `H` = `677576fc…` PASS); `verifyChainOn` recomputes with the stored `seq` and follows `prevHash`, so gaps are harmless (verification does not require contiguity).
- **No other writer:** `grep` of non-test sources finds no other code inserting into `audit_records` (readers only: audit controllers, sales-orders, work-order). The returned object is built with `repo.create(...)` instead of the saved entity — no generated fields other than `seq` exist on the entity.
- **Evidence read (working tree, `dirtyPaths` 4–8, i.e. NOT clean-snapshot):** T-23 R1 rollback-then-append PASS (stored seqs `[1,5,6]`, chain valid), R2 PASS, C1 40 concurrent appends PASS (0 forks), C2 mixed commit/rollback PASS, H golden vector PASS, P1 healthy chain continues PASS, **P2 an already-broken chain is preserved, not repaired, and new rows link to its tail** PASS.
**Residual risks (INFERRED):**
1. **Historical damage is not repaired.** Any Company database that already suffered a rollback with an audit write keeps a chain that verifies as broken (P2 proves this on purpose). A repair/acceptance procedure for existing data (and for any production host) is a separate decision.
2. **Sequence behind the data.** If `audit_records` ever receives rows with explicit `seq` values above the sequence's last value (a data import or a restore that does not set the sequence), `nextval` could return a value ≤ an existing `seq`: `ORDER BY seq DESC` would then pick the wrong `prevHash` or the insert would conflict. No such writer exists in the code, and `pg_dump` restores carry `setval`; a defensive guard (`GREATEST(nextval, max(seq)+1)` or a startup check) is not present and not tested.
3. Two extra statements per audit write (`pg_get_serial_sequence`, `nextval`) — small cost; the sequence name could be cached.
4. The raw `INSERT` must be kept in step with the entity if a column is ever added (maintainability).

## 3. Remaining N-02 patches (`5c5b791`)
| Patch | Review result |
|---|---|
| `LimitService.consume` / `release` through `runInTransaction` | Correct and minimal (same rule as N-01). `check()` stays read-only on the old idiom — acceptable. Evidence (working tree): T-24 H1 plain and transaction PASS (cap 10: 10 allowed, counter 10), outer rollback restores quota, release floors at 0 |
| `releaseReservedQuantity` through `runInTransaction` | Correct. T-24 H2 plain/transaction PASS (5 of 12 succeed, 7 × 409, nothing left active), outer rollback restores the reservation |
| `ProcessEngine.start` = `INSERT … ON CONFLICT ("definitionKey","entityType","entityId") DO NOTHING` then read back | Correct **provided the unique index exists**: it is created by the very early core migration `1755841300000-CreateProcessEngineTables` (`IDX_process_instances_unique`) and declared on the entity, so every database has it. T-24 H4 plain/transaction: 10 concurrent starts → 1 instance, 0 rejected; rollback-then-retry idempotent |
| `fulfillReservationsForOrder`: lock **all** `"<warehouse>:<product>"` keys of the order up front in sorted order, then re-read and fulfil | Closes the case reproduced by T-21 I (opposite line order, same warehouse: 12 deadlocks in 24 calls before, 0 after, PASS). Sound for that shape: all callers acquire the shared keys in one global order, so no cycle among reservation keys |
**Residual risks (INFERRED, not tested):**
1. **Deadlock remains possible when the dispatch (override) warehouse differs from the reservation warehouses.** The sorted keys protect the *reservation* keys; each line then takes `valuation:<overrideWarehouse>:<product>` and the global audit lock, in the order the reservations were fetched (not sorted). Two orders whose reservations sit in different warehouses but are dispatched from the same custody warehouse, with overlapping products in opposite order, can still form the cycle valuation(P1)→audit→valuation(P2). Case I uses one warehouse, so it does not exercise this. Postgres would abort one transaction (40P01); no corruption. A probe with two reservation warehouses and one override warehouse would settle it.
2. **Behaviour change:** the order-level call now ends as a successful no-op when it finds no active reservations (a second caller that arrives after the first commit), where the previous patch ended with 409. A direct `fulfillReservation` of a fulfilled reservation still returns 409. The in-repo caller (`delivery.service.recordOutcome`) is protected earlier by the shipment state machine. Documentation of the contract should say "idempotent at order level".
3. Case E (order-level duplicates) accepts either outcome (`outs.filter(ok).length >= 1`), so it no longer proves *which* — consistent with the change above.
4. H5 (shipment transitions) remains BLOCKED/NOT RUN.

## 4. This session's own checks (DB-free)
Clean `git archive` of HEAD `5c5b791` → `tools/ci/ci.sh` (offline cache): install PASS · build PASS · structure PASS · doc links PASS · unit 59/430 PASS · guard PASS · **lint FAIL with the same 3 errors as at `a33f769`**, all in the LA-1 track's files (`installation-audit.controller.ts` unused imports; `company-lifecycle-admission.real-pg.spec.ts` boundary import) — **no new lint error comes from `c764fc5` or `5c5b791`**. Evidence: `test-03/evidence/ci-run-n02-final-head-snapshot.log`, `evidence-clean-snapshot-2026-10-11/5c5b791-review/`.

## 5. What is still required before these items can be called closed
| Item | Needed |
|---|---|
| F-AUD-003 fix | the verification session's clean-snapshot pipeline of `5c5b791` (T-22/T-23 on a clean tree, then the 91 isolation specs, which exercise `audit.record` everywhere); a decision on repairing/accepting historical broken chains; optional guard for residual risk 2 |
| Remaining N-02 (H1, H2, H4) | the same pipeline (T-24 on a clean snapshot) |
| `fulfillReservationsForOrder` deadlock claim | probe for risk 1 above, or explicit acceptance; until then "no deadlock" is proven only for same-warehouse overlapping orders |
| H5 | fixture or explicit deferral |
| Re-run of T-03/T-04 alone (previous review's open item) | included in the pipeline above if it passes on a quiet cluster |
| HEAD lint | LA-1 owner |
No sign-off is given here: this review will be completed (or revised) when the pipeline's evidence is available and re-read.

## 6. Addendum (reviewer, after the verification session's answer on commit `71e5f5e`)
- **Residual risk 1 of §3 (override-warehouse deadlock) is downgraded from "possible" to "not substantiated".** The verification session added T-21 case J (two reservation warehouses, one custody warehouse, opposite line order, 6 rounds × 4 callers): PASS, 0 deadlocks, 24/24 movements. Its reasoning was checked against the code (DB-free): in `InventoryService.recordMovement` the order is *save movement → `audit.record` (global audit lock) → [receipts only: `valuation.recordReceiptCost`] → publish the outbox event*; for dispatch movements the valuation cost is resolved when the outbox event is processed after commit (a separate transaction), not inside the fulfilment transaction. Within one fulfilment transaction a dispatch therefore never takes a valuation lock, and every transaction takes the audit lock at its first line and keeps it to the end; a transaction that waits for the audit lock holds only the (sorted) reservation keys. That removes the cycle I described, which wrongly assumed valuation locks were taken inside the transaction. Remaining unproven edge: a path that takes a valuation lock before its first audit write in the same transaction (none found for fulfilment; not probed).
- Items still open from §5: the clean-snapshot pipeline of `71e5f5e` (running), the seq-lag guard for F-AUD-003 (documented proposal, not implemented — CTO decision), the historical broken chains, H5, and the LA-1-track lint errors at HEAD.
- Behaviour change of §3 item 2 is now asserted by T-21 case E2 (order-level repeat = idempotent no-op; direct re-fulfilment stays 409, case B).
- **Scope of the withdrawal (per the CTO's update):** the deadlock concern is withdrawn **for the examined `fulfillReservation` / `fulfillReservationsForOrder` path only**; it is not a claim that the system is deadlock-free. The one path that might acquire a valuation lock before its first audit write in the same transaction is recorded as an **explicit evidence gap** — not a confirmed defect and not a universal deadlock claim.
- **Statuses kept separate:** implementation = done by the verification session (patches `a798d9d`, `c764fc5`, `5c5b791`, `71e5f5e`); independent review = **in progress** (code reviewed; clean-snapshot evidence of `71e5f5e` not yet read); overall N-02 = **OPEN** (shipment probe H5 BLOCKED; F-AUD-003 seq-lag guard undecided). The audit-chain boundary (PA-33: no rewriting, rehashing, deleting or normalising of existing broken chains) is outside N-02 and untouched here.

## 7. Final addendum (reviewer) — evidence of the `71e5f5e` pipeline read and independently re-run
**Tested commits.** The verification session's pipeline ran on a clean `git archive` of `71e5f5ecbff0fd4a51b0f862d722950e22006a91` (`evidence-clean-snapshot-2026-10-11/71e5f5e-final/`, `SOURCE_COMMIT.txt`). This reviewer re-read it with `tools/assessment/review-snapshot-evidence.js`: all 23 run headers carry that commit with `dirtyPaths: []`. This reviewer then ran CI and T-03/T-20…T-24 on a clean `git archive` of `f881e53aecf9461edd1d9e583224b315fd6450f2` (`71e5f5e-reviewer-rerun/`). `git diff --name-only 71e5f5e HEAD -- backend/src backend/tools` is empty, so product and tool code are identical to `71e5f5e`; only documents and evidence differ. The six re-run directories are HEADER-OK (commit `f881e53`, `dirtyPaths: []`). Historical runs from earlier commits were deliberately removed from the copy.

**Results (clean snapshots).**
| Item | Result |
|---|---|
| T-03 (alone, quiet cluster) | 20 PASS (resolves the earlier collision artifact) |
| T-20 | 8 PASS, 1 BLOCKED (H5 shipment transition) |
| T-21 (A–J, E2) | 13 PASS, including I and J (overlapping orders, no deadlock) |
| T-22 | 2 PASS; `F-AUD-003-X-explicit-seq-honoured-by-save` FAIL-DEFECT = intentional characterisation (`repo.save` ignores an explicit seq; the production path no longer uses it). Not a regression |
| T-23 | 7 PASS (rollback-then-append, concurrency, golden vector, broken chain preserved) |
| T-24 | 10 PASS, 1 BLOCKED (H5) |
| 91 isolation specs (peer's run, reconciled with the list) | 89 executed-pass, 1 skipped (`t0-clean-company-baseline`, opt-in; the runner printed PASS), 1 failed (`release-migration-registry`, the known 5544-pinned BLOCKED spec). Not "91 passed" |
| Unit / guard | 59 suites, 430 tests PASS / guard 50/50 PASS |
| Build / typecheck | PASS |
| Lint | FAIL: 3 errors, all in LA-1-track files (`installation-audit.controller.ts`, `company-lifecycle-admission.real-pg.spec.ts`), plus 5 redundant-disable warnings; none from N-02 work |

T-18 (3 FAIL-DEFECT) and T-06x-INFO are not N-02 items.

**Independence and limits.** I wrote `runInTransaction` (a dependency of every patch) and raised the deadlock concern that the sorted-key change answers; the peer authored all patches and specs; the committer of `a798d9d` cannot be established (shared git identity). Both sessions are Claude; this is evidence for the CTO's decision, not an acceptance. Not covered: more than 8-way concurrency, multi-instance, hosting, shipment end-to-end (H5).

**Per-finding N-02 status (implementation / independent review).**
| Finding | Status |
|---|---|
| H3 `fulfillReservation` + `fulfillReservationsForOrder` | Fixed; clean-snapshot VERIFIED (T-21 A–J, E2); review: code and evidence read, no defect found |
| H1 limit consume/release | Fixed; T-24 clean-snapshot PASS |
| H2 `releaseReservedQuantity` | Fixed; T-24 clean-snapshot PASS |
| H4 process start | Fixed (`ON CONFLICT DO NOTHING`, unique index confirmed); T-24 PASS |
| H5 shipment transitions | **BLOCKED / not run**, visible and unresolved |
| F-AUD-003 | Fixed for new writes (T-22/T-23); seq-lag guard undecided (proposal only); historical broken chains untouched — PA-33, separate, nothing rewritten, rehashed, deleted or normalised |
| Valuation-lock-before-audit path | **Evidence gap** (no such path found in fulfilment, not probed); not a defect, not a deadlock-freedom claim |

**Overall N-02: OPEN. Release: NOT APPROVED.** CI is not green (LA-1 lint at HEAD). No new defects, guard failures or scope deviations found by this reviewer; the earlier T-03 collision was this session's and is closed by the alone-run.
