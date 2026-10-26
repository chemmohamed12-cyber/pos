# Org-Structure Engine — Final Verification Gate (2026-10-26)

Branch `feature/org-structure-gate0` (not pushed / not merged / no package / no deploy / no production access). Implementation baseline `edc2d7a`; this gate adds one product fix (§3) and evidence. Prior handover: `ORG-STRUCTURE-ENGINE-HANDOVER-2026-10-22.md`. Evidence folder: `evidence-2026-10-22-org-engine/`.

## 0. Status in one table
| Gate item | Result |
|---|---|
| 1. `release-migration-registry.real-pg.spec` on 127.0.0.1:5544 | **21/21 PASS** after a test-fixture fix (§1); baseline 21/21; the as-committed branch failed 1 (a negative-control assumption, not a product defect). |
| 2. Full regression + investigation of the 2 flakes | 135 specs: 131 first pass; 3 of the 4 failures are **verified contention flakes** (9/9 clean in a quiet window); the 4th is the item-1 spec (§2). No genuine defect found. |
| 3. Browser acceptance (Excel import, restricted user, tree / archive / vehicles / warehouses / report) | **PASS**, and it found one genuine defect (Excel import had no branch selector) — fixed (§3). |
| 4. Backfill dry-run per dev company | Done, read-only, nothing applied (§5). |
| 5. Alpha root «ضى» preserved | Verified read-only (§6). |
| 6. Limitations documented | §7. |
| 7. Consolidated handover | this document + §8 commits/migrations. |

## 1. Release Engine registry spec — RUN on 5544: 21/21 PASS (after one test-fixture fix)
- **Instance:** the isolated throwaway cluster was down; started as documented (`pg_ctl.exe -D D:\DAII-ISOLATED-PG\data -l D:\DAII-ISOLATED-PG\server.log -o "-p 5544 -c listen_addresses=127.0.0.1" -W start`) → accepting connections, PostgreSQL 18.6, system_identifier 7692905965783805068, loopback only. Its other databases (`restore_*`, `*_ambient`, `company_*`, `pool_*`, `rehearsal_fresh`) were not touched.
- **Guard:** the DB guard had no entry for 5544. You approved one in chat; it was added as its own commit `0b48ab6` (loopback, `postgres` admin DB + `^daii_test_h3reg_[a-z0-9_]*$`, no role creation, everything else on that cluster stays denied). The guard additionally hard-denies any database name containing "ambient", so the run uses `DB_NAME=daii_test_h3reg_run`.
- **Exact command** (from `backend/`, after `npm run build`; `DB_PASSWORD` read from `D:\DAII-ISOLATED-PG\pw.txt`, never printed): `DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=isolated_admin DB_PASSWORD=*** DB_NAME=daii_test_h3reg_run npx jest --runInBand src/foundation/release/release-migration-registry.real-pg.spec.ts`
- **Results** (`evidence-…/9-registry-spec-5544-results.txt`):
  1. branch as committed: **20/21 — 1 FAILED**: `NEGATIVE CONTROL — the pre-fix 6-tag registry makes the same undo fail` (`Expected: 322, Received: 320`).
  2. baseline `eabd3fd` (integration tip, built in a throwaway worktree, since removed): **21/21 PASS** — so the failure was introduced by this branch's migrations.
  3. branch after the fixture fix below: **21/21 PASS** (forward selection per entitlement, N→N+1 upgrade / idempotency / narrowing, RB-1 undo from the failed slot, wiring of rollback paths, failure safety).
- **Root cause (not a product defect):** `undoReleaseMigrations` reverts the *newest* executed migration first. The negative control proves the pre-fix 6-tag registry cannot undo accounting/manufacturing migrations, which only holds while the newest executed migration is outside that registry. On the baseline that was true by coincidence (the newest was a `procurement` migration, `1790020600000`); this branch's 7 migrations are all in old-registry tags (`core`, `sales`, `inventory`, `logistics`, `finance`) and newer, so the old registry successfully undid two of them. The engine behaved correctly; the control mis-fired.
- **Fix (test only, no product code):** the control now builds its migration tree cut off at the newest N+1-only migration (`1790000200000`), so the newest executed migration is again one the old registry cannot load; the control still asserts the `No migration … found in the source code` failure and that nothing was undone. It will no longer break when a release adds migrations in old-registry tags. Committed separately.
- **What this proves for the new migrations:** they are selected by tag, applied exactly once, idempotent on re-run, and undoable through the release engine's registry (the 7 are in `core`/`sales`/`inventory`/`logistics`/`finance`).

## 2. Regression evidence and the flakes
- Full run (`tools/testing/biz-run.js --regression regression-specs-all.txt`, cluster 5546, namespace `biz_t90_`, 135 specs): `131/135`. Per-spec results preserved in `3-full-regression-results.txt`.
- Failures and classification:
  | Spec | Failure signature | Verdict |
  |---|---|---|
  | `audit/area14-company-audit` | "Test suite failed to run — QueryFailedError: **permission denied to terminate process**" (harness teardown `pg_terminate_backend` on another role's session; shared cluster in use by 3 other sessions) | contention flake — passes alone; 8 of 9 later runs pass, the single failure has the same signature; **9/9 in a quiet window** |
  | `company/memberships-mine` | same teardown signature | contention flake — 9/9 later runs pass |
  | `release/release-upload.http` | `read ECONNRESET` in the 413-over-the-cap case (in-process HTTP upload) | contention flake — passes alone; 9/9 in the quiet window; one ECONNRESET in 9 under load |
  | `release/release-migration-registry` | needs 5544 | item 1 (not a defect) |
  None of the three touches code changed by this branch (audit chain, membership listing, release-upload endpoint); no assertion failed in any of them — only the two environmental signatures above. Evidence: `6-flaky-failure-signatures-first-run.txt`, `7-flaky-reruns.txt`.
- After the full run only **frontend** files changed (§3); backend sources are byte-identical to the run.
- Quality gates: backend `tsc`/build, lint 0 errors (5 baseline warnings); frontend `tsc -b` and lint 0 errors, no warnings in touched files.

## 3. Browser acceptance — see `8-browser-acceptance-2026-10-26.md`
Everything requested passed in a real backend + Vite session (admin and a restricted branch user). **Defect found and fixed:** Warehouses Excel import sent no branch — in a Company with ≥2 branches every import would have been refused with no way to choose. Fix (frontend only): owning-branch selector beside the import button, button disabled with the reason until chosen, branch sent as `?orgUnitId=`; the server-side validation was already correct. Not covered: screenshots (pane was not displayed), cost-centre table in the browser, mobile width.

## 4. Development database migration status
`daii_dev` and Alpha / Beta / Gamma / Delta: 7 migrations applied, 0 errors (`1-daii-dev-migrations-apply.json`): core `1790021000000 OrgUnitLifecycle`, core `1790021600000 OrgMigrationLog`, logistics `1790021100000 AddVehicleOrgUnit`, logistics `1790021500000 AddShipmentBranch`, sales `1790021200000 AddSalesOrderBranch`, finance `1790021300000 AddSalesInvoiceBranch`, inventory `1790021400000 AddFulfillmentOrderBranch`. No migration was added in this gate. Production: untouched.

## 5. Backfill dry-run — all dev companies (read-only, nothing applied)
Source: `4-backfill-dryrun-all-dev-companies.json` (every connection opened with `default_transaction_read_only=on`, so a write would have failed). Backfill execution stays separate from migration execution; none was run.
| Company | Org units | Documents (total / unassigned / **derivable**) | Conflicts | Warehouses linked | Vehicles linked | Financial checksums before = after |
|---|---|---|---|---|---|---|
| Alpha | 3 branches + root «ضى» + archived `mother` | sales orders 2/2/**0**, invoices 2/2/**0**, fulfillment 2/2/**0**, shipments 2/2/**0**, purchase orders 2/2/**0** | 0 / 0 | 0 of 13 | 0 of 1 | yes (totalAmount, codAmount, totalAmountBase) |
| Beta, Delta, Gamma | none | 0 | 0 | 0 of 0 | 0 of 0 | yes |
**Unresolved mappings (left as is on purpose):** all 10 Alpha documents are *not derivable* because none of the 13 Alpha warehouses has an owning branch — a backfill would assign nothing. The next owner step is to assign Alpha's warehouses to branches (warehouse screen, validated), then re-run the dry-run; the 1 Alpha vehicle has no legacy branch text, so there is nothing to map.

## 6. Alpha organization — verified (read-only, `5-alpha-root-verification.json`)
One active root «ضى» (`2035c5b0-f1ab-4d4e-b1f5-2d70f2163f7f`, the former `Daii`, id preserved); `mother` (`06a2b8cf-…`) **archived, not deleted**; `rana` (`8efbebac-…`), `كتامه` (`3314ab1a-…`) and `طنطا` (`b4b67729-…`) active under «ضى» with their original ids; 0 orphans; single-root index present; parent FK delete rule = RESTRICT; `org_migration_log` empty (no backfill was ever run). No speculative mapping applied anywhere.

## 7. Known limitations (documented, not expanded)
- **Supplier payments:** their financial events still carry a **null** org unit — a payment can settle invoices of several branches, and no attribution rule has been approved; none was invented.
- **Collections:** not stamped; attributable only through their shipment → sales order chain (scope derivation), not a column.
- **Manufacturing orders:** not stamped; the WIP warehouse created for an order has no branch unless the owner assigns one.
- **Payroll runs:** not stamped; HR employees keep `departmentId` (an org unit); the branch is derivable via `getBranchOf`, but payroll postings carry no branch.
- **Department-only scope:** a user whose scope is only a department (not a branch) cannot create branch-stamped documents (vehicles, warehouses, …) — a stamped document would not be visible to them. Needs an owner/CTO decision (grant branch scope, or stamp at department level).
- Also: report dates are UTC calendar days; no export of the organizational report; `NOT NULL` deliberately not imposed on historical documents.

## 8. Commits and migration identifiers
`c4a66ac` Gate 0 design · `4ab02ae` stage 1 · `cf25326` stage 2 · `299d1db` stage 3 · `5192b3b` stage 4 · `7f0051e` stages 5–7 · `ecb09bc` stage 8 + report page · `edc2d7a` handover/evidence · *(this gate's commit: Warehouses import branch selector + this document + evidence 4–8)*. Base: integration `eabd3fd`. Migrations: the 7 listed in §4.

## 9. Release prerequisites (unchanged boundary: no merge / package / deploy authorized)
1. ~~Registry spec~~ done (§1) — re-run it on the release line after the merge/rebase.
2. Decide the department-only scope rule and whether supplier payments / collections / manufacturing / payroll get attribution rules (§7).
3. Owner assigns Alpha's warehouses to branches, then reviews a fresh backfill dry-run before any backfill.
4. Merge/rebase onto the release line (1.1.13 + company-migration gate), version bump, build from a `git archive` export, full regression incl. item 1, Release Engine deploy — each needing its own authorization.
