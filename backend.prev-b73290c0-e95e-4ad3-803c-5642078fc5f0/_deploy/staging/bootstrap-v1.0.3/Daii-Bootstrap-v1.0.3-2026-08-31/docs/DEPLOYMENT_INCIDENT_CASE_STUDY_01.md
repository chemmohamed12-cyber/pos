# Deployment Engineering Case Study #1 — Daii v1.0.3 hand-deployment

**Scope:** the v1.0.3 delta was deployed to `daii.xnexustech.com`
(CloudLinux / LiteSpeed Passenger, `.../release-new/backend`, Node 20.20.2 /
npm 10.8.2). Migrations ran and login worked, but the deployment surfaced a
series of operational gaps and left two flows failing. This document maps
every finding from the CTO handover report to the guardrail that now
prevents its recurrence.

**Environment note:** the fixes below were built and unit-tested with no
access to the real staging/production server (Node 26 locally). The
Controlled Data Repair was additionally **rehearsed end-to-end against a
real isolated PostgreSQL 18 cluster** (`tools/data-repair/scratch-rehearsal.sh`),
which also caught a latent bug (row 20). Production execution remains the
operator's step via the runbooks.

---

## A. The still-open functional bug

| # | Finding | Root cause | Guardrail now in place |
|---|---|---|---|
| 22–25 | `accountId` / `treasuryAccountId must be a UUID` still fails after deploy on deposit approval + treasury cash-in | **Not a code defect.** `1755840100000` defined `gen_random_uuid()` as `md5(...)::uuid` (no pgcrypto / PG10). Random version+variant nibbles → only ~7.7% RFC4122-valid. Every pre-fix `id` PK is ~92% non-compliant; the UI resubmits one through `@IsUUID()`. `1755852500000` fixed **generation**; existing rows were never repaired (`RepairNonCompliantUuids` was deferred). | End-to-end trace: `UUID_BUG_ENDTOEND_TRACE.md`. Fix for existing rows: **Controlled Data Repair** (`DataRepairService` + `DATA_REPAIR_RUNBOOK.md`), rehearsed. Regression tests: `uuid-repair.core.spec.ts` (broken vs fixed generator), `treasury.controller.spec.ts` / `deposits.controller.spec.ts` (the DTOs must keep rejecting the legacy id, accept a real one). |
| 8 | `verify-deploy.sh` UUID check only validated 8-4-4-4-12 shape | Shape-only regex passes a non-RFC4122 value | `verify-deploy.sh` §3 + `ReleaseHealthCheckService` now use the strict RFC4122 regex (`-[1-5]…-[89ab]`); a UUID-shaped-but-non-compliant result **fails**. `verify-deploy.sh` also runs a legacy-PK census (warning). |
| 38 | Release migration vs data repair conflated | — | `FixGenRandomUuidRfc4122Compliance` (generation, shipped) and `RepairNonCompliantUuids` (existing data, controlled) are documented as distinct everywhere; `ZeroBaselineCleanup` stays deferred and is never auto-run. |

## B. Build / packaging / runtime

| # | Finding | Guardrail |
|---|---|---|
| 2, 42 | Server paths / Passenger config were tribal knowledge | `RELEASE_APP_ROOT`, `FRONTEND_RUNTIME_PATH`, `PASSENGER_RESTART_FILE` are typed config with documented prod values (`configuration.schema.ts`, `.env.example`, `PRODUCTION_DEPLOYMENT_GUIDE.md`). |
| 4, 5, 16, 33, 34 | SPA served from `backend/public`, not `frontend/dist`; site kept serving the **old** bundle after a "successful" build | `PackageValidatorService` rejects a package that changes `public/index.html` without shipping every `assets/*` bundle it references. `ReleaseHealthCheckService` new `frontend.bundle` component reads the served `index.html` and fails if a referenced bundle is missing. `tools/deploy/check-frontend-bundle.sh` (wired into `verify-deploy.sh`) is the standalone check that alone would have caught v1.0.3. The build script places the frontend build under `public/`. |
| 7 | ZIP built on Windows used `\` separators → extraction broke | `PackageValidatorService.checkEntrySafety` rejects any entry containing `\` (yauzl `strictFileNames` also rejects it). `build-release.sh` builds with forward-slash-only tooling. |
| 7 | Extracted directories lost the execute bit (`drw-rw-r--`) → `Permission denied` | The Release Center creates its own staging dirs (immune). `build-release.sh` sets `755` dirs / `644` files in the package; `verify-deploy.sh` normalizes the served tree. |
| 12 | Frontend `npm ci` skipped devDependencies (`tsc: command not found`) | `build-release.sh` runs `npm ci --include=dev` for the frontend. |
| 13, 27 | Build relied on `node`/`npm` being on PATH → `/usr/bin/env: node: Permission denied` | `NODE_BIN` / `NPM_BIN` config; `build-release.sh` uses the absolute binaries and only prepends their dir to PATH for `#!/usr/bin/env node` child tools. `PG_DUMP_BIN`/`PG_RESTORE_BIN` documented as required-absolute in prod. |
| 14, 36 | Rolldown panicked (`Resource temporarily unavailable` / EAGAIN) — thread exhaustion, no diagnosis | `RELEASE_BUILD_MAX_THREADS` config → `build-release.sh` exports `RAYON_NUM_THREADS`. |
| 18, 19, 37 | Migrations tried to run from `src/*.ts`; `*.spec.ts` picked up by the glob | Already digit-anchored (`[0-9]*`) in `data-source.ts` / `database.module.ts` / `migration-datasource.ts`; now regression-guarded by `migration-glob.spec.ts`. New `npm run migration:run:prod` uses the compiled `dist/database/data-source.js`. |

## C. Backup / restore / release / rollback

| # | Finding | Guardrail |
|---|---|---|
| 9, 26 | `pg_restore` given a bad path (`ls -t` + re-joined absolute path) | The Release Center never shells `ls`; artifact paths are stored relative to a configured storage root and joined once. |
| 17 | Deploy required a manual `touch tmp/restart.txt` | `ReleaseExecutionService` touches `PASSENGER_RESTART_FILE` after a successful health check and after a rollback; audited; a failure is logged, never fails the deploy. |
| 29 | DB backup, filesystem backup, manifest and SHA256 not linked | `BackupManagerService` writes `storage/backups/manifests/<runId>.json` (version, migration head, both artifact paths + sizes + SHA256, Node version, app roots) alongside the artifacts. |
| 30, 31 | Restore must be more than "extract tar.gz"; DB rollback ≠ app rollback | Already: two-call preflight/confirm restore, safety-backup-before-restore; `ReleaseExecutionService` rollback undoes migrations first (files still on disk), then files, then falls back to a full DB restore from the **same linked** verified backup. |
| 32, 39, 40 | Need explicit pre-flight + post-deploy verification, and a Definition of Done | `checkDeploymentGate` (no verified backup → no deploy), `ReleaseHealthCheckService` (schema + strict UUID + frontend bundle), `verify-deploy.sh` (paths, perms, env, schema, UUID census, frontend bundle). Definition of Done in `RELEASE_CENTER_EXECUTION_REPORT.md`. |
| 20 | The repair's final `ALTER CONSTRAINT ... NOT DEFERRABLE` fails with `pending trigger events` (SQLSTATE 55006) | **Found by `scratch-rehearsal.sh`** — added `SET CONSTRAINTS ALL IMMEDIATE` before restoring constraints, in `uuid-repair.core.ts` and `ZeroBaselineCleanup`. |

## D. Not done (deliberate, documented)

- Running anything against real staging/production (no access).
- `RepairNonCompliantUuids` as an auto-running migration (driven by the controlled `DataRepairService` instead).
- `ZeroBaselineCleanup` execution (audit-gated, separate decision).
- `releases/<version>` + `current` symlink layout (report §28 — needs a CloudLinux/Passenger compatibility study first).
- Dependency major-version bumps (unchanged prior decision).

## E. v1.0.3 is NOT "functionally complete" until

On the real staging DB, after the Controlled Data Repair:
1. Deposit Approval succeeds — no `treasuryAccountId must be a UUID`.
2. Treasury Cash-In succeeds — no `accountId must be a UUID`.
3. Login + `/api/health*` pass.
4. `verify-deploy.sh` frontend-bundle + strict-UUID checks pass.
5. Migration state verified (`npm run migration:show:prod`).
6. The regression tests are green (`npm test`).
