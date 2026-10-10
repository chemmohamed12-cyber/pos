# F-INV-001 — Operator execution guide (read-only usage measurement)

Status: **READY FOR AN AUTHORISED OPERATOR; NOT EXECUTED.** The agent has no authorisation or access to any real Company database. This is the precise external blocker: **a named operator with read-only access to the production/hosting Company databases (decision D-9).** The HTTP 410 change (`POST /api/inventory/movements` refuses dispatch, adjustment, transfer_in, transfer_out, return) is **NOT APPROVED FOR RELEASE** until the returned evidence is reviewed and the release is explicitly approved. Queries: `F-INV-001-USAGE-MEASUREMENT-QUERIES-2026-10-10.md` (Q1–Q4, unchanged).

## 1. Scope
- **Databases:** every Company database of every installation in scope (ask for production; staging is not evidence of customer usage). Enumerate them from the control-plane database: `SELECT "companyId", host, port, "databaseName", status FROM database_registries ORDER BY "companyId";` (read-only). One result set per Company database.
- **Observation period:** (a) the entire history (no date filter) and (b) the last 90 days separately (`"createdAt" >= now() - interval '90 days'`) so that "once used long ago" and "used now" can be told apart. Record the oldest `stock_movements` row of each database so the reader knows how far back the history reaches.
- **Out of scope for this query set:** application logs/API-gateway logs and integration (API-key) call logs — if they exist, the operator should also return the count of `POST /api/inventory/movements` requests by caller identity for the same periods; this is the only way to see calls that were *rejected* or never produced a row.

## 2. Minimal execution guide
1. Use a read-only database role (or `SET default_transaction_read_only = on;` as the first statement of the session). Do not run anything but the SELECT statements in the queries file.
2. For each Company database run Q1–Q4 twice (all history; last 90 days) and save the raw output with: database name, host, run timestamp (UTC), operator name, and the period.
3. Also return, per database: `SELECT count(*), min("createdAt"), max("createdAt") FROM stock_movements;`.
4. Do not send credentials or full row contents; counts, types, dates and actor ids are enough. Actor ids identify the consumer: a person or a service/API-key identity.
5. Return the files (or a signed summary) to the DAII verification team; do not modify any data or apply the release before the review.

## 3. What to return, and how to read each result
| Result | Meaning | Release consequence |
|---|---|---|
| **Q1** by `movementType` (rows with `referenceType` and `referenceId` NULL — what the endpoint wrote) | Counts and first/last use per type; `receipt` is expected and unaffected | Only non-receipt rows matter |
| Q1: non-receipt types = 0 rows in all databases and both periods | No recorded use through the endpoint | Supports closing the types; still not proof about external callers whose calls always failed |
| Q1: non-receipt rows exist, last use older than 90 days | Historical use, possibly retired | Identify the actor (Q2); confirm with the owner that the consumer is gone; consider a deprecation window |
| Q1: non-receipt rows exist in the last 90 days | **Live consumer** | Do **not** release the 410; identify (Q2) and migrate the consumer to the governed path (warehouse transactions, shipments, returns) first |
| **Q2** actors of non-receipt rows | A person ⇒ a user doing manual stock correction; a service/API-key identity ⇒ an integration | Decide the migration path per actor |
| **Q3** audit actions `inventory.movement.<type>` (not receipt) | Cross-check of Q1 (the audit row is written with every movement; internal flows also write it, so Q3 can be larger than Q1) | A Q3 type absent from Q1 means internal flows only |
| **Q4** negative on-hand pairs | Symptom of the closed path (stock below zero) | Nonzero ⇒ separate corrective-movement process (not part of this change) |
| Gateway/API-key call counts, if available | Shows rejected/unrecorded calls | Any call from an unknown caller ⇒ contact the owner before release |
**Limitation (state it in every report):** absence of rows in the databases queried does not prove absence of external integrations in other installations, nor of integrations whose calls always failed validation; only the request logs can show those.

## 4. Release decision rule
Release the 410 contract only when: all in-scope databases and both periods are returned; no live consumer is found (or every consumer is migrated); the request-log check (if logs exist) shows no unknown caller; and the CTO explicitly approves. Otherwise keep the change out of the release (rollback = revert the controller change; no data migration involved).

## 5. Tooling for the operator (added 2026-10-11, decision D-02: read-only verification approved; release change NOT approved)
- `tools/ops/f-inv-001-usage-collect.js` runs Q1–Q4 for **one** Company database, for **all history** and the **last 90 days**, inside `BEGIN READ ONLY` (the script refuses to continue if the session is not read-only and always rolls back), and writes one JSON file: `OPERATOR="Name" PGHOST=… PGPORT=… PGUSER=<read-only role> PGPASSWORD=… node tools/ops/f-inv-001-usage-collect.js --database <name> --out result-<name>.json`. Run it once per in-scope Company database (list them from `database_registries` in the control plane). The password is taken from the environment only and is never printed or written.
- `node tools/ops/f-inv-001-usage-summarize.js result-*.json` builds the decision table from the returned files and lists the databases/periods that are missing. It never states that the change is safe to release.
- Verification of the tooling: `node --test tools/ops/f-inv-001-usage-collect.test.js` (fake client: statements are SELECT/SHOW only, inside a read-only transaction, refusal when the session is not read-only). **The tool has not been run against any real database by the agent** (no authorisation, no operator designated). The collector is registered as an operator tool in the database-guard coverage test.
- Evidence to return: the result files, the list of databases queried (and any not queried, with the reason), the operator name and run time, and — if available — request-log counts of `POST /api/inventory/movements` by caller identity for the same periods. Preserve them under `docs/decisions/test-03/evidence/f-inv-001-usage/` (or an equivalent controlled location) with a SHA-256 manifest.
- Gate: F-INV-001 stays **blocked from release** until these results are reviewed and the compatibility risk is explicitly accepted in writing; the absence of internal callers is not proof that external or historical usage does not exist.
