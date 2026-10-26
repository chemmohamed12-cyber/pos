# Enterprise Organizational Structure Engine — consolidated handover (2026-10-22)

Authorization: CTO "Full Gate 0 Approval + Sequential Implementation" (D-1 … D-11 approved). Baseline design: `ORG-STRUCTURE-ENGINE-GATE0-2026-10-22.md` (c4a66ac, unchanged).
**Branch:** `feature/org-structure-gate0` (worktree `.claude/worktrees/org-gate0`), cut from the integration tip `eabd3fd`. **Not pushed, not merged, nothing deployed, no production data touched.** Version unchanged (1.1.10 in `package.json`).

## 1. Architecture as built
One tree per Company database (`org_units`), extended — not replaced:
- **Legal Entity** = the Company (one DB). **Branch / Department / Team** = `org_units` types. **Warehouse** stays the `warehouses` entity (its `orgUnitId` = owning branch; the unit type `warehouse` is frozen for new use). **Cost Center** stays a financial dimension value. **Location** = warehouse sub-locations (unchanged).
- **Server-side context:** `OrgContextService` (`foundation/scope`) turns a *proposed* branch into a validated one on top of the existing `AccessScopeService` — exists in THIS Company, active, type branch, inside the caller's scope (404 outside), required once the Company has active branches (a caller reaching exactly one branch gets it; an unrestricted administrator must still choose; no silent default). Branchless Companies behave exactly as before.
- **Stamping:** documents get their reference from business relationships, never a client field — sales order ← warehouse's branch; invoice / fulfillment order / shipment ← order (or its warehouse); PO ← ordering warehouse (existing `purchase_orders.orgUnitId`); receipts / supplier invoices / credit notes / returns / AR invoices publish that branch on their financial events (previously `null`). A stamp is never rewritten later.
- **Legacy `NULL`** keeps meaning "visible / unassigned" (D-5) and is reported as an explicit Unassigned bucket.

## 2. Stages (commits)
| Stage | Commit | Content |
|---|---|---|
| 1 | 4ab02ae | tree integrity (single active root, parent/child matrix, no cycles, no duplicate siblings, `warehouse` frozen), edit (rename/move), archive/reactivate with impact summary + confirmation, referenced master records block archive, parent FK `CASCADE`→`RESTRICT`, root reconciliation (dry-run, ids preserved, nothing deleted); Organization screen |
| 2 | cf25326 | `vehicles.orgUnitId`, branch selector, custody sub-location + custody treasury account inherit, legacy text kept / never auto-mapped (mapping report) |
| 3 | 299d1db | resolver verified on the real scope model; vehicle lists and by-id routes branch-scoped |
| 4 | 5192b3b | warehouses (screen + Excel import) require a validated branch once branches exist; read-only org audit |
| 5–7 | 7f0051e | `branchOrgUnitId` on sales orders / invoices / fulfillment orders / shipments; procurement + AR financial events carry the branch; department→branch helper; organizational report |
| 8 | ecb09bc (+ UI fixes after) | legacy inventory, dry-run / confirmed backfill of derivable references, `org_migration_log`, owner-confirmed vehicle mapping apply; report screen |

**Migrations (all additive, rerun-safe, `down` provided except the deliberately kept RESTRICT FK):** core `1790021000000-OrgUnitLifecycle`, `1790021600000-OrgMigrationLog`; logistics `1790021100000-AddVehicleOrgUnit`, `1790021500000-AddShipmentBranch`; sales `1790021200000-AddSalesOrderBranch`; finance `1790021300000-AddSalesInvoiceBranch`; inventory `1790021400000-AddFulfillmentOrderBranch`.
Single-root unique index `IDX_org_units_single_root` is created by the migration only where the data already satisfies it (else by the reconciliation).

New API: `PATCH organization/units/:id`, `GET …/impact`, `POST …/archive` (confirm), `POST …/activate`, `POST organization/reconcile-root`, `GET organization/legacy/inventory`, `POST organization/legacy/backfill` (dry-run / confirm), `GET …/runs/:id`, `GET shipments/vehicles-branch-mapping-report`, `POST shipments/vehicles-branch-mapping-apply`, `GET inventory/warehouses-org-audit`, `GET reports/organization/overview`. Permissions reused: `core.company.organization.manage`, `logistics.vehicle.edit`, `inventory.warehouse.edit`, `accounting.report.view`.

## 3. Tests
- New real-PostgreSQL specs (all PASS; added to `regression-specs-all.txt`): `organization-integrity` (9), `org-context` (7), `vehicle-branch` (10), `warehouse-branch` (7), `branch-stamping` (5), `procurement-branch` (4), `org-report` (8), `org-legacy` (5). Existing specs adjusted: only the isolation spec that created a `warehouse`-type unit now creates a branch.
- **Full regression on cluster 5546: 135 specs — 131 passed in the first run; the 4 failures were investigated:** `area14-company-audit` and `memberships-mine` passed alone (contention with other sessions' runs); `release-upload.http` passed alone; `release-migration-registry.real-pg.spec` **cannot run here** — it refuses anything but the isolated instance 127.0.0.1:5544, which is down (environmental; not exercised for the new migrations — see §7). Evidence: `evidence-2026-10-22-org-engine/3-full-regression-results.txt`.
- Backend `tsc`/build PASS, backend lint 0 errors (5 warnings = baseline), frontend `tsc -b` PASS, frontend lint 0 errors, none of the touched pages has a warning.
- **Browser acceptance** (isolated env: `daii_test_biz_t95_org_*` on 5546, real backend `dist/main.js` :3621 + Vite :5621, Arabic UI): tree shows after reconciling two test roots into one; rename + move-list limited to legal parents; archive impact dialog (3 active sub-units block, message localized); vehicles screen shows legacy text + "unassigned — choose branch" and a branch selector on add; API: vehicle without branch → 400 "Select the branch", with branch → 201 and custody warehouse + account inherit; legacy mapping `V-OLD` (طنطا) proposed→applied, `V-OLD2` unmatched→skipped; department as warehouse owner → 400; a **real** sales order created through the API got `branchOrgUnitId` = the warehouse's branch; organizational report renders (branch rows, company-level, Unassigned, totals reconcile, 0 vs "—"). Not browser-tested: the Excel import branch parameter, the cost-centre table in the browser, restricted-user views (covered by specs).

## 4. Data reconciliation (D-9 / D-10) — dev only
- Read-only inventory before: Alpha had 2 roots (`mother` with `rana`, `Daii` with `كتامه`, `طنطا`), 13 warehouses unlinked, 1 vehicle without branch; other companies no org data.
- Migrations applied to `daii_dev` + Alpha/Beta/Gamma/Delta with the release-engine primitives (`evidence …/1-daii-dev-migrations-apply.json`: 7 migrations each, 0 errors).
- Alpha reconciled with the engine's own service (dry-run first, then apply; `evidence …/2-alpha-root-reconciliation.json`): canonical root **`Daii` renamed «ضى»** (id preserved), `rana` re-parented under it, `mother` **archived, not deleted**; single-root index now present. Re-running changes nothing.
- Exceptions: the 13 Alpha warehouses and the 1 vehicle remain **unassigned by design** (no relationship names their branch) — use the warehouse screen / the vehicle mapping report; nothing was defaulted.

## 5. Security / isolation evidence
Company B never sees or is touched by Company A (asserted in each spec); a branch id of another Company is unknown (404); a branch outside the caller's scope is 404 for create, edit, list and by-id routes; the unrestricted administrator is still validated (type/active/exists) and must choose; `PermissionGuard` unchanged (404 on denial); no parallel authorization added.

## 6. Remaining limitations / decisions left
1. A user scoped only to a **department** cannot create branch-stamped documents until granted the branch scope (stamped documents would otherwise be invisible to them).
2. **Not stamped:** supplier payments (null branch on their events), collections (inherit via shipment in scope derivation only), manufacturing work orders, payroll runs; HR employees keep `departmentId` (branch derivable via `getBranchOf`).
3. Legacy documents are attributed only through the backfill (owner-confirmed, dry-run first); `NOT NULL` is deliberately not imposed (D-7). Whether to run the backfill on the dev companies is an owner call; it was not run there.
4. `release-migration-registry.real-pg.spec` was not run (needs the isolated 5544 instance) — run it before a release.
5. Report dates are UTC calendar days; org report gives branch/unit/cost-centre/period views, not yet export.
6. `branchOrgUnitId` on collections / returns / deliveries was not added (Stage 5 limited to the chain above).

## 7. Release package and deployment procedure (later, separately authorized)
**No package was built:** this branch is cut from the integration line, not from the release line (1.1.13 with the company-migration gate), so a zip from it would not be a valid release. When authorized:
1. Merge/rebase `feature/org-structure-gate0` onto the release line; resolve the `regression-specs-all.txt` and `launch` overlaps; bump version.
2. Build from a `git archive` export (never `npm ci` inside a junction worktree), run `release-migration-registry.real-pg.spec` on the isolated 5544 instance and the full regression.
3. Deploy through the Release Engine; the 7 migrations are additive and fan out to every Company by tag. After deploy, in each Company: run `POST organization/reconcile-root` (dry-run → apply) only if duplicate roots exist, then review `GET organization/legacy/inventory`, run the backfill dry-run, and confirm.
4. Production inventory/migration needs its own authorization (D-10).

Local environment left running: org-backend :3621 / org-frontend :5621 on the disposable DBs `daii_test_biz_t95_org_*` (5546) — stop/drop when no longer needed.
