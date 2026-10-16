# Owner runbook - repair of Company databases after the DAII 1.1.10 upgrade (2026-10-17)

Who runs it: the owner, on the hosting server. The team has no host access and has not inspected or changed the host. Nothing here is done by the team on your behalf.
Why: after 1.1.10 the platform database is at 299 migrations, but Company databases may still be at 288 (the engine default `RELEASE_COMPANY_MIGRATIONS=off` migrates only the platform). 1.1.10 reads columns that exist only after the 11 new migrations, so Products, Suppliers, Warehouse Overview and Sales answer HTTP 500 (`column Product.itemType does not exist`, `column Supplier.email does not exist`, `column Customer.partyType does not exist`). This is a hypothesis reproduced in a simulation; Stage A tells you whether it is true on your host.

## The two tools (reviewed, tested copy)
| File | SHA-256 | Role |
|---|---|---|
| `company-migration-status.js` | `35a07d963b7e6ce8032cd16a42bc0a8fc20e9d78020f7e7bd3efbdaa91e35901` | Stage A. Strictly read-only (Company connections are forced read-only). |
| `company-migration-catchup.js` | `8b09c97d10439b6c98e9b1f5a315b8e4be3d377306305738e2d4bb7d94a8a582` | Plan mode (read-only) and Stage B (`--apply`). |
| `run-owner-tool.sh` | see `SHA256SUMS` | Launcher for the host (node + environment, no secrets printed). |

Check them before use: put both files and `SHA256SUMS` in one folder and run `sha256sum -c SHA256SUMS` (both lines must say OK). Do not run a file that does not match.
Both files only use code that is already installed with the application (the Release Engine of the ACTIVE release, TypeORM, pg). They contain no SQL that changes data (only SELECTs). The migrations themselves are run by the engine's own Company fan-out service, with its own restore points, status handling and audit records. They are not part of the 1.1.10 package and change nothing in it.

## Host launcher (use this on the cPanel/CloudLinux host) - `run-owner-tool.sh`
A bare SSH shell on this host has no `node` (see PRODUCTION_DEPLOYMENT_GUIDE.md "Node runtime note"), and the variables set in Setup Node.js App are not in that shell. `run-owner-tool.sh` (third file, listed in `SHA256SUMS`) finds Node.js >= 20 (`~/nodevenv/<app root>/<20>/bin/node`, then any `~/nodevenv/**/20/bin/node`, then `/opt/alt/alt-nodejs*/root/usr/bin/node`) and takes the application's environment from, in order: variables already exported in your shell, a `.env` in the application root, or the environment of the RUNNING application process of the same user. It prints only NAMES and "set/MISSING", never values; it edits nothing and never adds `--apply`. Default application root: `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` (override with `DAII_APP_ROOT`).
```
cd /home/xnexdrgr/daii.xnexustech.com/daii-owner-tools && sha256sum -c SHA256SUMS      # all three OK
bash run-owner-tool.sh where     # finds node + environment, prints names only, runs nothing
bash run-owner-tool.sh status    # Stage A (read-only)
bash run-owner-tool.sh plan      # read-only plan of the repair tool
```
Stage B (two steps, B1 then B2, see below) uses `bash run-owner-tool.sh catchup ...`. Everywhere this runbook shows `node company-migration-...js --app-root <ROOT>` you can use the launcher instead.
If `where` cannot find the environment, export it WITHOUT echoing (values from cPanel -> Setup Node.js App / PostgreSQL Databases), then run it again in the same shell:
```
read -rs -p 'DB_PASSWORD: ' DB_PASSWORD; echo; read -rs -p 'DATABASE_CREDENTIAL_ENCRYPTION_KEY: ' DATABASE_CREDENTIAL_ENCRYPTION_KEY; echo
export DB_PASSWORD DATABASE_CREDENTIAL_ENCRYPTION_KEY DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=<cPanel db user> DB_NAME=<cPanel db name> NODE_ENV=development
```
(`NODE_ENV=development` only relaxes the production secret checks for this read-only tool; use the exact production `DATABASE_CREDENTIAL_ENCRYPTION_KEY`, otherwise the Company database credentials cannot be decrypted.) The guide says the application runs under Passenger, not PM2; if it does run under PM2 the launcher still works (it matches the process by its application root).
If it still reports no Node.js: `ls -d ~/nodevenv/*/*/20 ~/nodevenv/*/*/*/20 ~/nodevenv/*/*/*/*/20 2>/dev/null` and set `DAII_NODE=<that folder>/bin/node`.

## Requirements
- Node.js 20 or newer (the application's own requirement; tested with 20.20.2). Use the same Node.js the application runs with.
- Run from a shell on the host, with the SAME environment variables as the running application (database settings, `DATABASE_CREDENTIAL_ENCRYPTION_KEY`, release/backup paths, `PG_DUMP_BIN`). The cPanel Node.js App variables must be present in that shell. Never paste secrets into the command line or send them back.
- If the application runs under PM2 (an `ecosystem.config.js` in the home folder), its environment comes from that file's `env` block, NOT from cPanel: export the same variables in your shell first (for example `pm2 env <app id>`, or `set -a; source <env file>; set +a`), and use the `cwd` of that app as `<ROOT>` after checking it holds `dist/main.js`. Never send the file with its secret values: if you share it, mask every value (send only the variable NAMES, `cwd`, `script` and `RELEASE_COMPANY_MIGRATIONS`).
- `<ROOT>` below = the application root of the ACTIVE release (the folder that contains `dist/main.js`, `package.json` and `node_modules`).

## Stage A - read-only diagnosis (no changes)
```
node company-migration-status.js --app-root <ROOT>
```
Expected on the broken state: one `PLATFORM` line with `299 recorded, 0 missing`, then one `COMPANY` line per Company database, each `INCOMPLETE (11 missing), 288 recorded` followed by the 11 names:
SeedItemDetailsTerminology1790014000000, CreateProductCategories1790015000000, AddProductMasterFields1790015100000, CreateProductBarcodes1790015200000, SeedItemMasterTerminology1790015300000, SeedBarcodeLookupTerminology1790015400000, AddCustomerProfileFields1790016000000, CreateCustomerAddressesAndContacts1790016100000, SeedProfileTerminology1790016200000, AddSupplierProfileFields1790016300000, SeedSupplierProfileTerminology1790016400000.
Last line: `{"companyDatabases":N,"complete":..,"incomplete":..,"unreadable":..,"platformComplete":true}`. Exit code 0 = everything complete, 5 = something incomplete/unreadable.
Then the plan of the repair tool (also read-only):
```
node company-migration-catchup.js --app-root <ROOT>
```
It prints `companyDatabasesWithPending`: the exact list you will confirm in Stage B.
Also check the backend log for `QueryFailedError ... does not exist` around the failing requests and the value of `RELEASE_COMPANY_MIGRATIONS`.

STOP and send the output to the team instead of continuing if: a Company is `UNREADABLE`; `platformComplete` is false or the platform has missing migrations; a Company misses migrations other than the 11 above, or has `unknownToThisBuild` entries (use `--json` to see them); a Company is not `READY`; or the log shows a different exception.

## Stage B - repair in two steps (B1 restore points, B2 migrate). Nothing is migrated in B1.
Both steps take the same identity arguments. Get the values first: `<uuid>` = the id of the 1.1.10 row (Release Center, DevTools -> Network -> response of `/api/release/releases`, the row with version 1.1.10 and status `succeeded`); `<admin>` = the e-mail of an active platform administrator; `<dbs>` = exactly the `companyDatabasesWithPending` of the plan (comma separated, no spaces), for this host: `xnexdrgr_daii_c01,xnexdrgr_daii_c02`.

### B1 - take and verify the restore points, then STOP (no migration, no Company status change)
```
bash run-owner-tool.sh catchup --restore-points-only --actor-email '<admin>' --release-id '<uuid>' --confirm-databases '<dbs>'
```
Runs the same preflight (P1-P5, P6b policy = create, P7, P8), then the engine takes one pg_dump per Company with the host's `pg_dump` and verifies it: the file is non-empty, starts with the custom-format signature `PGDMP`, `pg_restore --list` parses it, and its size and SHA-256 are recorded and re-checked. Expected: `"status": "RESTORE_POINTS_READY"`, one `restorePointDetails` entry per Company with `status: verified`, `sizeBytes`, `sha256` and the absolute `file` path; last line `STATUS: RESTORE_POINTS_READY`, exit 0. If a dump fails: `REFUSED`, exit 3, nothing changed.
**What "verified" means: a structural check of the archive, NOT a test restore.** Before B2 you can check the files yourself: `pg_restore --list <file> | wc -l` must print a large number (about 1000 for these databases), the size must be plausible, and, if cPanel lets you create a scratch database, restore one file into it (`pg_restore --no-owner --dbname=<scratch db> <file>`) and compare the table count and the `migrations` count (288) with the source. Do not restore into a live Company database.

### B2 - migrate, using exactly those restore points
```
RELEASE_COMPANY_BACKUP_POLICY=require-recent bash run-owner-tool.sh catchup --apply --actor-email '<admin>' --release-id '<uuid>' --confirm-databases '<dbs>' --i-confirm-restore-points
```
`require-recent` makes the engine refuse (exit 3, nothing changed) unless each Company has a verified backup from the last `RELEASE_COMPANY_BACKUP_MAX_AGE_HOURS` (24 h) - i.e. the ones from B1. A value you export in your shell always wins over the application's own environment. Run B2 within 24 h of B1, or repeat B1.
Preflight (printed as PASS/FAIL under `preflight`; any FAIL = nothing is changed, exit 3): P1 the root is an installed release and its version; P2 the release UUID exists, is `succeeded` and has the installed version; P3 the engine's last-known-good record names the same release (if it says "not readable", send the output to the team; do not bypass it); P4 the actor exists and is active; P5 your database list equals exactly the databases with pending migrations; P6 you acknowledged the restore points; P7 the plan has no blockers; P8 there is something to do. Then the engine migrates the Companies one after the other (READY -> MIGRATING -> READY, forward only).
Expected end: `"status": "SUCCESS"`, `result.migrated` = both Companies, `result.failed` = [], `stillPendingAfterVerify` = {}, every `companyStatusAfter` = READY, `restorePoints[].basis` = `recent`, last line `STATUS: SUCCESS`, exit 0. Application restart is not needed. Running it again prints `STATUS: NOTHING_TO_DO` (exit 0) and changes nothing.

### PostgreSQL 10.23 compatibility (what is known)
- The flags the engine passes to `pg_dump`/`pg_restore --list` (`--host --port --username --no-password --format=custom --file --dbname`) all exist in PostgreSQL 10; the host's `pg_dump` 10.23 matches the 10.23 server (a pg_dump must not be older than the server). Taking a verified backup with this same code already worked on this host for the platform database before the 1.1.10 deploy.
- The 11 migrations already ran successfully on the host's PostgreSQL 10.23 against the platform database (all 11 shown as applied). The Company databases receive the same SQL. A static scan found no construct newer than PostgreSQL 10 (no generated columns, `INCLUDE` indexes, procedures, partitioning, ...). The three `gen_random_uuid()` defaults rely on the compatibility function that the first core migration (`CreateUsers`) creates in every database, as documented in PRODUCTION_DEPLOYMENT_GUIDE.md.
- What is NOT proven: a run on a real PostgreSQL 10 server (the team's test server is PostgreSQL 18). The migration of one Company runs in a single transaction, so any failure leaves that Company exactly as it was.

## Stop conditions and exit codes
| Exit / last line | Meaning | What to do |
|---|---|---|
| 3 `REFUSED` | a check failed before any change | read the message / failing preflight line, fix the input, nothing to recover |
| 2 `STATUS: FAILED` | a migration failed or verification found pending migrations | see "Failed or partial run" |
| 4 `STATUS: PARTIAL` | finished, but some Companies were skipped (not READY) | send the output; those Companies still need attention |
| 1 `STATUS: FAILED (unexpected error)` | tool error | send the output; run Stage A to see what changed |
The run stops at the FIRST failing Company. Later Companies are reported `notAttempted` and are not touched. A failure never ends with `STATUS: SUCCESS`.

## Failed or partial run - recovery
1. Do not re-run blindly and do not edit the database by hand. Do not drop anything or reset migration history.
2. Run Stage A again. Companies migrated before the failure show COMPLETE; the failed and the not-attempted ones still show their missing migrations. The pending migrations of one Company run in a single transaction, so a failed Company is left exactly as it was (288 recorded) and returns to READY.
3. Read `result.failed[].error` (the database message, e.g. an object that already exists) and `companyStatusAfter`. A Company that shows `MIGRATING` was left closed on purpose: send the output to the team before touching it.
4. Fix the cause (usually the team will tell you what), then repeat Stage B with the databases that are STILL pending (re-copy the list from Stage A / plan). Completed Companies are never migrated again.
5. If data looks wrong, the restore points are in the Release Center backups (listed in `restorePoints` of the output). Restoring is a separate, reviewed decision; do not do it unprompted.

## After the repair - verification you perform on the hosted application
Sign in, open Products, Suppliers, Warehouse Overview and Sales (customers list); in DevTools the four calls `/api/procurement/suppliers/all`, `/api/procurement/suppliers`, `/api/products/all`, `/api/warehouse-transactions/overview` must answer 200. Check that each user still sees only their Company's data. Return to the team: the Stage A output before and after, the Stage B output (it contains no credentials), the relevant backend log lines, and the DevTools result. For the NEXT release set `RELEASE_COMPANY_MIGRATIONS=dry-run` first, then `on`.
The incident is not closed until you have verified the hosted workflows.
