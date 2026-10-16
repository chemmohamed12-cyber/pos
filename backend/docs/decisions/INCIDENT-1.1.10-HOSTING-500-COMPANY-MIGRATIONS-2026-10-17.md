# Hosting incident after the 1.1.10 upgrade - HTTP 500 on suppliers, products, warehouse overview, sales (2026-10-17)

**Status: OPEN. Root cause identified by reproduction (high confidence), NOT yet confirmed on the host. Access blocker: this environment has no access to the hosting backend logs, configuration, or databases, so nothing was read from or changed on the host.**

## 1. What the owner's evidence shows
- Hosted screenshot: Warehouse Overview "An unexpected error occurred"; Sales also failing.
- Hosted DevTools: HTTP 500 on `/api/procurement/suppliers/all`, `/api/procurement/suppliers`, `/api/products/all`, `/api/warehouse-transactions/overview` (the overview page calls `/products/all`).
- Hosted Release Center: 1.1.10 `succeeded`, 11 migrations shown applied (this is the PLATFORM database only).

## 2. Reproduction (isolated simulation, not the host)
The legacy 1.1.9 engine deploys 1.1.10 with the default `RELEASE_COMPANY_MIGRATIONS=off` (platform migrated 288 -> 299, Company database left at 288). On the new build the same four endpoints answer 500, plus `/customers` (Sales); warehouses, purchase orders and trial balance still answer 200 (`evidence-2026-10-17-incident/four-before.txt`). The application log carries the exact exceptions:
- `QueryFailedError: column Product.itemType does not exist`
- `QueryFailedError: column Supplier.email does not exist`
- `QueryFailedError: column Customer.partyType does not exist`

The hosted symptoms match this signature one-to-one. A Company database at 288 migrations lacks the 11 migrations of 1.1.10 (see audit I-1).

## 3. What must be checked on the host (read-only first)
1. **Backend log** (Passenger/stderr or the app log) around the failing requests: search for `does not exist` / `QueryFailedError`. Expected: the three column errors above, with the Company context. If the exception is anything else, STOP: the migration hypothesis is wrong and the real exception must be followed.
2. **Configuration**: value of `RELEASE_COMPANY_MIGRATIONS` in the application environment (cPanel Node.js App variables). Default when unset: `off`.
3. **Migration status of every Company database**: run the tool below in plan mode. It lists, per Company, its database, status and the exact pending migrations, and shows the platform count (expected 299). It writes nothing.

## 4. Corrective action (only if the plan shows pending migrations)
`backend/tools/maintenance/company-migration-catchup.js` runs the engine's own, approved `CompanyFanoutService` of the INSTALLED build outside a deploy (the engine refuses to re-deploy a live version). It is read-only without `--apply`.
```
# from the application root of the ACTIVE release, with the same environment the application runs with
node tools/maintenance/company-migration-catchup.js --app-root <ACTIVE root>                      # plan, read-only
node tools/maintenance/company-migration-catchup.js --app-root <ACTIVE root> --apply \
     --actor-email <platform admin e-mail> --release-id <uuid of the 1.1.10 release row>
```
`--apply`: takes (or, with `RELEASE_COMPANY_BACKUP_POLICY=require-recent`, requires) a VERIFIED restore point per Company BEFORE any migration and refuses to start otherwise; migrates READY Companies one at a time (READY -> MIGRATING -> READY), stops at the first failure and leaves later Companies untouched; verifies nothing remains pending. No drop, no reset of history, no rollback. Each migration is recorded exactly once; a second run is a no-op. The application does not need to be stopped. The tool lives in the repository only (it is not part of the 1.1.10 package); copy the single file to the host's `tools/maintenance/` (or run it from any path with `--app-root`).
Afterwards set `RELEASE_COMPANY_MIGRATIONS=dry-run` and then `on` for the NEXT release, so Company databases follow the platform automatically.

## 5. Result in the simulation (same code path)
Plan: Company "Verify Co" at 288, pending exactly the 11 migrations of 1.1.10. Apply: restore point taken and verified, `migrated: [Verify Co]`, verification empty, pending 0 (`catchup-apply.json`). The four endpoints and `/customers` then answer 200 WITHOUT restarting the application (`four-after.txt`); migration table 299 with each of the 11 exactly once, 15 new columns and 4 new tables present (`post-check-incident.txt`); a re-run reports "nothing to do".

## 6. Not verified (cannot be, without host access)
The actual exception text, the host's `RELEASE_COMPANY_MIGRATIONS` value, the migration state of each hosted Company database ("Test2" is visible in the screenshot; others unknown), the restore-point capability on the host (`pg_dump` path/permissions for per-Company backups), and the post-fix browser/API results on https://daii.xnexustech.com. Authentication, permissions and Company isolation after the fix have to be re-checked on the host by the operator (the isolation regression passed on the same code).

## 7. Host change log
None. No change was made to the host by this work.
