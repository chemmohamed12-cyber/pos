# DAII — WP-AUD-08: impact of `e344ca1` and minimal change specification to restore Option B (fail closed) — 2026-10-12

Prepared by Team 3 (documentation and coordination). **This document changes no product code and runs no test.** It answers the CTO ruling of 2026-10-12 (item 1): Option A is not approved; `e344ca1` was made without recorded CTO authorization; no immediate revert and no deletion of the commit; preserve the diff and the current tests; assess the impact on the audit writer and PA-33; prepare a minimal change that restores Option B (fail closed on sequence lag); no automatic realignment; the hash format and every historical audit record untouched; verification on a clean snapshot including the T-26 failure modes and the audit-chain regressions; provenance and results recorded; PA-33 not claimed closed.

**Who applies it.** The change is a product change to `audit.service.ts`, the file the verification track edited in `e344ca1`. To avoid two sessions editing the same file and to keep the shared cluster serial, Team 3 (documentation and coordination only) hands the specification below to the verification track, which authored `e344ca1` and owns the clean-snapshot pipeline. The change must still be reviewed independently once a reviewer exists (WP-REV-01 is deferred).

Reference: HEAD `0bcf92b`; commit under assessment `e344ca1b354f578b12dfd5cad56fd45e35a73c43`; baseline writer `c764fc5`; evidence `T-26` (`9b52e46-t26/`). Classes: VERIFIED (read in code), MEASURED (result files), INFERRED.

## 1. What `e344ca1` changed (VERIFIED by reading the diff)
| Item | Change |
|---|---|
| `audit.service.ts` (+26/−3) | `Logger` import and a `logger` field; new exported `AuditSequenceLagError`; the head read now selects `seq, hash` and keeps `tailSeq`; after `nextval`, if `seq <= tailSeq` it runs `setval(seq, tailSeq, true)`, draws `nextval` again, throws `AuditSequenceLagError` if still not above the tail, otherwise logs a warning (`audit sequence was behind the stored tail and was realigned`) and continues |
| `t27-audit-seq-lag-guard.biz.real-pg.spec.ts` (new, 111 lines) | tests AT2–AT6 written for Option A: healthy path with no realignment; broken chain preserved while a lagging append succeeds; 40 concurrent appends under lag all succeed; rollback after a realignment; two fail-closed cases (`setval` throws, `setval` is a no-op) |
| `tools/testing/biz-run.js` (+1) | T-27 registered after T-26 |
Hash format, `computeAuditHash` inputs, the raw `INSERT` and the verifier are unchanged.

## 2. Impact on the audit writer and on PA-33
| # | Effect | Class |
|---|---|---|
| I1 | **Healthy path:** no extra statement; the head read returns one more column. No behavioural change when the sequence is ahead of the tail | VERIFIED (code) |
| I2 | **Lag path:** the writer *mutates sequence state* with `setval` — non-transactional, so it survives a rollback of the caller's transaction (stated by the commit's own comment) | VERIFIED (code) |
| I3 | **Silent self-repair:** a lag caused by an unexplained import, restore or manual reset is hidden behind a warning log; there is no audit record of the realignment and no error to the caller. This is the behaviour the CTO has now declined | VERIFIED (code) |
| I4 | **Privilege:** the application role needs `UPDATE` on the audit sequence; if it lacks it the path fails closed at that moment, not before | VERIFIED (code); per-host privilege UNVERIFIED |
| I5 | **Historical records:** none read for repair, none rewritten (AT3 asserts the existing rows are byte-identical on a broken chain) — unchanged by the correction | VERIFIED (spec); not yet run on a clean snapshot |
| I6 | **PA-33:** the F-AUD-003 fix (`c764fc5`: hash tied to the stored `seq`) is untouched in substance; `e344ca1` adds behaviour on top of it. PA-33 stays OPEN: no clean-snapshot evidence of `e344ca1`, no independent review, DEC-02 open | — |
| I7 | **Evidence status:** `e344ca1` has no published clean-snapshot run. T-27 as committed encodes Option A and would FAIL against Option B | INFERRED (from the spec's assertions) |
| I8 | **T-26 (baseline observation)** was measured on `9b52e46` (before any guard). It remains valid evidence of the baseline. Its PASS criterion (`append.ok && chainValid`) is the Option A expectation; against Option B the L1 and L2 appends are *refused*, so T-26 as written reports FAIL-DEFECT for both while the behaviour is correct. T-26 must therefore not be reused unchanged as an acceptance test for B; it stays unchanged as the historical baseline | INFERRED (from the spec) |

## 3. Minimal change restoring Option B
Principle: **detect before drawing, refuse, change nothing.** The writer must not call `setval` anywhere. Keep the part of `e344ca1` that is neutral (the `seq` column in the head read, the error class) and replace only the realignment block.

Proposed replacement of the block added after the `nextval` line (specification, not applied):
```ts
// WP-AUD-08 (DEC-01b, Option B — fail closed): the new row must sit strictly after the stored tail whose hash is `prevHash`. Refuse BEFORE drawing a value, so a refusal does not
// consume sequence values and cannot recover by erosion. The sequence is never realigned here; an operator does it under change control after investigating the cause.
const st = (await m.query(`SELECT last_value::bigint AS last, is_called AS called FROM ${seqName}`))[0];
const nextSeq = Number(st.last) + (st.called ? 1 : 0); // audit_records.seq is a plain SERIAL: increment 1, cache 1 (asserted by a startup check)
if (tailSeq !== null && nextSeq <= tailSeq) {
  throw new AuditSequenceLagError(`audit sequence is behind the stored tail (tail ${tailSeq}, next ${nextSeq}); no audit record written; realign the sequence under change control`);
}
const seq = Number((await m.query('SELECT nextval($1::regclass) AS seq', [seqName]))[0].seq);
if (tailSeq !== null && !(seq > tailSeq)) throw new AuditSequenceLagError(`audit sequence returned ${seq} at or below the tail ${tailSeq}; no audit record written`); // defensive: unexpected cache/increment
```
and removal of the `Logger` import/field and the `setval` call (so lint stays clean). Consequences: no `UPDATE` privilege on the sequence is needed (I4 disappears); no sequence mutation by the writer (I2, I3 disappear); a refused write leaves the sequence unchanged; the hash input list, the `INSERT` and the returned entity are untouched. The caller sees an identifiable error instead of a raw `23505` (L1) or a silent out-of-order row (L2).

Test changes (the committed T-27 and T-26 files stay in history and are not edited):
1. Keep `t26-audit-seq-lag-baseline` unchanged as the historical baseline (I8). Do not run it as an acceptance test for B.
2. Add `t28-audit-seq-lag-fail-closed.biz.real-pg.spec.ts` (new) with the B expectations, using the same L0/L1/L2 shapes as T-26 so the two failure modes are re-measured:
   - **B-0** healthy path unchanged: appends succeed, chain valid, no extra rows, no refusal.
   - **B-1 (L1 shape)** refused with `AuditSequenceLagError`, **no `23505`**, no row added, chain unchanged, sequence `last_value` unchanged.
   - **B-2 (L2 shape)** refused before any row is written; chain valid; the imported row untouched; no out-of-order row.
   - **B-3** 10 repeated attempts under lag: all refused, `last_value` not moving (no recovery by erosion).
   - **B-4** 20 concurrent writers under lag: all refused; no duplicate-key error; no row added.
   - **B-5** operator realignment (`setval` to the stored maximum, performed by the test as the operator would) then 20 concurrent writers: all succeed, unique strictly increasing `seq`, chain valid.
   - **B-6** lag inside an outer transaction that rolls back: nothing written; sequence unchanged.
   - **B-7** an already-broken chain: refusal behaviour defined; rows byte-identical before and after (as AT3's assertion, applied to refusals).
   - **B-8** no `setval` statement is ever issued by the writer (statement spy), healthy or lagging.
   - **B-9** startup assertion proposal (optional, separately authorized): audit sequence is increment 1, cache 1.
3. Change the registration in `tools/testing/biz-run.js`: replace T-27 by T-28 (T-27's file remains in the repository as the record of the withdrawn Option A, marked superseded in its header comment).
Regression set on the clean snapshot of the correcting commit: T-22 and T-23 (rollback, concurrency, golden hash vector, healthy and broken chains preserved), T-26 (baseline, expected to report its documented FAIL-DEFECT states only if it is run; record that it is not an acceptance test for B), T-28, the unit suites that exercise `AuditService`, the guard suite (50/50 expected), and the isolation specs that write audit records (the six WP-INV-10 regression specs plus the audit-related specs in the 91-file isolation set).

## 4. Evidence required before anything is recorded as VERIFIED
Clean `git archive` snapshot of the correcting commit; `DAII_SOURCE_COMMIT` set; run headers with `dirtyPaths: []` and `sourceKind: clean-git-archive-snapshot`; manifest sha256; result counts taken from result files; the exact commands used; cluster quiet during the run. Results recorded per test id. Until then the correcting commit is IMPLEMENTED only. PA-33 is not claimed closed by any of this.

## 5. Sequencing and scope limits
1. Apply the change as a **new commit** on top of `e344ca1` (no revert, no history rewrite); commit message states that it restores Option B per the CTO ruling.
2. Do not touch the hash format, `audit-hash.ts`, any migration, any historical row, or any other service.
3. Realignment of a lagging sequence remains an operator action: owner and runbook still to be named by the CTO (DEC-01b part b). Runbook outline: confirm the lag read-only (`last_value`, `is_called`, `max(seq)`); investigate the cause; `setval` to `max(seq)` under change control; confirm with a chain verification; record the action.
4. The independent review of this change waits for the reviewer (deferred); until then it is IMPLEMENTED/VERIFIED by the author's track at best.
