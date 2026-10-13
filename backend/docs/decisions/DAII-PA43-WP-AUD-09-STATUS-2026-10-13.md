# DAII — PA-43 / WP-AUD-09: pilot review, real-check prerequisites and status — 2026-10-13

PA-43: the active UUID-repair core rewrites `audit_records.actorUserId` and `organizationId`, which are inputs of the audit hash, so a repair on a database whose audit rows reference non-compliant ids would invalidate hashes. Whether any real database needs such a repair is **not known**. DEC-25 interim policy stands (no repair path that rewrites hash-input fields; no re-hash or normalisation of history; the read-only check establishes the need). **Nothing was run on any real database.**

## 4.1 Review of the T-29 pilot (re-checked from the spec source and the evidence files)
| Requirement | Finding | Where |
|---|---|---|
| Run on a disposable database | `setUpBiz('T-29','biz_t29')` creates `daii_test_biz_t29_*` on the dedicated test cluster 5546 and removes them afterwards (post-cleanup shows all removed) | `t29-pa43-uuid-repair-audit-impact.biz.real-pg.spec.ts`; `evidence-clean-snapshot-2026-10-12/5ecb6c3-t29/` |
| Q0–Q6 in READ ONLY sessions | each query runs inside `BEGIN TRANSACTION READ ONLY`; a write attempt in that session is refused with SQLSTATE `25006` (asserted); counts only (Q4 adds `min`/`max` of `seq`) | spec lines 39–60 |
| Hash effect is a simulation | the effect is computed in memory with `computeAuditHash` over the fetched rows; the spec imports no repair function and never calls `auditNonCompliantUuids`/`planUuidRepairMapping`/the repair; fingerprints of `audit_records` and `users` are identical before and after (N1) | spec lines 63–80 |
| Results | P1 PASS (Q1 = 1 non-compliant user id, Q3 = 4 audit rows already carrying it in a hashed column, Q4 = 7 rows, Q5 = 0 repair runs); S1 PASS (4 of 7 rows would change a hash input; chain valid today; would first break at seq 1; 3 untouched rows still verify individually); N1 PASS. Attempt 1 was marked failed by the teardown race (checks all PASS), attempt 2 clean; an earlier run at `bcfce72` showed S1 FAIL-DEFECT caused by an over-strict expectation, corrected before the final run — all three kept | `5ecb6c3-t29/README.md`, `bcfce72-audit-regression/` |
**What this does not show:** that any real database contains such rows, that the repair ever ran, or what the final DEC-25 handling should be. The pilot confirms, on a controlled fixture, the code-reading conclusion; it is **not** evidence about any real database and **does not close PA-43**.

## 4.2 The real check — prerequisites
| Prerequisite | State | Missing / owner |
|---|---|---|
| Approved read-only access (a dedicated role: `CONNECT`+`SELECT` on `users`, `org_units`, `audit_records`, `data_repair_runs` only, read-only by default, no write/DDL/function/sequence rights, no superuser, expiring) | **not provided** | the CTO/owner approves; a DBA creates the role (request text: consolidated closeout report, Annex A) |
| Explicit list of databases allowed (name, server, installation/control-plane vs Company vs legacy single database, no production data) | **not provided** | owner of the environments |
| Read-only protocol | **ready**: `DAII-WP-AUD-09-UUID-REPAIR-PATH-TRACE-AND-READ-ONLY-CHECK-PROTOCOL-2026-10-11.md` (Q0–Q6, counts only, stop conditions) | — |
| Secure storage of results | defined by the protocol (database names, time, role and read-only status, numbers, server identity, tool version; no connection strings, credentials, sample ids or row content) in an evidence folder | — |
The local development database (`daii_dev`, port 5433) and the isolated instances are **not** on any approved list and are protected by the DB guard; this session did not use them for the check, and write-capable credentials are not a substitute for the missing role.

## 4.3 Status and decision frame
**Status: `NEED NOT ESTABLISHED`** — the real check has not been started because the role and the database list do not exist. No repair, realignment or re-hash was run.
How the outcome will be classified once the check can run (per database in the approved scope, then overall):
| Outcome | Criterion | Consequence |
|---|---|---|
| Risk **not established in the examined scope** | Q1 = 0 or Q3 = 0 in every examined database | PA-43 may be downgraded **for that scope only**; unexamined databases stay unexamined; DEC-25 interim policy stays until the authority says otherwise |
| Risk **established — approved action needed** | Q1 > 0 and Q3 > 0 in at least one database | DEC-25 final decision (chain-preserving handling, independent review, integrity proof) before any repair; DEC-02 consulted for chains already affected |
| **Not determinable** | missing permission, unreachable database, scope not covering the installation | stays `NEED NOT ESTABLISHED`; record the missing item and owner |
PA-43 is **not** closed by the pilot passing. Owner of the next step: the CTO/owner (role and database list); then the Audit/Architecture track executes the protocol.
