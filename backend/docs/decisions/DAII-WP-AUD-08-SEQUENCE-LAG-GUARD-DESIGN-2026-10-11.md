# DAII — WP-AUD-08: sequence-lag guard — DESIGN (not implementation) — 2026-10-11

Prepared by Team 3 (documentation and coordination) under the CTO closeout directive of 2026-10-11, item 5: **GO for design only.** Nothing here changes product code, the hash format, schema, configuration or any historical audit record, and nothing here is implemented. Implementation requires (1) review of this design, (2) a separate CTO approval of the chosen option, (3) a separate implementation authorization, and then (4) clean-snapshot evidence and an independent review. This document supersedes nothing: it completes the options in `DAII-F-AUD-003-SEQUENCE-LAG-GUARD-PROPOSAL-2026-10-11.md`, and it keeps PA-43 (UUID repair) and DEC-02 (already-broken chains) separate.

Reference: documentation `c22f193`; audit writer read at HEAD `c22f193` (`backend/src/foundation/audit/audit.service.ts`, fix `c764fc5`). Evidence: `T-26`, commit `9b52e46`, clean snapshot `evidence-clean-snapshot-2026-10-11/9b52e46-t26/` (header `dirtyPaths: []`). Classes: **MEASURED** (T-26 result files), **VERIFIED** (read in code), **INFERRED**.

## 1. The two measured states that define the contract
| State | How it was produced (T-26, disposable database) | Measured outcome on current code |
|---|---|---|
| **L1 — sequence behind max(seq)** | 3 healthy rows (seq 1–3); sequence set to 1, so the next value is 2, which exists | The audit write **fails** with `23505 duplicate key … Key (seq)=(2)`; no row written; chain still valid; the sequence's `last_value` is now 2 (the failed draw was consumed) — **MEASURED** |
| **L2 — explicit seq above the sequence** | a valid-hash row with `seq = 103` inserted (as an import would carry), sequence left at 3, then one ordinary append | The append **succeeds** and receives `seq = 4` with `prevHash` = hash of the row with seq 103 (the head by `seq DESC`); **chain reported broken at seq 4**; the chain was valid before the append — **MEASURED** |
Healthy baseline L0 passes (chain valid). Reading of the two outcomes: L1 is a **loud availability failure**; L2 is a **silent integrity failure** that appears only at verification. Both come from the same condition: **the value the sequence will hand out is not greater than the highest stored `seq`.**

Two further facts from the code (VERIFIED/INFERRED, not yet measured):
- `nextval` is not transactional, so each refused or failed write in L1 consumes one value. Repeated failures therefore move the sequence forward until it passes the stored maximum and writes resume **by accident** (here after 1–2 failed operations), leaving a gap. The "loud" failure of L1 is thus transient and its length depends on the size of the lag. (INFERRED; to be measured by acceptance test G-3 below.)
- In L2 every later append keeps chaining to the head row (seq 103) with a lower `seq` until the sequence reaches 103, where L1's duplicate-key failure begins. The chain stays broken from seq 4 on. (INFERRED from the writer's head read.)

## 2. Behavioural contract (what the writer must guarantee in lag conditions)
| # | Rule |
|---|---|
| C1 | An audit record is never written with a `seq` that is less than or equal to the highest stored `seq`. |
| C2 | The hash is computed over exactly the `seq` that is stored (unchanged `c764fc5` property). |
| C3 | In lag conditions the writer **does not** surface a raw `23505`; it fails with a dedicated, identifiable error (see §4) so operators and callers can tell a sequence anomaly from a data conflict. |
| C4 | The lag condition is **not** hidden: it is reported (error with `headSeq` and next sequence value; log entry; included in verifier output under option C). |
| C5 | No existing audit row is read-modified, rewritten, re-hashed, renumbered or deleted by the guard, and the hash format and `computeAuditHash` inputs are unchanged. |
| C6 | A refused write leaves the sequence unchanged where the design can avoid it (no burn of values by refused writes), so the state after a refusal equals the state before it. |
| C7 | Healthy-path behaviour is unchanged: same results, same hash for the same inputs, no extra failures; the added cost is stated and measured. |
| C8 | The guard is independent of how the lag arose (restore, import, manual reset, a future recovery under DEC-02). |

## 3. Failure mechanism — the single detectable condition
Under the audit advisory lock (already held by the writer) the lag condition is: **`nextSeq ≤ headSeq`**, where `headSeq` = the `seq` of the head row (the existing head read `ORDER BY seq DESC LIMIT 1`, extended to select `seq` as well as `hash`) and `nextSeq` is the value the sequence would return next. One condition covers both measured states (L1: next 2 ≤ head 3; L2: next 4 ≤ head 103).

How `nextSeq` is known without consuming it (design choice D1):
- **D1-a (recommended): read the sequence state first** — `SELECT last_value, is_called FROM <sequence>` under the lock (`nextSeq = is_called ? last_value + increment : last_value`; the sequence is a plain SERIAL with increment 1 and cache 1 — to be asserted by a startup check, since a larger cache or a non-unit increment would change the arithmetic). Refuse before drawing, so C6 holds.
- D1-b: draw `nextval`, compare, refuse if `≤ headSeq`. Simpler, but a refused write burns a value (violates C6) and the sequence drifts towards accidental recovery.

Because every writer holds the same transaction-scoped advisory lock, the comparison and the draw cannot be interleaved by another audit writer (VERIFIED: one writer path). A writer outside the lock (a manual import) is exactly what the guard exists to catch.

## 4. Options as designs (the choice is the CTO's — DEC-01b)
| Option | Design | Failure behaviour in L1 / L2 | Main trade-off |
|---|---|---|---|
| **B′ fail-closed with pre-check (Team 3's recommendation for review)** | Writer applies §3 D1-a; on lag throws `AuditSequenceLagError` (code `AUDIT_SEQUENCE_LAG`, fields `headSeq`, `nextSeq`, no row data); transaction rolls back; sequence untouched. Realignment is an explicit operator action (documented runbook: read-only check first, then `setval` to the stored maximum under change control), not done by the writer | L1: every audited operation refused with the identifiable error until realigned (availability loss, **loud and stable**, not transient); L2: refused **before** the out-of-order row exists (integrity preserved) | Integrity first; a Company is blocked until an operator acts. Appropriate when audit integrity outranks availability |
| **A self-healing** | As B′ but on lag the writer calls `setval(seq, headSeq)` under the lock, draws, records a realignment event, proceeds | L1/L2: writes continue with strictly increasing `seq`; chain valid | Operations continue, but the writer mutates sequence state automatically (non-transactional), which can mask an unexplained import or restore error unless the realignment is itself audited; extra branch in the hottest audit path |
| **C check outside the write path** | No change to the writer. Add a lag check to (i) `verifyChain` output, (ii) the restore manager after a restore, (iii) a startup/health check | Writes are not intercepted: L1 stays a transient raw failure; L2 still produces the out-of-order row until the next check | Zero hot-path cost; does not protect between the event and the check. Valuable as a complement to B′ or A, insufficient alone for C1 |
| **D accept** | No change; record the rule that any writer of explicit `seq` must realign the sequence (DEC-02 recovery included) | Unchanged (measured above) | Zero change; the L2 failure is real and silent |
Recommendation for the review (non-binding): **B′ + C** — B′ gives C1–C6 deterministically; C adds visibility after restores and at startup. A is a legitimate alternative only if the CTO values availability over a manual step and accepts an audited automatic `setval`.

## 5. Acceptance tests (to be written and run only after the option is approved and implemented)
Harness: disposable Company databases under the guarded real-PG harness, writer called in both styles (plain manager and transaction), clean-snapshot evidence with pinned header.
| # | Scenario | Expected for B′ (and the generic assertion for A/C) |
|---|---|---|
| G-0 | Healthy baseline (T-26 L0 shape) and the existing T-22/T-23 set | Unchanged results; golden hash vector unchanged; rollback-burn case still gives a valid chain |
| G-1 | T-26 L1 shape (sequence set back below max) | Append refused with `AUDIT_SEQUENCE_LAG`, **no `23505`**; no row added; chain valid; sequence `last_value` unchanged (C6). For A: append succeeds with `seq > headSeq`, chain valid, realignment recorded |
| G-2 | T-26 L2 shape (explicit seq far above the sequence) | Append refused before any row is written; chain valid and **no out-of-order row**; the imported row untouched. For A: append gets `seq > 103`, chain valid |
| G-3 | Repeated writes under lag (10 attempts) | Same refusal each time, sequence not drifting (B′); no accidental recovery after a few failures |
| G-4 | 20 concurrent writers under lag | All refused (B′) or all succeed with unique increasing `seq` (A); never a duplicate-key error, never an out-of-order row |
| G-5 | Realign by the runbook, then 20 concurrent writers | All succeed, strictly increasing unique `seq`, chain valid |
| G-6 | Lag inside an outer transaction that later rolls back | Nothing written; sequence state as defined by the option; the outer transaction behaves as specified |
| G-7 | Existing already-broken chain (DEC-02) | Guard neither changes nor repairs it; behaviour for new writes is defined and recorded |
| G-8 | Hash/record immutability | Row count and every existing row byte-identical before/after the guard's refusals; `computeAuditHash` inputs unchanged |
| G-9 | Cost | Statement count per audit write (healthy path) recorded before/after: expected +1 read (sequence state) for D1-a, 0 extra for D1-b; latency measured under the 20-writer load |
| G-10 | Option C only | Verifier / restore / startup check reports the lag in L1 and L2 and reports healthy otherwise |
| G-11 | Sequence assumptions | Startup assertion fails loudly if the audit sequence is not increment 1, cache 1 (so the arithmetic of §3 is valid) |
Pass criteria: all G-tests PASS on a clean snapshot of the implementing commit, T-22/T-23/T-26 L0 unchanged, and an independent reviewer (not the implementer, not Team 3) accepts the diff.

## 6. Scope limits and risks of the design
- The change would touch only `audit.service.ts` (head read adds `seq`; pre-check; error class), plus an operator runbook and, under option C, small read-only checks. No schema, no migration, no hash change, no permission change.
- B′ introduces a **new operational dependency**: someone must be able to realign the sequence. The runbook and ownership must exist before B′ is enabled; otherwise a lag becomes an outage.
- The pre-check adds a statement to the hottest audit path (measured by G-9); the advisory lock already serialises writers, so the added latency is bounded by one catalogue read.
- DEC-02 interplay: any future recovery that inserts rows with chosen `seq` values must realign the sequence in the same procedure; this design makes a missed realignment visible instead of silent.
- PA-43 is unaffected: the UUID repair concerns rewriting hashed fields, not sequence position.

## 7. Decisions requested (before any implementation)
1. **DEC-01b:** option B′ + C, A (+ C), C alone or D.
2. Operational ownership of realignment (who may run the runbook, under what approval).
3. Whether the audit sequence's increment/cache assertion (G-11) is acceptable as a startup failure.
4. Authorization to implement the chosen option (separate), and the reviewer under WP-REV-01.

## 8. What this document does not claim
It does not claim that any real Company has a lagging sequence (T-26 ran only on disposable databases), that a restore produces lag (not exercised), or that the F-AUD-003 fix is closed (PA-33 stays OPEN). No implementation is authorized by it.
