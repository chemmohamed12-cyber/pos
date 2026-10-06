# Multi-Company UI Acceptance — verification guide (2026-10-05)

Dev environment only (`localhost`). The accounts below are disposable test accounts on the freshly reset `daii_dev`; the shared password is a dev-only test value and must never be reused anywhere else.

## Where
- UI: **http://localhost:5173** (Vite dev server, proxies to the backend)
- Backend: http://localhost:3500 (`/api/health`)
- Database: `daii_dev` on the dev server (:5433). Rollback database `daii_dev_rollback_20261004_2358` and the five old `company_*` databases are untouched.

## Accounts
| Account | Role | Password |
|---|---|---|
| `admin@daii.example` | Platform admin (principal) | **your own password** (the original credential is restored; verified byte-identical to the verified reference) |
| `alpha.admin@acceptance.test` | admin of Alpha Trading Co only | `Acc-Pass-7731!qz` |
| `beta.admin@acceptance.test` | admin of Beta Trading Co only | `Acc-Pass-7731!qz` |
| `gamma.admin@acceptance.test` | admin of Gamma Trading Co only (company created last, with the fixed create flow) | `Acc-Pass-7731!qz` |
| `shared.user@acceptance.test` | `sales_manager` in Alpha **and** `finance` in Beta | `Acc-Pass-7731!qz` |

## Steps (about 10 minutes)
1. **Admin login.** Open `/login`, sign in as `admin@daii.example`. The home page greets the platform admin. The sidebar entry "سجل الشركات" (Company registry) opens `/control-plane`.
2. **Two (three) companies.** `/control-plane` lists Alpha, Beta and Gamma, all Ready. Open one: its page shows status, database status and a **Company members** panel (list / add / remove).
3. **Role assignment.** In Alpha's members panel you see Alpha Admin (`admin`) and Shared User (`sales_manager`); in Beta's, Beta Admin (`admin`) and Shared User (`finance`). Add or remove a member to try the panel (adding requires an existing user; create users in `/admin`).
4. **Company switching.** Log out, sign in as `shared.user@acceptance.test`. The header shows a company selector with *Alpha Trading Co* and *Beta Trading Co*. Pick Alpha → open **Customers** (`/customers`): only *Alpha Customer 1*. Switch to Beta → only *Beta Customer 1* (the page reloads on switch).
5. **Single-company users.** Sign in as `alpha.admin@…`, `beta.admin@…` or `gamma.admin@…`: you land inside your own company with no selection step (the header shows its name), and a browser reload keeps you in it. Alpha shows only its customer, Beta only its own, Gamma none.
6. **Isolation.** Each customer is `CUST-000001` in its own company database — numbering and data are separate. A user cannot select a company they are not a member of (HTTP 401), and a record id from another company returns a plain **404 "Not Found"** with no data or internal text.

## Super Admin: plans / packages (added 2026-10-05)
Sign in as `admin@daii.example` (your own password).
1. **Plans.** Company registry → **Plans** button (`/control-plane/plans`). Two plans exist: **Commerce Core** (accounting, finance, inventory, sales) and **Full Suite** (all 13 modules). Try *Create plan*: tick **Sales** only — Inventory, Finance and Accounting tick themselves, because the module graph is cyclic and a module cannot exist without what it depends on. Modules the installation licence does not include are greyed out and rejected by the server.
2. **Assign a package.** Open a company (`/control-plane/companies/<id>`): the **Company package** panel shows the current package and the *effective modules* (package ∩ installation licence). Alpha = Commerce Core, Beta = Full Suite, Gamma = none (inherits the full licence, as every company did before this feature).
3. **Create a company with a package.** `/control-plane/companies/new` now has a **Package** selector. **Delta Trading Co** was created with Commerce Core; its initial admin is `shared.user@acceptance.test`.
4. **See it enforced.** Sign in as `shared.user@acceptance.test` (member of Alpha, Beta and Delta). Switch to **Delta** → the sidebar has Sales, Warehouses, Fulfilment, Customers, Treasury, Catalog, Accounting, Administration only. Switch to **Beta** → Shipping and Reports appear (and, because this user is `finance` there, the role-gated entries follow that role). Routes for modules outside the package (e.g. `/shipments`, `/procurement/purchase-orders`) return 404 for the company; the same routes return 200 for Beta.
5. **Changes apply immediately.** Edit **Commerce Core**, add *logistics*, save → Alpha and Delta gain Shipping at once; remove it again and it disappears.

Accounts: Delta is the fourth company; `shared.user@acceptance.test` is a member of Alpha (`sales_manager`), Beta (`finance`) and Delta (`admin`).

## Verified automatically
- Cross-company lookup by id → 404 (was 500); same-company reads → 200.
- Focused unit/integration suites against an **isolated** PostgreSQL instance (:5544): 25 suites / 165 tests green — authentication, company provisioning, membership & role assignment, company selection, cross-company authorization, customers company isolation, error contract.

## Phase results (2026-10-05, master directive)

**A — Multi-Company foundation**
- Not-found / inaccessible record → generic 404 (was 500) — verified through the API and a unit spec.
- A package change reports its impact: assigning or editing a plan returns `addedModules` / `removedModules`, and the UI shows it ("applied immediately to N company(ies) — lost: logistics (data and roles are kept, access is blocked)"). A downgrade blocks access at once; it never deletes roles, grants or data.
- **Real-PostgreSQL proof** (`foundation/plans/company-packages.real-pg.spec.ts`, two real company DBs + control plane on the isolated instance): plan creation with stored closure, assignment prepares the company's *own* database (module role templates + admin grants), enforcement follows the validated company, downgrade keeps roles/grants, plan edits apply to every company on the plan, archived/unknown plan and company are refused, and **company A's package never leaks to company B**.

**B — Plans & entitlements: enforcement coverage** (`docs/acceptance/MODULE_ENFORCEMENT_COVERAGE.md`, generated from the sources by `tools/validation/module-enforcement-coverage.js`)
- Of 43 domain controllers, **27 are company-scoped** (package enforced per company) and **16 are platform-scoped** (only the installation licence is enforced there).
- The audit found **three company-scoped controllers with no `@RequireModule` at all** (sales-orders, customer-ledger, fulfillment) — a package could never have restricted them, whatever the menu showed. They are now guarded (`sales`, `finance`, `inventory`), and a regression spec (`module-enforcement-coverage.spec.ts`) fails if a company-scoped controller ever lacks the guard again.
- 404 or a hidden menu is **not** treated as protection by itself: for every module the real guard (`RequireModuleGuard` + the per-company resolver) is what enforces, and the coverage file states exactly which modules are only **partially** or **not** enforced per company.

**Modules NOT enforced per company yet (commercial-activation blockers — Area 21 dependency, not built here by directive):** `hr`, `attendance`, `payroll`, `commission`, `targets` (no company-scoped controller at all); partial: `accounting` (6 of 9 controllers platform-scoped, incl. the chart of accounts), `procurement` (2), `finance` (invoices), `logistics` (1), `sales` (1). Until those controllers are retrofitted, a package cannot restrict them per company, and the company-level chart of accounts has no UI/API path.

**C — Operational build:** the remaining operational work is Area 21 retrofits and Event Engine company context, which this directive excludes, so no new operational module was built on an unverified base. What *was* completed is the test foundation: 13 of 14 fixture-dependent operational suites now run green on an isolated seeded database (`docs/acceptance/ISOLATED_TEST_ENVIRONMENT.md`).

**D — UI integration:** Plans page, package panel, package choice at company creation and the change-impact messages were driven through the real UI (create/edit/assign/downgrade, company switching, per-company sidebar); API-level proofs above back them.

## Known limits (not hidden)
- **Chart of accounts is not company-scoped.** `AccountingController` (chart of accounts, templates) is still platform-scoped (Area 21, a separate architectural dependency), so a company has no UI/API path to create GL accounts yet. The platform baseline chart was not restored because it is not part of this acceptance scope.
- `daii_dev` is two migrations behind the current source (`AddManualReceiptCostAndReasonCode1789860000000`, `SeedManualReceiptTerminology1789870000000` — the D3 manual-receipt work of another session). New company databases receive them at provisioning; the platform database does not until that work is approved.
- Another Claude session runs jest regressions that write test rows into `daii_dev`; the dev data was cleaned transactionally (rollback dump kept) and must be re-cleaned if that session runs ambient suites again.

---
## Addendum (Area 21 closure, 2026-10-05)
Package enforcement now covers all 43 domain controllers (the 16 that enforced only the Installation Licence were retrofitted). Re-accepted on the rebuilt backend: Alpha (full package) serves HR / Accounting / Chart of Accounts / Fixed Assets / AP / settings / Returns with 200s; Beta (restricted package) gets a non-disclosing 404 on the 29 excluded-module routes and a menu without them; a token with no selected Company gets 403 everywhere. Details and the one UI polish finding: `AREA21_CLOSURE_2026-10-05.md` §6.
