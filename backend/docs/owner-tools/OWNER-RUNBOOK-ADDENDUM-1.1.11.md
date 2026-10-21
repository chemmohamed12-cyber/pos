# Owner runbook - addendum for the DAII 1.1.11 upgrade (2026-10-21): Company databases left behind

Who runs it: the owner, on the hosting server. The team has no host access and has **not inspected or changed the host**; everything below is a procedure and a decision sheet, not a report of what is on the host. Read `OWNER-RUNBOOK.md` first; this addendum only states what is different after 1.1.11 and what to decide before anything is changed.

## What happened (hypothesis, to be confirmed on the host - Stage 0)
Screens such as "Cash sessions" and "Warehouse overview" answered "An unexpected error occurred" for company "Test2" after 1.1.11 was activated. This is the same signature as the 1.1.10 incident: the release engine migrated the PLATFORM database (to 320) while the Company databases stayed on the old schema, because `RELEASE_COMPANY_MIGRATIONS` was unset/`off` (it migrates platform only). The new code then queries tables/columns that do not exist in a Company database (`relation "cash_sessions" does not exist`, `column ... does not exist`). Verified by reproduction on isolated databases (a pre-1.1.11 Company snapshot checked against the 1.1.11 build lacks 14 tables and 12 columns, e.g. `cash_sessions`, `bank_statements`, `purchase_returns`, `supplier_credit_notes`, `supplier_invoices.matchStatus`); **not yet confirmed on the host**.

## Stage 0 - confirm (read-only, 5 minutes)
1. Backend log (Passenger / stderr) around a failing request: search `does not exist` / `QueryFailedError`. Expected: a missing relation or column, with the Company context. **If the exception is anything else, STOP and send it to the team.**
2. Release Center: the 1.1.11 row must be `succeeded`; the deploy events (Release Center -> the release -> events, or the audit trail) should show `company_fanout` with `mode: off`.
3. cPanel -> Setup Node.js App -> variables: value of `RELEASE_COMPANY_MIGRATIONS` (unset = off in 1.1.11).

## Stage A - read-only diagnosis (no changes) - same tools as the 1.1.10 runbook
```
bash run-owner-tool.sh status      # Stage A, strictly read-only
bash run-owner-tool.sh plan        # plan of the catch-up tool, read-only
```
Expected if the hypothesis is right: `PLATFORM ... 320 recorded, 0 missing`; each Company line `INCOMPLETE (N missing)` where N is the number of 1.1.11 migrations the Company lacks (21 if it was fully on 1.1.10; fewer if some were applied earlier; **the list is authoritative, not this number**). The 21 shipped by 1.1.11 are listed in the release report.
Optional, recommended: the status tool v2 (`owner-tools/v2/company-migration-status.js`, hashes in `v2/SHA256SUMS`) additionally reports SCHEMA DRIFT per Company (missing columns/tables of the running build's entities). It is read-only (session forced read-only), changes nothing, and is only needed to see drift that a complete migration list would hide.

### Decision sheet - fill it in BEFORE any change (send it to the team with the Stage A output)
| Question | Answer |
|---|---|
| Installed build / release id (row 1.1.11, `succeeded`) | |
| Platform: recorded / missing | expect 320 / 0 |
| For EACH Company database: name, status (READY?), recorded, missing list | |
| Any Company `UNREADABLE`, status not READY, or `unknownToThisBuild` not empty? | STOP if yes |
| Any Company missing migrations that are NOT among the 21 of 1.1.11? | STOP if yes |
| Disk space for one pg_dump per affected Company (restore points) | |
| A maintenance window is agreed (the Company is closed (MIGRATING) while it migrates) | |
| Approval to run Stage B1 / B2 (who, when) | |

## Stage B - repair (only after the decision sheet is approved) - unchanged from the runbook
- **B1** (`--restore-points-only`): takes and verifies a restore point per affected Company, migrates nothing. Check the files yourself (`pg_restore --list`).
- **B2** (`--apply`): migrates READY Companies one at a time (READY -> MIGRATING -> READY), stops at the first failure, verifies nothing is pending. Each migration is recorded once; a second run finds nothing pending.
- Do **not** upload 1.1.11 again: the engine refuses to re-deploy a live version, and nothing in the application files is wrong.
- Forward only: no migration is reversed automatically. A `down()` drops the new tables with their content - use the restore point only if a Company database is damaged.

## After the repair
1. Stage A again: every Company `COMPLETE`, exit 0.
2. Smoke (no restart needed): Warehouse overview, Cash sessions (Treasury), Treasury documents, Supplier invoices, Purchase returns, Supplier credit notes, Sales orders, one report. Anything still failing: send the log line.
3. Set `RELEASE_COMPANY_MIGRATIONS=on` in the Node.js App variables (or install 1.1.12, where `on` is the safe default and `off` can no longer produce a platform-only success) so the next release migrates Companies itself, with restore points and verification.
4. Four GL accounts per Company (finance owner): until assigned, returns / credit notes / charges are refused with a message naming the account; this is intended.

## What the team cannot see from here
The actual exception, the host's `RELEASE_COMPANY_MIGRATIONS`, the state of every Company database (only "Test2" is visible in the screenshot), whether `pg_dump` works for per-Company restore points on the host, and the post-repair behaviour on https://daii.xnexustech.com.
