# Daii — Deployment Architecture

The target: an operator uploads a Release/Delta `.zip` and the system does
the rest — validate, back up, stage, build (if needed), migrate, publish,
restart, health-check — and on **any** failure, stops and rolls back to the
last known-good release. Aligned to the real server
(`SERVER_BASELINE_REPORT.md`, `CANONICAL_SERVER_STRUCTURE.md`).

## Pipeline

```
        ┌─────────────────────────┐
        │  UPLOAD  (.zip only)     │  POST /api/release/releases/upload
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   PackageValidatorService
        │  VALIDATE ARTIFACT      │   • yauzl stream, per-entry safety (no .., no symlink,
        │                         │     no backslash, no .env / node_modules, allowed prefixes)
        │                         │   • MANIFEST.json shape + bidirectional file/checksum cross-check
        │                         │   • frontend-bundle-drift check (index.html ↔ assets/*)
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   ReleaseManagerService.registerRelease
        │  VERSION CHECK          │   • delta: installed version MUST == manifest.baseVersion
        │                         │     else → validation_failed → STOP
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   DeployPreflightService.runPreflight(stagingDir)
        │  HOST PREFLIGHT         │   • $NODE_BIN/$NPM_BIN/$PG_DUMP_BIN/$PG_RESTORE_BIN absolute + executable
        │  (any critical fail →   │   • app root / frontend runtime / restart-file parent / backup path exist+writable
        │   STOP, nothing touched)│   • ≥ 500 MB free on app + backup volumes
        │                         │   • DB reachable, migration head readable
        │                         │   • staged dist/database: has data-source.js, NO *.spec.js/*.test.js
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   BackupManagerService.createBackup + snapshotBeforeDeploy
        │  BACKUP                 │   • pg_dump -Fc  → verified with `pg_restore --list`
        │                         │   • per-file filesystem snapshot of everything the release touches
        │                         │   • media archive (tar.gz of storage/media)
        │                         │   • manifests/<runId>.json  (version, migration head, artifact SHA256s)
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   ReleaseManagerService.linkVerifiedBackup + checkDeploymentGate
        │  VERIFIED-BACKUP GATE   │   • the backup just taken MUST have a `verified` DB artifact,
        │                         │     re-checked live → else STOP.  "No Verified Backup → No Deployment"
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   ReleaseExecutionService.deployFiles
        │  PUBLISH FILES          │   • copy staged src/ dist/ public/ into RELEASE_APP_ROOT
        │                         │   • frontend lands in <AppRoot>/public  (NOT frontend/dist)
        │                         │   • node_modules symlink untouched
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   runReleaseMigrations  (FRESH short-lived DataSource
        │  MIGRATE                │    scoped to the just-deployed dist/database/migrations,
        │                         │    NOT the booted app's cached glob)
        │                         │   • per-migration row in release_migration_runs
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   touch <AppRoot>/tmp/restart.txt
        │  RESTART PASSENGER      │   (a failure here warns, never rolls back a good deploy)
        └───────────┬─────────────┘
                    ▼
        ┌─────────────────────────┐   ReleaseHealthCheckService.check
        │  HEALTH CHECK           │   • DB connectivity + canary tables (_daii_bootstrap_check, users)
        │                         │   • UUID functions return STRICT RFC4122
        │                         │   • frontend.bundle: index.html's assets/* all exist on disk
        │                         │   • WARN (non-blocking): legacy non-RFC4122 PKs still present
        └───────────┬─────────────┘
              pass  │  fail
        ┌───────────┴───────────┐
        ▼                       ▼
  ┌───────────┐        ┌──────────────────────────────────────────────┐
  │ SUCCEEDED │        │ ROLLBACK  (ReleaseExecutionService.rollbackRelease) │
  │           │        │  1. undo migrations (newest-first; files still on disk for down()) │
  │           │        │  2. restore files from the pre-deploy snapshot                     │
  │           │        │  3. if migration-undo fails → full DB restore from the SAME        │
  │           │        │     verified backup this release was gated on                      │
  │           │        │  4. touch tmp/restart.txt                                          │
  │           │        │  → status "rolled_back"  (or "failed" if even the fallback failed) │
  └───────────┘        └──────────────────────────────────────────────┘
        │                       │
        ▼                       ▼
   Release Evidence report (Release row + release_migration_runs + audit_records + backup manifest)
```

## Where it runs

- **In the app** (`src/foundation/release/`) — deployed via the first
  Release-Center delta. Endpoints under `/api/release/*`, guarded by
  `admin` role + the Permission Engine (`system.release.*`).
- **Build**, when a delta ships source that needs compiling on the host,
  is done by `tools/build/build-release.sh` in a **separate build
  workspace** (`_deploy/build/<release-id>/`), never in the runtime tree —
  using `$NODE_BIN`/`$NPM_BIN` and `npm ci --include=dev`, with
  `RAYON_NUM_THREADS=$RELEASE_BUILD_MAX_THREADS`. The **recommended** path
  is to build the artifact in CI / on a dev machine and upload a
  `dist/`-complete package so the host never builds.

## Invariant: FRONTEND_RUNTIME_PATH must equal what `main.ts` serves

`main.ts` calls `app.useStaticAssets(join(process.cwd(), 'public'))` — a
**literal** `<cwd>/public`, not `FRONTEND_RUNTIME_PATH`. The frontend-bundle
drift check (`ReleaseHealthCheckService`, `check-frontend-bundle.sh`) reads
`FRONTEND_RUNTIME_PATH`. The two agree **only when**:

- `RELEASE_APP_ROOT` == the process working directory (true under
  Passenger — `PassengerAppRoot` is the cwd), **and**
- `FRONTEND_RUNTIME_PATH` == `<RELEASE_APP_ROOT>/public` (the default, and
  what `DEPLOYMENT_RUNBOOK.md` §0.3 sets).

Keep it that way. If a deployment ever needs a custom
`FRONTEND_RUNTIME_PATH`, `main.ts`'s `useStaticAssets` path must change to
match in the same release, or the bundle check and the served page will
disagree. (FINAL_RECONCILIATION_REPORT R3.)

## Server-reality invariants baked in

| v1.0.3 failure | Where it is now prevented |
|---|---|
| `npm: command not found` / wrong node on PATH | `NODE_BIN`/`NPM_BIN` config + preflight `bin.*` checks + build script uses absolutes |
| `tsc: command not found` (prod-only node_modules) | build script `npm ci --include=dev` for frontend |
| `/usr/bin/env: node: Permission denied` | build script prepends `$NODE_DIR` to PATH only for `#!/usr/bin/env node` tools |
| Rolldown EAGAIN | `RELEASE_BUILD_MAX_THREADS` → `RAYON_NUM_THREADS` |
| backslash zip paths | `PackageValidatorService` rejects `\` entries |
| directory permission denied | `build-release.sh` sets 755/644; artifact never relies on host chmod |
| `frontend/dist` built, `backend/public` stale | frontend-bundle-drift check (validator + health check + `check-frontend-bundle.sh`) |
| `src/database/data-source.ts` loaded by ts-node → "Missing initializer" | `migration:run:prod` uses `dist/database/data-source.js`; deploy migrations use a fresh compiled DataSource |
| `extension-dependencies.spec.ts` picked up as a migration | `[0-9]*` glob everywhere + `migration-glob.spec.ts` + preflight `package.migrations_no_test_files` |
| no auto Passenger restart | deploy + rollback `touch tmp/restart.txt` |
| "it looked fine" (HTTP 200 while schema broken) | health check queries the real schema + UUID functions + frontend bundle |
| legacy non-RFC4122 UUIDs | separate Controlled Data Repair (`UUID_REPAIR_REPORT.md`); health check warns; verify-deploy censuses |
