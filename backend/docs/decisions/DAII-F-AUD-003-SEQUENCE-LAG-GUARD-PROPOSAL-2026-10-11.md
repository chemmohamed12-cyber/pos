# DAII — F-AUD-003 (PA-33): sequence-lag guard — proposal for a decision — 2026-10-11

Prepared by Team 3 (documentation and coordination) under the CTO decision of 2026-10-11, item 5: *no implementation now; submit a proposal that states the target scenario, the expected behaviour and the test that would justify the addition; then a decision is taken.* **Nothing in this document changes product code, schema or configuration, and it does not touch existing audit records or broken chains (DEC-02 stays separate).** It is not an acceptance of the F-AUD-003 fix, which remains OPEN pending clean-snapshot verification and an independent review by a reviewer unconnected to the fix, the helper it uses and the commits.

Baseline: source read at HEAD `520f2e0`; the fix under discussion is `c764fc5` (`audit.service.ts`): under the audit advisory lock the writer reads the head row, draws `nextval(pg_get_serial_sequence('audit_records','seq'))`, hashes that value and inserts it explicitly. Evidence classes are stated per item.

## 1. The target scenario (what the guard would protect against)
**"Sequence behind the data":** the table contains a row whose `seq` is ≥ the sequence's next value, so `nextval` returns a number that is **equal to or lower than** the current maximum `seq`.

**Why it matters after `c764fc5` (INFERRED from the code; not exercised by any test today):**
| Sub-case | Effect with the current code |
|---|---|
| `nextval` equals an existing `seq` | the explicit `INSERT` raises a primary-key violation (23505): the audit write fails, so the business operation that depends on it fails — loud, an availability problem |
| `nextval` is lower than the head `seq` but unused | the row is inserted with a lower `seq` than the chain head, while `prevHash` was taken from the head (highest `seq`) — verification orders by `seq` ascending, so the chain is reported broken at that row: **silent in operation, detectable at verification** (an integrity problem) |
| Before the fix (for comparison) | `MAX(seq)+1` was hashed but TypeORM stored the serial value; a lagging sequence produced the same mismatch family |

## 2. How the scenario could arise (triggers) — facts and unknowns
| Trigger | Status |
|---|---|
| Restore through the product | `pg_restore` of a full dump restores sequence values with the data, so a normal product restore does **not** produce lag (VERIFIED by reading that the restore manager uses `pg_restore` for the whole database; the dump carries `setval`). Sequence behaviour of a restore was not exercised in this program (the restore specs are among the NOT RUN/BLOCKED groups until the guard decisions) |
| Table-level import or copy (data moved without its sequence) | No code path in `src` inserts explicit `seq` values other than the new writer (VERIFIED: one `INSERT INTO "audit_records"`); an operator-run import is conceivable but undocumented |
| Manual repair or "checkpoint/re-anchor" records proposed under DEC-02 | **Plausible future trigger**: any recovery policy that inserts rows with chosen `seq` values must also realign the sequence |
| Tests | `T-23` P1/P2 set the sequence manually on a disposable database — by design, not a product path |
| Controlled Data Repair (UUID repair) | **Related observation, separate risk:** the active `src/database/uuid-repair.core.ts`, used through the Release Center's `data-repair.service.ts`, lists `audit_records.actorUserId` and `audit_records.organizationId` among the soft references it rewrites when a non-compliant UUID is repaired. Those columns are inputs of the audit hash, so running that repair on a Company whose audit rows reference repaired ids would **change hashed fields of historical rows** and make the chain verify as broken. This is not caused by the F-AUD-003 fix and not addressed by a sequence guard; it concerns "no modification of historical audit records". It is a code-reading observation (whether any Company has non-compliant ids, and whether the repair has ever run, is unknown). **Registered by the CTO (2026-10-11) as the separate finding PA-43** (package WP-AUD-09, decision DEC-25); it is not part of PA-33 |

## 3. Expected behaviour (acceptance language, to be decided)
For the target scenario, an audit write must (a) never produce a primary-key violation or an out-of-order row silently, (b) keep the hash tied to the stored `seq`, (c) leave existing rows untouched, and (d) make the anomaly visible rather than hiding it.

## 4. Options
| Option | Behaviour | Pros | Cons / risks |
|---|---|---|---|
| **A. Self-healing at write time** | Compare the drawn `nextval` with the head row's `seq` (already fetched by `ORDER BY seq DESC LIMIT 1` if `seq` is added to the select list). If `nextval ≤ headSeq`, realign the sequence (`setval(seq, headSeq)`) and draw again, then proceed; log/audit the realignment | Operations continue; no PK violation; chain stays ordered | Silent healing could mask an unexplained import/restore problem unless the realignment is itself recorded; extra branch in the hottest audit path; `setval` is non-transactional |
| **B. Fail closed** | If `nextval ≤ headSeq`, throw a clear error and write nothing | Integrity-first; makes the anomaly impossible to miss | Blocks every audited operation in that Company until an operator realigns the sequence (availability) |
| **C. Check outside the write path** | Verify `last_value ≥ max(seq)` at startup, after a restore (restore manager) and in the chain verifier; alert, do not intercept writes | No cost or risk on the write path; fits the restore flow | Does not protect between the event and the next check |
| **D. No guard (accept)** | Rely on the absence of any explicit-seq writer; document the rule that any future writer must realign the sequence | Zero change | The failure mode is real if DEC-02's recovery or a manual import is ever used |
Team 3's non-binding observation: the justification depends on whether a realistic trigger exists. Today none is shown in code; the plausible future trigger is the DEC-02 recovery policy. C (restore/startup/verifier check) or D (accept, with the rule recorded in DEC-02) are the lowest-risk to the hot path; A or B are only warranted if the CTO wants runtime protection.

## 5. The test that would justify an addition (specification; not run)
Disposable Company database under the guarded harness; style A (plain manager) and B (transaction):
1. **Baseline on current code:** with 5 healthy rows, `setval` the sequence to a value *equal to* the head `seq`, append one record → expect and record the observed outcome (PK violation expected). Then `setval` to a value *below* the head and above a gap, append → record whether the row is inserted out of order and what `verifyCompanyChain` reports. These two outcomes decide whether the scenario is real and which sub-case is the dangerous one.
2. **Concurrency:** with the sequence lagging, 20 concurrent appends → record duplicates/violations and chain validity.
3. **With an option implemented** (only after a decision): the same scenarios must give, for A: appends succeed, `seq` strictly above the head, sequence realigned, chain valid, one recorded realignment; for B: no row written, a clear error, chain unchanged; for C: the check reports the lag at startup/verification.
4. **Non-regression:** T-22/T-23 (rollback, concurrent, mixed, golden hash vector, healthy and already-broken chains preserved) unchanged.
The addition is justified only if step 1 shows an actual failure for a trigger that the CTO considers realistic; otherwise D with a recorded rule.

## 6. Decision requested (single question)
Which option (A, B, C or D), conditional on step 1 of the test. The UUID-repair observation in §2 is now the separate finding PA-43 and is not decided here. No implementation until decided; DEC-02 (already-broken chains) is not decided here.
