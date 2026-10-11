# WP-AUD-08 — audit sequence-lag guard: DESIGN ONLY (no implementation, no product change) — 2026-10-11

Inputs: T-26 clean-snapshot evidence (`evidence-clean-snapshot-2026-10-11/9b52e46-t26/`), `audit.service.ts` (`record`, `verifyChainOn`), `audit-hash.ts`. Not changed by this document: hash format, existing rows, PA-33 (history policy).

## 1. Problem (both measured)
| Case | Condition | Current behaviour | Class |
|---|---|---|---|
| L1 | `nextval <= max(stored seq)` (sequence reset/behind) | `23505 audit_records_pkey` on every audit write | availability |
| L2 | a row with `seq` far above the sequence (import/restore) | write succeeds with a low seq but `prevHash` of the high row → chain broken at the new row, undetected at write time | integrity (silent) |
Common root: `record()` takes `prevHash` from the row with the highest `seq`, but the new row's `seq` comes from the sequence without comparing the two.

## 2. Behaviour contract
1. Invariant: under the audit advisory lock, a new record's `seq` is strictly greater than the stored maximum `seq`, and its `prevHash` is the hash of that maximum row. Therefore seq order = chain order always.
2. Healthy path unchanged: no extra statement when `nextval > tail.seq` (the tail row is already read; select `seq` with `hash`).
3. Lag path: when `nextval <= tail.seq`, **realign the sequence, never the data**: `setval(seq, tail.seq, true)` (monotone: never lowers a healthy sequence), draw `nextval` again (= tail.seq+1) and continue. Existing rows are never read for repair, rewritten, rehashed, deleted or normalised.
4. Fail-closed: if the realignment fails or the second `nextval` is still ≤ tail.seq, throw a typed error (`AuditSequenceLagError`) and let the surrounding transaction abort; never write a row that breaks the chain.
5. Observability: a realignment logs one warning with `{fromSeq, toSeq}` (no payload data). No schema change; no new table.
6. Out of scope: repairing chains already broken (PA-33), changing `verifyChainOn`, startup checks, other tables.

## 3. Alternatives
- **A (recommended): realign-on-detect** as above. Fixes L1 and L2 without operator action; `setval` is non-transactional but monotone and taken under the global audit lock, so it cannot race.
- B: fail-closed only (throw on lag, operator realigns). Safer against surprise but turns L1 into an outage until fixed and leaves L2 detected-but-blocking.
- C: startup alignment check only. Does not cover drift after startup.
Decision needed: A or B (Team 3 view: A, with the warning log as the signal).

## 4. Check point and failure handling
Inside `AuditService.record` after the existing `ORDER BY seq DESC LIMIT 1` read (same lock, same transaction). Failure of the guard aborts the caller's transaction exactly like any audit-write failure today (audit is already part of the business transaction).

## 5. Acceptance tests (to be written with the implementation; T-26 stays the baseline)
1. T-26 L1 and L2 flip to PASS (append succeeds, chain valid, new seq = tail.seq+1).
2. L0/healthy: no `setval` issued (statement count unchanged) and T-23 R1, R2, C1, C2, H (golden vector), P1 PASS.
3. P2: an already-broken chain is byte-for-byte unchanged by a guarded append (row fingerprint before/after, excluding the new row).
4. Concurrency under lag: 40 concurrent appends with the sequence behind → 40 rows, 0 forks, chain valid.
5. Rollback after a realignment: the sequence stays advanced, next append valid, no duplicate seq.
6. Fail-closed: simulate `setval` failure (revoked privilege in a disposable DB) → typed error, no row written, transaction aborted.
7. Re-run the 91 isolation specs (audit is on every write path) and unit/guard on a clean snapshot; independent review of the diff.

## 6. Risks
`setval` needs UPDATE on the sequence for the application role (owner today — to be confirmed per host); a sequence deliberately lowered by an operator is overridden upward (intended). The guard prevents *new* breaks only.

Status: design submitted for review; implementation NOT started and NOT authorized. PA-33 stays OPEN.
