# DAII — F-INV-001 usage measurement: operator kit (ready to hand over) — 2026-10-13

**Status: READY, NOT EXECUTED.** No real database has been measured; nothing here is a measurement. It consolidates `test-program/F-INV-001-OPERATOR-EXECUTION-GUIDE-2026-10-11.md` into one hand-over and adds what the 2026-10-13 rehearsal proved. The only open input is DEC-10: a named operator, a read-only role, and the list of databases (owner request C7 / D2). Until then the HTTP 410 contract stays **unreleased** (`WP-FIV-03` BLOCKED).

## 1. What was proven in advance
The collector and the summarizer run end to end against a real PostgreSQL: statements are SELECT/SHOW only inside `BEGIN READ ONLY` (the tool refuses otherwise), the output is a JSON file with counts, types, dates and actor ids only, and the summarizer raises a **LIVE CONSUMER SIGNAL** when a non-receipt movement exists in the last 90 days. That was shown on a **synthetic** fixture (`evidence-clean-snapshot-2026-10-13/f-inv-001-collector-rehearsal/`), plus the offline test `tools/ops/f-inv-001-usage-collect.test.js` (3/3). It proves the tooling, not the answer.

## 2. What the operator needs
| Item | Detail |
|---|---|
| Authority | written authorisation from the CTO naming the operator and the databases (DEC-10); production only by a separate approval |
| Role | a database login that can only read: `CONNECT` on each Company database and `SELECT` on `stock_movements` and `audit_records`; `default_transaction_read_only = on`; an expiry. (Text for the DBA to adapt; the team did not create or run it.) |
| Tool | the repository at the commit named in the authorisation: `tools/ops/f-inv-001-usage-collect.js` and `f-inv-001-usage-summarize.js`; Node and the `pg` module |
| Database list | from the control plane: `SELECT "companyId", host, port, "databaseName", status FROM database_registries ORDER BY "companyId";` (read-only) |

DBA sketch (to be reviewed by the DBA, never run by the team): create a login role with an expiry; `GRANT CONNECT` on the Company database; `GRANT SELECT ON stock_movements, audit_records`; `ALTER ROLE … SET default_transaction_read_only = on`. No write, DDL, function, sequence or superuser rights.

## 3. Steps (per Company database)
1. `OPERATOR="<name>" PGHOST=… PGPORT=… PGUSER=<read-only role> PGPASSWORD=<from your own secret store> node tools/ops/f-inv-001-usage-collect.js --database <name> --out result-<db>.json` — it runs Q1–Q4 for all history and the last 90 days.
2. Collect every `result-*.json` (the password is never written to them).
3. `node tools/ops/f-inv-001-usage-summarize.js result-*.json` prints the decision table and lists databases or periods that are missing.
4. If request logs or API-gateway logs exist, add the count of `POST /api/inventory/movements` by caller identity for the same two periods (the only way to see rejected or unrecorded calls).
5. Return: the result files, the summary, the list of databases queried and any not queried (with the reason), the operator name and run time, the log counts if available. No credentials, no row contents.

## 4. How the result is read (unchanged rule)
| Result | Consequence |
|---|---|
| Non-receipt movements = 0 in all databases and both periods | supports closing the types; still not proof about external callers (the summarizer states this) |
| Only older than 90 days | identify the actor; confirm with the owner that the consumer is gone; consider a deprecation window |
| Any in the last 90 days | **live consumer — do not release the 410 change**; identify (Q2) and migrate the consumer to the governed path first |
| Any call from an unknown caller in the logs | contact the owner before release |
Release rule: all in-scope databases and both periods returned; no live consumer (or each migrated); log check clean if logs exist; the CTO approves in writing. The team never states that the change is "safe" from this evidence alone.

## 5. What the team does on receipt
Store the files under `docs/decisions/test-program/evidence-…/f-inv-001-usage/` with their hashes; produce the compatibility assessment (`WP-FIV-02`); hand the CTO the decision record (`WP-FIV-03`). Nothing is deployed.
