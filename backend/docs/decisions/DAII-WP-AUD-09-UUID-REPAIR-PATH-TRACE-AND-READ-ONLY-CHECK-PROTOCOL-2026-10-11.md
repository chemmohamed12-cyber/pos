# DAII — WP-AUD-09 (PA-43): UUID repair path trace and read-only need-check protocol — 2026-10-11

Prepared by Team 3 (documentation and coordination). **Step 1 (code trace) is complete; step 2 (need check) is a protocol for the Audit/Architecture track — Team 3 has no database access and ran nothing.** Authority: CTO decisions of 2026-10-11 — a read-only need check on **non-production** Company databases with **approved read-only access** (if no approved access exists the check stops; broader privileges are not substituted), no repair run, no write/modify/delete/re-hash/normalise, no production access, no sensitive-data copying or wider extraction than required; and the interim policy for DEC-25 (below). PA-43 stays separate from PA-33; nothing here closes any finding.

Source read at HEAD `6793607` (no change to the files below since the findings were registered). Classes: **VERIFIED** (read in code), **INFERRED**, **UNVERIFIED**.

## 1. Interim DEC-25 policy (CTO, 2026-10-11) — applies from now
1. UUID repair must **not** be run on any path that rewrites the hash-input fields of `audit_records` until a chain-preserving handling is approved.
2. No rewrite, re-hashing or normalisation of historical rows as part of routine repair.
3. The read-only WP-AUD-09 check determines the actual need.
4. After the results, a final decision defines how any discovered need is handled, with independent review and integrity proof.
This policy does not establish that the repair ever ran, nor that any chain is damaged.

## 2. Step 1 — the complete path, from the code
| # | Stage | What the code does | Reference | Class |
|---|---|---|---|---|
| 1 | Entry | Release Center "Controlled Data Repair" service; permissions are the `system.release.*` leaf per the migration comment | `src/foundation/release/data-repair.service.ts` (class doc); migration `1755853200000-AddDataRepairRunTable.ts` | VERIFIED |
| 2 | Database it acts on | The service is constructed with the injected default `DataSource` (`this.dataSource`) and runs every step — audit, plan, execute, verify — on it. There is no loop over Company databases in this service | `data-repair.service.ts` constructor, `reader` getter, `execute` (`this.dataSource.transaction`) | VERIFIED |
| 3 | Which database that is | In the multi-Company design the default (ambient) DataSource is the installation/control-plane database; Company databases are reached through separate Company connections. The service never obtains one | other records (`INTEGRATIONS-TENANCY-DECISION-RECORD` describes the ambient DataSource) | INFERRED; to be confirmed on a real deployment |
| 4 | Run states | `audited → planned → backup_linked → running → verifying → completed or failed`; each step is a separate API call | `data-repair.service.ts` `createAndAudit`, `plan`, `linkVerifiedBackup`, `execute` | VERIFIED |
| 5 | Gates before execute | A mapping must exist; a backup run must be linked and its database artifact must be `verified` ("No Verified Backup → No Repair"), re-checked live at execute | `linkVerifiedBackup`, `assertBackupVerified`, `execute` preconditions | VERIFIED |
| 6 | What is detected | Primary keys of the tables in `PK_TABLES` whose `id` does not match the strict regex `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` — **keyed on primary keys, not on audit rows** | `src/database/uuid-repair.core.ts` lines 59, 67, 311–340 (`auditNonCompliantUuids`, read-only counts plus up to 10 sample ids) | VERIFIED |
| 7 | What `execute` does | In one transaction: FK constraints made deferrable; for each non-compliant primary key a fresh id is generated; then `UPDATE` of every DB-enforced child column, every `SOFT_REFERENCES` entry (line 461), every polymorphic reference, shared-PK tables for users, and finally the primary key itself (line 476); constraints restored | `uuid-repair.core.ts` lines 392–495 | VERIFIED |
| 8 | How audit rows are touched | `audit_records.actorUserId` (line 116, target `users`) and `audit_records.organizationId` (line 187, target `org_units`) are in `SOFT_REFERENCES`, so they are updated **only when the corresponding `users.id` or `org_units.id` is itself non-compliant** and being repaired. JSON `before`/`after` are deliberately not rewritten (header, line 38) | lines 38, 95–116, 187, 461 | VERIFIED |
| 9 | Hash handling | No hash recomputation, chain verification or audit-row exemption exists in the file; both columns are hash inputs (`computeAuditHash`) | `uuid-repair.core.ts` (searched for hash/chain terms: none), `src/foundation/audit/audit-hash.ts` | VERIFIED |
| 10 | Verification after execute | `verifyUuidRepairIntegrity`: orphan sweep over FK, soft and polymorphic references, auth/role integrity, zero remaining non-compliant keys. It checks references, **not the audit chain** | `uuid-repair.core.ts` lines 508–603 | VERIFIED |
| 11 | Audit trail of the repair itself | The service records its own events through `AuditService.record` (appended normally, not rewritten) | `data-repair.service.ts` | VERIFIED |
| 12 | Second path to the same code | The repair algorithm is "shared verbatim" with the **deferred** migration `RepairNonCompliantUuids` under `tools/data-repair/deferred-migrations/`. Deferred = not in the enabled migration registry; it runs only if someone adds it to a tag and a migration runner executes it on a database | `data-repair.service.ts` class doc; the migration file header | VERIFIED (text); whether it was ever applied: UNVERIFIED |
| 13 | Why it exists | v1.0.3 left `treasury_accounts` and other pre-fix tables with non-RFC4122 keys; generation was fixed by `1755852500000`, so **only rows created before that fix can be non-compliant** | `data-repair.service.ts` class doc | VERIFIED (text) |

## 3. What the trace changes about PA-43 (conclusions are bounded)
| Statement | Class |
|---|---|
| The two audit columns are rewritten **only** when a `users` or `org_units` primary key is non-compliant (not for every repair) | VERIFIED |
| Only rows created before migration `1755852500000` can have non-compliant keys | VERIFIED (text) / the data itself UNVERIFIED |
| Through the Release Center service the reachable database is the default DataSource, not each Company database | VERIFIED for the code; INFERRED for what that database is |
| Therefore the practical exposure is narrower than "every repair" but still real for any database whose `users` or `org_units` contain a non-compliant key and whose audit rows reference it; a database of that kind is most plausibly a legacy single-database installation | INFERRED |
| Whether any such database exists, and whether the repair or the deferred migration was ever applied anywhere | UNVERIFIED |
| Another safeguard that detects the chain effect after a run | none found in the files read (`verifyUuidRepairIntegrity` does not verify the chain) |
Severity stays provisional (Medium–High) until the check below is done.

## 4. Step 2 — the read-only need-check protocol (for the Audit/Architecture track; Team 3 does not execute it)
### 4.1 Preconditions (all required; otherwise STOP)
1. A database role **approved for read-only access** to the named **non-production** databases by the CTO/owner. If none exists, the check stops here; a broader or shared privilege is not used instead.
2. Production, hosting and protected clusters are out of scope. The list of databases to be covered is written down before starting (installation/control-plane database and any non-production Company or legacy single-database copies the owner names).
3. Every session is opened read-only (`BEGIN TRANSACTION READ ONLY` or `SET default_transaction_read_only = on`); a role that has write privileges is not used for this check.
4. No other DB-backed test run is active on the cluster (shared, serialised).

### 4.2 Queries (counts only; no sample ids, no row contents)
Run per database; skip a table that does not exist (`to_regclass`). Let `RX` be the strict regex above.
| Q | Statement (read-only) | Purpose |
|---|---|---|
| Q0 | `SELECT to_regclass('public.users') IS NOT NULL, to_regclass('public.org_units') IS NOT NULL, to_regclass('public.audit_records') IS NOT NULL` | which tables exist |
| Q1 | `SELECT count(*) FROM users WHERE id::text !~* RX` | non-compliant user keys |
| Q2 | `SELECT count(*) FROM org_units WHERE id::text !~* RX` | non-compliant org-unit keys |
| Q3 | `SELECT count(*) FROM audit_records WHERE "actorUserId"::text !~* RX OR "organizationId"::text !~* RX` | audit rows that already carry a non-compliant id in a hashed column (these are the rows the repair would touch, or which already reference such ids) |
| Q4 | `SELECT count(*), min(seq), max(seq) FROM audit_records` | context for the chain size |
| Q5 | `SELECT count(*) FROM data_repair_runs` (if the table exists) | whether the Controlled Data Repair was ever created in this database |
| Q6 | `SELECT status, count(*) FROM data_repair_runs GROUP BY status` | whether any run reached `completed` |
Do **not** call `auditNonCompliantUuids` as written (it returns up to 10 sample ids); the queries above give counts only. Do not run `planUuidRepairMapping` (it allocates new ids and lists old ones).

### 4.3 Evidence to keep per database
Database name (not credentials), date and time, role used and its read-only status, the Q0–Q6 outputs (numbers only), the PostgreSQL server identity, the tool or script version used, and any error. Store in the project workspace under a new evidence folder; no connection strings or passwords.

### 4.4 Interpretation (no decision is taken by the check)
| Outcome per database | Meaning for PA-43 |
|---|---|
| Q1 = 0 and Q2 = 0 | The repair has nothing to repair for users/org-units there: no effect on the two audit columns in this database |
| Q1 or Q2 > 0 and Q3 = 0 | Keys are non-compliant but no audit row references them in a hashed column: the repair would not change audit hash inputs here |
| Q3 > 0 | Audit rows carry non-compliant ids: a repair would rewrite hashed fields of N rows; the DEC-25 interim prohibition applies and a chain-preserving handling must be approved first. (Also record whether those rows already verify, using the existing verifier only if separately authorised) |
| Q5/Q6 show a completed run | The repair has run in that database: historical chain effects must be assessed read-only; escalate to the CTO |
| Access not approved | STOP; record "need not established" — never "no need" |

### 4.5 Stop conditions
No approved read-only role; any statement that would write; any request for production; any unexpected table with sensitive content being read; output exceeding counts. In each case stop and report.

## 5. Outputs and next decisions
- A trace note (this document, section 2–3) for independent review by someone who did not write the repair path.
- The need table per database (after step 2).
- The **final DEC-25 decision** after the results: how a discovered need is handled (for example, exclude the two columns, re-anchor under an approved procedure, or forbid the repair for such databases), with independent review and integrity proof. None is chosen here.
- Packages: WP-AUD-09 (this); DEC-25; independent of DEC-02 and PA-33.

## 6. What this document does not claim
It does not say the repair has ever run, that any chain is broken because of it, or that any Company needs it. It authorises no run, no write and no access.
