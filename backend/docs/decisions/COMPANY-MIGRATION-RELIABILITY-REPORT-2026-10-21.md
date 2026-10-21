# Company Migration Reliability & Recovery - consolidated report (2026-10-21)

Directive: CTO "Company Migration Reliability & Recovery" (Part A current hosting recovery, Part B permanent Release Engine fix). Branch `fix/company-migration-gate` (worktree `.claude/worktrees/cm-gate`, from `release/1.1.11`). **Nothing was merged, pushed, built into a package, deployed, or changed on the host; `package.json` stays 1.1.11 ("1.1.12" is only the proposed name); no shared or hosted database was modified.**

## 1. Why the current problem happened (hypothesis, NOT confirmed on the host)
The hosted screens that fail ("Cash sessions", "Warehouse overview", company Test2) match the signature of the 1.1.10 incident: the release engine migrated the PLATFORM database (299 -> 320) while the Company databases stayed on the old schema, because `RELEASE_COMPANY_MIGRATIONS` is unset/`off` by default and `off` was a silent, successful platform-only deploy. The new code then queries tables/columns a Company database does not have. Reproduced on real data (a pre-1.1.11 Alpha snapshot checked against the 1.1.11 build: **14 tables and 12+ columns missing**, e.g. `cash_sessions`, `bank_statements`, `purchase_returns`, `supplier_invoices.matchStatus`; after the 12 pending migrations: zero findings). The same defect had three enablers, all removed by Part B: (1) `off` allowed success, (2) the old `dry-run` migrated the platform and swapped (so "dry-run then on" was impossible for one release), (3) nothing compared a Company database with what the new code actually queries.

## 2. Part A - current hosting recovery (status: procedure and decision sheet delivered; NOTHING executed - the team has no host access)
| Item | State |
|---|---|
| Read-only facts of the published release / platform DB / Test2 / every Company | **Not obtained.** Procedure: `backend/docs/owner-tools/OWNER-RUNBOOK-ADDENDUM-1.1.11.md` Stage 0 (log, release events, env value) and Stage A (`company-migration-status.js`, read-only, forced read-only sessions), with a decision sheet to fill in and send back |
| Missing / unknown migrations per Company, identity of database and Company | Reported by Stage A (migrations missing per tag the Company already has, `unknownToThisBuild`, `UNREADABLE`) and, in the v2 tool, SCHEMA DRIFT per Company |
| Restore points | Stage B1 (`--restore-points-only`): per-Company verified `pg_dump`, then STOP; check with `pg_restore --list` |
| Plan review before execution | The decision sheet (approval before B1/B2) - nothing is migrated without it |
| Execution | Stage B2 (`--apply`): READY -> MIGRATING -> READY, one Company at a time, stop at the first failure, verify, idempotent. **Do not re-upload 1.1.11** (the engine refuses to re-deploy a live version; the application files are not at fault) |
| Smoke after | listed in the addendum (Warehouse overview, Cash sessions, Treasury documents, supplier invoices, returns, credit notes, sales orders, a report) |
The existing reviewed tools were kept (their copies in `owner-tools/` are untouched and hash-pinned); `owner-tools/v2/` (own SHA256SUMS) adds the schema-drift report and a post-migration schema re-check, and is backwards compatible with an installed build that lacks the shared check (column check only, stated in the output). For reference, the same recovery on the local development environment was executed earlier today (daii_dev: platform + 4 Companies to 320, per-Company restore points, verified).

## 3. Part B - the architectural change
### 3.1 Release Engine (`release-execution.service.ts`, `company-fanout.service.ts`, `company-migration-gate.ts`, configuration)
| Before | After |
|---|---|
| `RELEASE_COMPANY_MIGRATIONS` unset = `off`: platform only, deploy `succeeded`, nobody told | unset = **`on`** when staged activation is on (the default path); `off` only where the legacy path makes `on` impossible, recorded in the audit as not explicit |
| `off`: no Company was even read | the Company plan **always runs, read-only**, whatever the mode |
| `off` while Companies are behind = success | `off` is **enforced**: `COMPANY_MIGRATIONS_REQUIRED_BUT_DISABLED` blocks BEFORE any database is changed |
| `dry-run` migrated the platform and swapped; the version could never be deployed again | `dry-run` is **plan only**: reports, takes no backup, migrates nothing, swaps nothing; the release returns to `backup_verified`; the same release can then be deployed for real |
| a non-READY Company was silently skipped | non-READY (SUSPENDED/DEGRADED/FAILED/MIGRATING/PROVISIONING) = STALE: **blocks by default**; `RELEASE_COMPANY_SKIPPED_POLICY=allow` records each as STALE in the evidence; DECOMMISSIONED = out of scope |
| schema was never compared | read-only **schema check** of every Company against the candidate's own entity registry, at plan time AND after migration (`RELEASE_COMPANY_SCHEMA_CHECK=enforce` default / `report`); an unrunnable check is never clean |
| a Company holding migrations the release does not ship was invisible to the engine | `COMPANY_HISTORY_UNKNOWN` blocks (warns in report mode) |
| after migrations, a failed swap looked like a generic failure | `ACTIVATION_FAILED_AFTER_MIGRATIONS` + `databasesAheadOfActiveApplication` in the audit; the release is re-runnable and completed migrations are not repeated |
| the swap was reachable on any path that survived the earlier checks | an explicit invariant: no swap unless the gate passed (pre- and, if Companies were migrated, post-migration) |
Separation required by the directive: **Preflight** (migration preflight + Company plan + gate, read-only) -> **Apply** (restore points, platform, Companies, verification, post-migration gate) -> **Activation** (swap, restart, readiness). Each has its own audit events (`company_fanout_plan`, `company_gate`, `company_backups`, `company_migration_*`, `company_fanout_verified`, `swapped`, `evidence`).
The four situations of the directive: missing migration -> pending per Company (plan, and re-derived after the step); schema drift -> schema check; incompatible/unknown history -> migration preflight, plan blockers, `COMPANY_HISTORY_UNKNOWN`; Company outside the plan -> STALE/out of scope.
### 3.2 Release Center
`GET /release/releases/:id/company-migration-report` (checked / migrated / failed / not attempted / stale, gate decisions before and after, per-Company restore point, "databases ahead" flag, one-line headline - from the release's own audit trail) and `GET /release/company-migrations` (live, read-only, against the installed build) with two panels in the page (browser-verified on an isolated preview: Company at the 315 schema -> "5 pending migration(s), 7 missing table(s)").
### 3.3 Owner tools
Status tool: SCHEMA DRIFT verdict; catch-up tool: schema re-check after migration, `SCHEMA_DRIFT` instead of `NOTHING_TO_DO` when nothing is pending but the schema differs. The child program of the schema check is embedded in the status tool and a unit test asserts it is identical to the engine's.

## 4. Tests - the directive's list, case by case
| Directive case | Where it is proven |
|---|---|
| Company late by 5 / many migrations | real engine rehearsal (late by 21): off blocked, on migrated; real-PG fan-out |
| Company late by ONE migration | `company-migration-gate.spec` ("315 vs 320 is not a success") |
| every Company complete | gate PASS for off and on; engine `off, every Company already current`; rehearsal E2 `noop` |
| Company with an unknown migration | gate spec 3b; real-PG fan-out `UNKNOWN HISTORY` |
| backup failure | engine spec (no restore point -> not even the platform is migrated); real-PG restore-point cases |
| migration fails mid-run | real-PG fan-out (stop at first failure, earlier Company kept, failing one provably unchanged, later one untouched) |
| platform succeeds, one Company fails | engine spec ("a Company fails" names migrated / failed / not attempted; no swap) |
| activation fails after migrations succeed | engine spec + **real rehearsal E1** (the local EBUSY reproduced) |
| re-run after a previous failure | real-PG `RESUMABLE` + rehearsal E2 (Company `noop`, 0 duplicate rows) |
| new / not-READY Company in the registry | gate spec (all non-READY statuses, DECOMMISSIONED, registry row without a Company); real-PG STALE/OUT_OF_SCOPE |
| schema drift with a complete list | gate spec; real-PG: dropped column and dropped table detected by name |
| "the system never reports false success" | the invariant + every blocking case asserts no `swapped`, no `succeeded`, no restart |
Results: see section 6 (final numbers).

## 5. Limits and risks (stated, not hidden)
1. **The gate protects releases performed BY an installed 1.1.12+ engine.** Installing 1.1.12 itself still runs on the old engine (default `off`): that one release must be deployed with `RELEASE_COMPANY_MIGRATIONS=on` set explicitly (it ships no new migration, so nothing is pending, but the setting removes the dependency on memory). Until then the owner tools + addendum are the safety net.
2. The schema check compares column NAMES of entity tables and the existence of tables that the Company's received migrations create (detected from `CREATE TABLE` text). It does not compare types, nullability, defaults, indexes or constraints, and a table created only through the TypeORM table API is not detected as "expected" (its columns are still checked once it exists). Zero false positives were observed on a healthy full database and on a Company lacking optional modules; a different historic database could still surface a finding - `RELEASE_COMPANY_SCHEMA_CHECK=report` exists for that and is the documented escape (recorded, never silent).
3. Behaviour changes to announce: unset now means `on` (Company databases are migrated, with restore points, during the deploy: longer deploys, per-Company maintenance window); `off` can block; `dry-run` no longer deploys. A host with `RELEASE_STAGED_ACTIVATION=false` keeps the old path with `off` (no pre-swap point) and says so.
4. Non-READY Companies now block deploys by default; a long-suspended Company therefore needs `RELEASE_COMPANY_SKIPPED_POLICY=allow` (and a catch-up before it is reactivated - an automatic catch-up on reactivation was NOT built, see open items).
5. Not built: automatic catch-up when a STALE Company is reactivated; a Release Center action that runs the catch-up (the CLI owner tools remain the way for an already-live version); schema comparison of types/constraints.
6. Hosting facts remain unverified (Part A): the actual exception, the host's `RELEASE_COMPANY_MIGRATIONS`, the state of each Company database, whether per-Company `pg_dump` works on the host.

## 6. Verification summary (final numbers are in the commit message / evidence folder)
Evidence: `backend/docs/decisions/evidence-2026-10-21-company-migration-gate/` (README with the incident repro, the five rehearsal event logs, real-PG run summary). Final regression figures: see the last section appended below.
