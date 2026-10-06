# Area 21 — Company Context for the 16 platform-scoped controllers: closure record (2026-10-05)

**Authorization:** CTO EXECUTION AUTHORIZATION — AREA 21 (2026-10-05). **Method per controller:** implement → real-PostgreSQL two-company isolation spec → build → fix → retest. **All automated tests ran on the isolated PostgreSQL instance (`127.0.0.1:5544`) — never `daii_dev`.** No commit, no deployment, no Event Engine change (ADR-075 company-scope subscribers were *used*), no D3 migration applied, no Inventory file touched, no rollback/old company database altered.

## 1. Result

| Measure | Before | After |
|---|---|---|
| Domain controllers enforcing Company Context + Company-level authorization (`CompanyContextGuard` + `RequireModuleGuard` + `@RequireModule`) | 27 / 43 | **43 / 43** (`node tools/validation/module-enforcement-coverage.js` → *company-scoped: 43, platform-scoped: 0*; guarded by `module-enforcement-coverage.spec.ts`) |
| Controllers that enforced only the Installation Licence | 16 | **0** |

Effective entitlement of a Company = **its package ∩ the Installation Licence** (the licence is the ceiling for every Company; a Company with no package keeps the licence — backward compatible). Downgrading, suspending or reactivating a package changes *access* only: no row, role or permission is deleted by any of the code in this Area.

## 2. The 16 controllers (+ the Approval Engine they depended on)

Each row = the real-Postgres spec that proves, with two real Company databases, that data is written, read, approved and posted **only** inside the calling Company (a foreign id is a 404, nothing leaks into the other Company's tables, Test F), using the real engines (Approval, Process, Event Engine company-scope subscribers, Numbering, Audit).

| Controller | Spec (isolated PG) | Result |
|---|---|---|
| `approval.controller` (foundation, prerequisite) | `foundation/approval-engine/approval-engine.company-isolation.spec.ts` | 8/8 |
| `hr` | `domains/hr/interface/hr.company-isolation.spec.ts` | 6/6 |
| `targets` | `domains/targets/interface/targets.company-isolation.spec.ts` | 3/3 |
| `attendance` | `domains/attendance/interface/attendance.company-isolation.spec.ts` | 5/5 |
| `commission` | `domains/commission/interface/commission.company-isolation.spec.ts` | 5/5 |
| `payroll` | `domains/payroll/interface/payroll.company-isolation.spec.ts` | 5/5 |
| `procurement` rfq + supplier | `domains/procurement/interface/rfq-supplier.company-isolation.spec.ts` | 4/4 |
| `invoices` (customer-finance) | `domains/customer-finance/interface/invoices.company-isolation.spec.ts` | 4/4 |
| `returns` (legacy ReturnRequest) | `domains/returns/interface/returns.company-isolation.spec.ts` | 4/4 |
| `sales/reps` | `domains/sales/interface/sales.company-isolation.spec.ts` | 3/3 |
| `accounting/ap`, `/ar`, `/cash-bank`, `/inventory` | `domains/accounting/interface/subledger-controllers.company-isolation.spec.ts` | 5/5 |
| `accounting` fixed assets | `domains/accounting/interface/fixed-asset.company-isolation.spec.ts` | 4/4 |
| `accounting` (Chart of Accounts, currencies, dimensions, tax codes/periods, fiscal years/periods, closing exceptions, FA-01 period close) | `domains/accounting/interface/accounting.company-isolation.spec.ts` | 5/5 |

The previously-blocked set of Matrix §23/§24/§30/§38/§49 is closed: the Approval Engine is Company-scoped (per-Company catalog self-sync from code-declared request types/rules, approver permissions resolved in the Company, outbox in the Company database), the Tax Engine / TaxCode / TaxPeriod and `InvoiceService.getInvoice/reverseEntry` are manager-capable, and the foundation contracts `TaxEngineContract`, `FinanceInvoiceContract.getInvoice`, `SupplierLedgerContract`, `FinanceTreasuryContract.listTreasuryLedger` were widened with an optional `manager` (additive).

## 3. Decisions taken under the authorization (for the record)

1. **Role grants are Company-local for Company-scoped surfaces** (Matrix §38 / §2.3). `AuthorizationService.assignRole / revokeRole / getUserIdsForRole` gained an *optional* `manager`; without one they behave exactly as before (platform catalog, `/admin/*`, bootstrap admin). `sales/reps` therefore writes `sales_rep` into the Company's own `roles`/`user_roles`. This is what "Company-level authorization" means in the authorization text; it changes no existing caller.
2. **ADR-073 extension — RATIFIED by the CTO (2026-10-05) and APPLIED to the four current Company databases (§7).** A Company database holds *no `users` rows* (Model B; ADR-073 Option D), yet 14 foreign keys still reference `users(id)` (`sales_orders.salesRepUserId`, `customer_assignments`, `deposits`, `sales_rep_profiles`, return/delivery/collection tables, `org_memberships`, `scope_assignments`, …). ADR-073 §1 inspected the `core` directory only and found one *live* contradiction (`user_roles`); the others became live as soon as these controllers write through Company connections. Verified read-only on all nine existing `company_*` databases (0 users, 14 FKs each). **Change:** `applyCompanyAuthorizationSchemaAdjustment` now drops *every* FK that references `users(id)` — discovered from the catalog — in a Company database at provisioning (also used by the test harness). Integrity is unchanged in kind: the `userId` is validated against the Platform DB's `User` before any Company write (ADR-073 §7.4/§7.6). The platform database keeps all its constraints.
   **Existing Company databases** need the same one-off correction: `tools/maintenance/relax-company-user-fks.js` (dry-run by default, `--apply` to drop, refuses anything that is not `company_*`, drops constraints only). It has **not** been applied to any database yet.
3. **Chart of Accounts under isolation.** Every Company owns its chart (`accounting_gl_accounts`); the same codes are reusable per Company; `importTemplate` (IFRS-SME etc.) writes only into the caller's Company. Seeding a chart *automatically at company creation* is a provisioning policy (it was the "Option 1 baseline GL" item) and is **not** part of this change.

## 4. Test hygiene fixes found on the way
* The service-level spec harness no longer needs `users` rows in Company databases (the sales-rep spec proves it: 0 users, profile write succeeds).
* `ClosingSnapshotService.getRun/listRuns/verify` gained an optional `manager` (the controller reads snapshots of the caller's Company). Signing keys remain platform-level secrets by design.

## 5. Out of scope / remaining (honest list)
* The five pre-reset company databases still carry the 14 user FKs by design (rollback material, untouched).
* `work-order-phase3-e2e.spec.ts` — 2 assertions depend on historical `daii_dev` state (Manufacturing session's test; unchanged).
* D3 manual-receipt migrations: not applied (separate authorization). `daii_dev` is still 2 migrations behind source by design.
* `ConfigurationEngineService` (e.g. `accounting.default_tax_code`) remains installation-level configuration; Tax codes themselves are per Company.
* Company-level chart *provisioning policy* (see §3.3) and per-Company configuration scoping are separate architectural items.
* Nothing here is committed or deployed.

## 6. Regression and live acceptance (exact)

**Isolated PostgreSQL (:5544, never `daii_dev`)**
* 14 ambient-DB suites (serial, seeded `daii_test_ambient`): **14/14 suites, 92/92 tests** — `closing-exception-visibility.spec.ts` was updated to pass a `companyContext` (the retrofitted handler's contract).
* Everything else, one parallel run: 125/127 suites, 794/808 tests (+1 skipped). The 2 failing suites were re-run alone → **15/15**: `database-provisioning.service.unit.spec.ts` (its DataSource mock lacked the catalog query added by the ADR-073 extension — mock fixed) and `release-migrations-endpoint.spec.ts` (load flake). `work-order-phase3-e2e.spec.ts` excluded (historical-state assertions, unchanged).
* `company-packages.real-pg.spec.ts` extended: **business data written under a module survives a downgrade untouched and is served again on re-upgrade** (7/7). Together with the existing test (downgrade removes access immediately, never deletes roles/grants) this is the package upgrade / downgrade / reactivation safety proof.

**Live backend on :3500, rebuilt from current source (restarted from the new `dist`)**
* API sweep with a real login and per-Company tokens over every parameter-free `GET` route of the 16 controllers (49 routes): **no 5xx, no 401.**
  * *Alpha Trading Co* (full package): 46 × 200; 2 × 400 (routes that require a query parameter), 1 × 409 (`/accounting/ap/statement` — Alpha's chart of accounts is empty, so there is no `ap` control account: the chart-provisioning item, not a defect).
  * *Beta Trading Co* (package without HR / targets / attendance / commission / payroll / procurement-rfq-supplier / returns): those 29 routes answer a non-disclosing **404** — the package is now enforced for every one of the 16 controllers; before this Area they were reachable through the Installation Licence alone. Accounting and invoices (in Beta's package) answer 200.
  * A token without a selected Company: **403 on every route** (Company Context is mandatory).
* UI (Alpha): HR, Accounting hub, Chart of Accounts, Fixed Assets, AP, Accounting settings (currencies / tax codes / tax periods) and Returns render and load with only 200 responses. UI (Beta): the menu hides the excluded modules.
* Acceptance was read-only (no records were created in the development databases). The admin login used a temporary password; the original hash was restored byte-for-byte and verified.

**UI finding (not an enforcement defect, not changed):** in a Company whose package lacks a module, the Home page still shows a shortcut tile (e.g. "المرتجعات" in Beta) and the target page prints the raw "Not Found" from the 404. The navigation menu itself is correctly filtered; the Home tiles and the in-page error text are not entitlement-aware. Candidate for the next UI polish pass.

## 7. ADR-073 FK correction — maintenance evidence (2026-10-05)

**Authorization:** CTO decision "ADR-073 Extension — RATIFIED / APPLY AUTHORIZED", scope: Alpha, Beta, Gamma, Delta only; the five pre-reset company databases are not touched; no D3, no Inventory work, no Platform DB change.

| Step (mandatory condition) | Evidence |
|---|---|
| Backup + verification before `--apply` | `pg_dump -Fc` of each of the 4 databases → `C:\DAII-BACKUPS\area21-fk-relax-20261005\` (copy in `D:\DAII-BACKUPS\…`); each dump read back with `pg_restore --list` (972 / 972 / 972 / 986 TOC entries) |
| The 14 FKs per database recorded | `dry-run-BEFORE.txt` (56 constraints) and, per database, `<db>.relax-evidence.json` (name, table, exact definition) |
| One transaction per database | the tool runs BEGIN → drop → verify → COMMIT, and ROLLS BACK unless 0 FKs reference `users(id)` **and** every other constraint class is unchanged |
| Result | Alpha/Beta/Gamma: FKs 106 → 92; Delta: 109 → 95; PK / unique / check / not-null counts identical before and after; 0 not-validated constraints |
| Rollback available | each evidence file carries ready-to-run `ADD CONSTRAINT` statements (no data was changed, so they re-apply cleanly) |
| 0 FK → `users(id)` after | `verify-AFTER.txt`: Alpha, Beta, Gamma, Delta = 0; the five old databases = 14 each (untouched) |
| Real write on the formerly failing paths | in the real Alpha database, inside a transaction that is always rolled back: `sales_rep_profiles`, `customer_assignments`, `sales_orders` INSERT with a `userId` that exists nowhere → succeed (nothing persisted: verified). (A fourth probe, `user_locale_preferences`, failed on a missing NOT NULL `language` in the probe fixture — unrelated to the FK.) |
| Platform unaffected | `platform-counts-BEFORE/AFTER.json` identical (users 6, memberships 8, companies 4, roles 26 …); the Platform DB's own 15 FKs to `users` intact |
| Related isolation tests re-run | see the regression line below |

**Not changed by this step:** chart-of-accounts seeding policy, D3 manual receipts, `work-order-phase3-e2e`, the Event Engine, any production deployment.

**Regression bookkeeping (kept exactly as it happened):** the first parallel isolated run was 125/127 suites (794/808 tests); the two failing suites were then re-run on their own and passed (15/15). It is not restated as 127/127.

**Targeted isolation re-run after the FK correction (isolated :5544; company, provisioning, plans, authorization, and the sales / returns / customer-finance / hr / procurement / payroll / commission / targets / attendance / accounting domains):** 60 of 63 suites passed, 387 of 389 tests (1 skipped). The non-passing items, stated as they are:
* `closing-exception-visibility.spec.ts` — my run omitted `DB_NAME=daii_test_ambient` (it targets the disposable seeded database); re-run with it → **1/1 pass**. It never touched `daii_dev`.
* `procurement/interface/rfq-award-visibility.company-isolation.spec.ts` — an **untracked spec from another session** that expects an `awardApproval` field on `RfqService.getById` which does not exist yet (compile error in that spec only). Not part of this work and not modified; it belongs to whoever is implementing that field.
* The remaining counted failure is the same visibility spec's first attempt (above).
Role grants (company-local), Company membership and provisioning suites are among the passing ones; the Platform DB counts were identical before and after.
