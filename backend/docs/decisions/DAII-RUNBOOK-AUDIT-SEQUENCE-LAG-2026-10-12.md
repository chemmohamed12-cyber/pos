# DAII — Runbook (EXPERIMENTAL SCENARIO, not approved for production): audit sequence lag — when appends are blocked, escalation and verification — 2026-10-12

Prepared by Team 3 (documentation) under the CTO directive of 2026-10-12, item 4. **Status: EXPERIMENTAL operating scenario (CTO directive of 2026-10-12: the environment is experimental; virtual functional roles are used and no personal names are requested). It is not approved for production, and nothing in it has been executed or tested: the audit writer's Option B behaviour exists in commit `4d4ed0d` but has not been run against a database (the test cluster is down), so every statement below about system behaviour is a design statement, not a test result.** It applies to the Option B behaviour (fail closed on sequence lag, no automatic realignment) specified in `DAII-WP-AUD-08-OPTION-B-RESTORATION-IMPACT-AND-CHANGE-SPECIFICATION-2026-10-12.md`. This task covers no production system and no historical audit record; this runbook must be approved before any real operation, and its statements about production are procedure, not authorization.

## 1. Roles — virtual functional roles (experimental)
| Role | Function | In this experiment |
|---|---|---|
| `DB_OPERATOR` | The only role allowed to run the §5 remediation, on the experimental database only | Virtual role; no person assigned |
| `APPROVER` | Approves each §5 execution in writing; never the same holder as `DB_OPERATOR` | Virtual role |
| `ESCALATION_OWNER` | Receives every unexplained lag and decides with the CTO | Virtual role |
| `OPS_CONTACT` | First responder: detects and reports; performs no remediation | Virtual role |
Names, real permissions and the approved database list are required before any use outside the experiment. Until a real assignment exists, the only actions are §3 (detect, stop, report) and read-only diagnosis (§4).

## 2. When appends must be blocked (trigger)
Appending is blocked **by the system** when the audit writer refuses with `AuditSequenceLagError` (the sequence's next value is not above the stored tail `seq`). Consequences: audited operations in that Company fail with an identifiable error; no audit row is written; the sequence is unchanged. People must additionally **stop** the following while a lag is open:
1. any import, restore, bulk copy or manual change touching `audit_records` or its sequence;
2. any retry loop or script that re-submits the failed operations (the failure is deterministic until the cause is handled);
3. any UUID repair or data repair run (DEC-25 interim policy);
4. any manual `INSERT`, `UPDATE`, `DELETE` or re-hash of `audit_records` — never permitted.
The product never realigns the sequence by itself and no job may be added to do so.

## 3. Detect, stop, report (first responder; no database privilege needed)
Collect: Company, time, the error text (it contains the tail and the next value, no row data), the operation that failed, and whether a restore, import or maintenance ran recently. Report to the escalation owner immediately. Do not retry beyond one confirmation attempt.

## 4. Escalation and diagnosis
| Level | Who | Action | Output |
|---|---|---|---|
| L1 | Operations contact | §3 report | incident record opened |
| L2 | Authorised DBA (read-only first) | Diagnose with read-only statements below | cause classification |
| L3 | Escalation owner, then CTO | Decide whether realignment is allowed | written approval or hold |
Escalation time targets are left to the owner; none is invented here. An *unexplained* lag is treated as a possible data-integrity incident: no realignment before an explicit decision (CTO directive).
Read-only diagnosis (counts and numbers only; no row contents):
```sql
SELECT last_value, is_called FROM <audit sequence>;          -- the sequence named by pg_get_serial_sequence('audit_records','seq')
SELECT count(*), max(seq) FROM audit_records;
```
Also run the product's existing read-only chain verification before any action and keep its result (a chain that was already broken is a separate matter, DEC-02, and is not repaired by this runbook).
**Classification:** (a) *explained* — a documented restore, import or reset explains why the next value is not above `max(seq)`; (b) *unexplained* — treat as a possible integrity incident: no realignment until the escalation owner and the CTO decide.

## 5. Authorised remediation (only after §1 is complete and written approval exists)
Executed by the designated DBA only, on the approved database only, never automated. The audit writers serialise on the transaction-scoped advisory lock used by the product (`7419203511`); the DBA takes the same lock so no writer interleaves:
```sql
BEGIN;
SELECT pg_advisory_xact_lock(7419203511);
SELECT setval(pg_get_serial_sequence('audit_records','seq'), (SELECT max(seq) FROM audit_records), true);
COMMIT;
```
(Template for the approved procedure; not to be run without the §1 designation and approval. `setval` is not rolled back by a rollback.) Nothing else is changed: no audit row is read for repair, rewritten, deleted or re-hashed.

## 6. Verification after a manual remediation
1. Sequence state: next value is strictly above `max(seq)` (`last_value ≥ max(seq)` with `is_called`).
2. History untouched: row count, `max(seq)` and the tail hash equal the values recorded before; the chain-verification result equals the result recorded before (a previously valid chain is still valid; a previously broken chain is unchanged).
3. First append after the fix: the next natural audited operation succeeds (or a controlled probe in a non-production database); the new row has `seq` above the old tail and `prevHash` equal to the tail hash; chain verification still gives the same result.
4. Record: incident id, Company/database, executor, approver, approval reference, times, before/after values, results of 1–3, cause classification. Keep the record with the incident.
5. If any check fails: stop, do not retry, escalate to L3.

## 7. Prohibited (always)
Production use under this task; any write to `audit_records`; any re-hash or normalisation; UUID repair; automatic or scheduled realignment; running §5 without the written designation and approval; copying audit content into incident tickets (numbers only).

## 8. What is and is not tested
| Item | State |
|---|---|
| Writer refuses on lag, no `setval`, sequence untouched (Option B) | IMPLEMENTED in `4d4ed0d`; **NOT RUN** against a database; acceptance spec T-28 written, not run |
| Operator realignment as in §5, and the post-checks of §6 | Part of T-28 (B5, B5b, B7) — **NOT RUN** |
| Escalation levels and roles | Design only; no drill performed |
| Test cluster | **Down** (PANIC: no valid checkpoint record, per the 2026-10-12 review report) — blocks every database-backed check |

## 9. Open items (for any use beyond the experiment)
Real assignment of the four roles; escalation time targets; the approved databases where §5 may ever be used; confirmation that the audit sequence is increment 1, cache 1 (assumed by the pre-check; asserted nowhere yet); a rehearsal on a disposable database once the cluster is available (T-28); independent review of this runbook once a reviewer exists.
