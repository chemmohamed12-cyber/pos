# Owner runbook - repair of Company databases after the DAII 1.1.10 upgrade (2026-10-17)

Who runs it: the owner, on the hosting server. The team has no host access and has not inspected or changed the host. Nothing here is done by the team on your behalf.
Why: after 1.1.10 the platform database is at 299 migrations, but Company databases may still be at 288 (the engine default `RELEASE_COMPANY_MIGRATIONS=off` migrates only the platform). 1.1.10 reads columns that exist only after the 11 new migrations, so Products, Suppliers, Warehouse Overview and Sales answer HTTP 500 (`column Product.itemType does not exist`, `column Supplier.email does not exist`, `column Customer.partyType does not exist`). This is a hypothesis reproduced in a simulation; Stage A tells you whether it is true on your host.

## The two tools (reviewed, tested copy)
| File | SHA-256 | Role |
|---|---|---|
| `company-migration-status.js` | `35a07d963b7e6ce8032cd16a42bc0a8fc20e9d78020f7e7bd3efbdaa91e35901` | Stage A. Strictly read-only (Company connections are forced read-only). |
| `company-migration-catchup.js` | `8b09c97d10439b6c98e9b1f5a315b8e4be3d377306305738e2d4bb7d94a8a582` | Plan mode (read-only) and Stage B (`--apply`). |

Check them before use: put both files and `SHA256SUMS` in one folder and run `sha256sum -c SHA256SUMS` (both lines must say OK). Do not run a file that does not match.
Both files only use code that is already installed with the application (the Release Engine of the ACTIVE release, TypeORM, pg). They contain no SQL that changes data (only SELECTs). The migrations themselves are run by the engine's own Company fan-out service, with its own restore points, status handling and audit records. They are not part of the 1.1.10 package and change nothing in it.

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

## Stage B - repair (only after you reviewed the plan AND have a usable restore point for every affected Company)
Prerequisites you must confirm yourself: a usable restore point for each Company database listed. With the default policy (`RELEASE_COMPANY_BACKUP_POLICY=create`) the engine takes and verifies one backup per Company before any migration and refuses to start if one fails (needs a working `PG_DUMP_BIN`). If you prefer your own backups use `RELEASE_COMPANY_BACKUP_POLICY=require-recent` (a verified backup newer than `RELEASE_COMPANY_BACKUP_MAX_AGE_HOURS`, default 24 h, must already exist).
```
node company-migration-catchup.js --app-root <ROOT> --apply \
  --actor-email <platform admin e-mail> \
  --release-id <uuid of the 1.1.10 row in the Release Center / releases table> \
  --confirm-databases <db1,db2,...exactly as printed in companyDatabasesWithPending> \
  --i-confirm-restore-points
```
What it checks before changing anything (each printed as PASS/FAIL under `preflight`; any FAIL = nothing is changed, exit 3): P1 the root is an installed release and its version; P2 the release UUID exists, is `succeeded` and has the installed version; P3 the engine's last-known-good record names the same release; P4 the actor exists and is active; P5 your database list equals exactly the databases with pending migrations; P6 you acknowledged the restore points; P7 the plan has no blockers; P8 there is something to do. Then the engine verifies a restore point per Company, and migrates the Companies one after the other (READY -> MIGRATING -> READY, forward only).
Expected end: `"status": "SUCCESS"`, `result.migrated` = the Companies, `result.failed` = [], `stillPendingAfterVerify` = {}, every `companyStatusAfter` = READY, last line `STATUS: SUCCESS`, exit 0. Application restart is not needed.
Running it again prints `STATUS: NOTHING_TO_DO` (exit 0) and changes nothing.

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
