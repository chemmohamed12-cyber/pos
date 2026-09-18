# Daii — Deployment Runbook

Two phases:
- **Phase 0 — one-time bootstrap** of the v1.0.3-hardening release onto the
  current server (which has none of the Release Center).
- **Phase 1 — steady state**: every release after that is `upload → the
  system does the rest`.

All host paths per `SERVER_BASELINE_REPORT.md`. Secrets are **operator**
actions — never in a script, a manifest, or this doc.

---

## Phase 0 — Bootstrap (manual, once)

> Goal: get the digit-anchored migration glob, the Release Center code, the
> hardened `tools/`, and the config keys onto the server so Phase 1 works.

### 0.1 Preconditions on the host

```bash
cd /home/xnexdrgr/daii.xnexustech.com/release-new/backend
NODE_BIN=/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node
NPM_BIN=/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/npm
"$NODE_BIN" -v    # expect v20.20.2
"$NPM_BIN" -v     # expect 10.8.2
which pg_dump pg_restore    # record the absolute paths
```

### 0.2 Manual backup FIRST (no Release Center yet)

Follow `BACKUP_RESTORE_RUNBOOK.md` §1 (manual). Keep the dump + a
`release-new/backend` tar + `storage/media` tar + their SHA256s. Do not
proceed without a verified `pg_restore --list` on the dump.

### 0.3 Set the new environment variables

In **cPanel → Setup Node.js App → daii.xnexustech.com → Environment
variables** (NOT `.htaccess`), add:

```
NODE_BIN                 = /home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node
NPM_BIN                  = /home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/npm
PG_DUMP_BIN              = <absolute path from 0.1>
PG_RESTORE_BIN           = <absolute path from 0.1>
RELEASE_APP_ROOT         = /home/xnexdrgr/daii.xnexustech.com/release-new/backend
FRONTEND_RUNTIME_PATH    = /home/xnexdrgr/daii.xnexustech.com/release-new/backend/public
PASSENGER_RESTART_FILE   = /home/xnexdrgr/daii.xnexustech.com/release-new/backend/tmp/restart.txt
RELEASE_STAGING_PATH     = /home/xnexdrgr/daii.xnexustech.com/_deploy/staging
RELEASE_BACKUP_STORAGE_PATH = /home/xnexdrgr/backups/daii
RELEASE_BUILD_MAX_THREADS   = 2
```
Also (security — `SERVER_BASELINE_REPORT.md` §5): move `DB_PASSWORD`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`
here, **rotate** them to distinct random 32+ char values (JWT_REFRESH and
INTEGRATION are currently identical), remove the `SetEnv` lines from
`.htaccess`. This invalidates all sessions (re-login) and requires
re-entering any integration-connector credentials.

### 0.4 Deploy the hardening delta (files only — no automation yet)

Build the delta on a dev machine / CI:
```bash
cd <workspace>/backend
bash tools/build/build-release.sh --package-type delta --base-version 1.0.3
bash tools/build/build-release.sh --verify "<out>/Daii-Release-v1.0.3-<date>.zip"
```
Upload + extract into `_deploy/staging/bootstrap/`, then on the host:
```bash
cd /home/xnexdrgr/daii.xnexustech.com/release-new/backend
cp -a src src.pre-bootstrap && cp -a dist dist.pre-bootstrap    # local rollback
rsync -a --delete _deploy/staging/bootstrap/Daii-Release-*/src/  ./src/
rsync -a --delete _deploy/staging/bootstrap/Daii-Release-*/dist/ ./dist/
rsync -a          _deploy/staging/bootstrap/Daii-Release-*/public/ ./public/
cp _deploy/staging/bootstrap/Daii-Release-*/package*.json ./
"$NPM_BIN" install                 # resolves yauzl / multer into the nodevenv
```

### 0.5 Migrations — use the COMPILED datasource

```bash
"$NODE_BIN" ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:show   # inspect
"$NODE_BIN" ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run    # == npm run migration:run:prod
```
This runs the pending Release-Center migrations (`AddReleaseBackupTables` …
`AddDataRepairRunTable`). It does **not** run
`FixGenRandomUuidRfc4122Compliance` — that already ran in the v1.0.3 deploy
(confirmed: server migration head is `1755852500000`).

> Do **not** use `npm run migration:run` (ts-node) on the host — the server
> still has `extension-dependencies.spec.ts` in the migrations folder and
> the old bare-star glob until this delta lands; the compiled path avoids
> both.

### 0.6 Restart + verify

```bash
touch tmp/restart.txt
bash tools/deploy/verify-deploy.sh https://daii.xnexustech.com
```
`verify-deploy.sh` must exit 0. It now also runs the frontend-bundle check
and the strict-RFC4122 UUID-function check, and censuses legacy
non-compliant PKs (a WARNING, not a failure).

### 0.7 Controlled UUID Data Repair

Follow `UUID_REPAIR_REPORT.md` §6 acceptance checklist, driven by
`DATA_REPAIR_RUNBOOK.md`. **v1.0.3 is not functionally complete until the
two flows pass on staging with no UUID error.**

### 0.8 Server cleanup

`CLEANUP_REPORT.md` — create `_deploy/` + `archive/`, move LEGACY trees
after the reference check.

---

## Phase 1 — Steady-state release (automated)

For every release after bootstrap:

1. **Build + verify the artifact** (dev/CI):
   `bash tools/build/build-release.sh --package-type delta --base-version <installed>` then `--verify`.
2. **Upload**: Release Center UI → Upload, or
   `POST /api/release/releases/upload` (multipart `file` + `packageType`).
   → validate + stage + register (auto).
3. **Take + link a backup**: `POST /api/release/backups` →
   `POST /api/release/releases/:id/link-backup {backupRunId}`.
   (Or let the UI's deploy flow do it.)
4. **Deploy**: `POST /api/release/releases/:id/deploy`.
   Runs: preflight → gate → snapshot → publish files → migrate → restart →
   health check → `succeeded`, **or** auto-rollback → `rolled_back`.
5. **Confirm**: `GET /api/release/releases/:id` → `succeeded`;
   `GET /api/release/releases/:id/migrations`; `verify-deploy.sh`;
   `POST_DEPLOY_VERIFICATION.md` smoke list.
6. On `rolled_back` / `failed`: read `release.errorMessage` +
   `release_migration_runs` + `audit_records` (`release.deploy.*`), fix the
   artifact, re-upload. The previous release is already restored.

No SSH, no manual `chmod`, no manual `tsc`/`vite`, no guessing paths.
