# Isolated test environment — how to run DAII tests without touching `daii_dev`

**Rule:** no Jest run — focused or full — ever targets the shared development database (`daii_dev`, port 5433). Every automated test uses the isolated PostgreSQL instance (`127.0.0.1:5544`, data directory `D:\DAII-ISOLATED-PG\data`), which is separate from the shared server.

## 1. Suites that use their own databases (most of them)
Mock-based suites need nothing. The company/isolation suites (the *real-pg* specs and `customers.company-isolation`) create and drop their own uniquely named `daii_test_<prefix>_*` databases through the two-company harness. Point them at the isolated instance:

```bash
cd backend
DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=isolated_admin DB_PASSWORD=<isolated password> \
  npx jest src/foundation/company src/foundation/plans
```

## 2. Suites that boot the whole `AppModule` against the platform database
Fourteen suites (HR, attendance, payroll, commission, closing-snapshot, GRNI/WIP reconciliation, work-order e2e, procurement GRNI) used to depend on a hand-seeded `daii_dev`. They now run on a dedicated, disposable, seeded database:

```bash
npm run build                                   # the tool uses the compiled application
node tools/testing/provision-isolated-ambient-db.js        # (re)creates daii_test_ambient on :5544
DB_HOST=127.0.0.1 DB_PORT=5544 DB_USER=isolated_admin DB_PASSWORD=<isolated password> DB_NAME=daii_test_ambient \
  npx jest --runInBand <specs…>                 # one database → run serially
```

The tool drops and recreates **only** the named `daii_test_*` database and refuses (exit 2) any protected target: port 5433, `daii_dev`, the rollback database, any `company_*` database, or any name that is not `daii_test_*`. It seeds exactly what those suites assumed:

| Fixture | Why |
|---|---|
| all migrations | schema |
| `installation` singleton (dev, unsigned DAII_STANDARD) | entitlement + company FK |
| three fixture users with their historical UUIDs (`admin@`, `debug-admin@`, `wh-admin@`), each with the `admin` role and a random credential | the specs reference them by UUID; they exist only in this disposable database, never as permanent users in `daii_dev` |
| standard IFRS-SME chart (49 accounts) + `1150` WIP and `2115` GRNI control accounts | financial specs post to control accounts |
| treasury `MAIN-CASH` mapped to GL `1101` | cash/bank reconciliation |
| one warehouse, product and supplier | specs that select a base row with `LIMIT 1` |
| the current fiscal year, created and activated through `FiscalPeriodService` (12 open periods) | posting gate (needs the year's process instances) |

Everything else (config keys, role templates, terminology) is seeded by the application's own boot seeders when a suite starts.

### Result (2026-10-05)
**13 of the 14 suites pass** (93 of 95 tests): hr-phase1, attendance-phase1, attendance-biometric-import, commission-phase1, payroll-phase1, integrated attendance→payroll→commission→GL e2e, fiscal-period-closing-workflow, closing-exception-visibility, closing-snapshot-recovery, closing-snapshot-key-rotation, grni-reconciliation, wip-reconciliation, procurement grni-posting.

**Remaining: `work-order-phase3-e2e.spec.ts` — 2 assertions** (Item 6 second half and Item 12's `wip` exception) assert a *historical* condition of the old dev database ("31 pre-existing rejected events" posted before a `wip` account existed). On a clean baseline the WIP ledger correctly reconciles (`matched`), so the assertion cannot hold. This needs the spec to create that drift itself (a controlled fixture); it is a test-ownership change for the Manufacturing session, not a product defect, and was deliberately not rewritten here.

## 3. Starting the isolated instance
It is a separate throwaway cluster, not a Windows service. If it is down, start it detached (never under a time-limited shell):

```powershell
Start-Process -FilePath 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -ArgumentList '-D','D:\DAII-ISOLATED-PG\data','-l','D:\DAII-ISOLATED-PG\server.log','-o','"-p 5544 -c listen_addresses=127.0.0.1"','-W','start' -WindowStyle Hidden
```

The password lives in `D:\DAII-ISOLATED-PG\pw.txt` (local, throwaway, bound to 127.0.0.1 only).
