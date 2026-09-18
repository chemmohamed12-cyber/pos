# Server Snapshot Compatibility Review — Daii v1.0.3 Deployment / Release / Backup / Restore / Rollback

**Snapshot:** `1-hosting/Daii-Server-Full-Snapshot-2026-08-31.tar/Daii-Server-Full-Snapshot-2026-08-31.tar.gz`
(135 MB gz, root `daii.xnexustech.com/`). Analysed **read-only** from a working copy
(`tar --force-local -xzf`); the original was not unpacked, modified, or rebuilt. No file in the
snapshot was deleted or cleaned.

**Purpose:** reconcile the Deployment Architecture built in Workstream A (this workspace's
`4-Daii_Final_Release_20260828/backend`) against the real server. This is a reconciliation, not a
redesign — no architecture was changed based on guesswork.

**Snapshot limitations (disclosed):** Windows `tar` could not recreate symlinks or preserve Unix
permissions/ownership, and stopped early on the `node_modules` symlink — so `node_modules` trees and
exact file modes are not verifiable from this copy. Everything below is drawn from files that DID
extract intact (`.htaccess`, `package.json`, `data-source.ts`/`.js`, `src/`, `dist/*.js`,
`public/`, `tools/`, `storage/`, `stderr.log`).

---

## 0. The single most important finding

**The deployed server runs an OLDER base than this workspace.** Specifically:

```
Server  =  (pre-Release-Center Daii base)  +  the full v1.0.3 hotfix delta (6 hotfixes, 3 migrations)
Workspace = same base  +  v1.0.3 hotfix delta  +  Release Center (Phases A/B/C + Execution)  +  this session's hardening
```

Concretely, on the server:

| | Server snapshot | This workspace |
|---|---|---|
| `src/foundation/release/` | **absent** | present (full Release Center) |
| `dist/foundation/release/` | **absent** | present |
| Highest deployed migration | `1755852500000-FixGenRandomUuidRfc4122Compliance` | `1755853200000-AddDataRepairRunTable` |
| Release Center migrations (`AddReleaseBackupTables` … `AddReleaseExecutionTables`, `AddDataRepairRunTable`) | **not deployed** | present |
| `data-source.ts` / `database.module.js` migrations glob | **bare `migrations/*{.ts,.js}`** (v1.0.2 fix NOT applied) | `[0-9]*{.ts,.js}` |
| `package.json` deps | no `yauzl`, no `multer` types → Release Center cannot run | + `yauzl` |
| `package.json` scripts | old (no `migration:run:prod`, `build:release`, `verify:frontend-bundle`) | + all three |
| `tools/` | `data-repair/` (SQL + deferred migrations), `deploy/verify-deploy.sh`, `generators/`, `validation/` | + `build/build-release.sh`, `deploy/check-frontend-bundle.sh`, `data-repair/scratch-rehearsal.*` |
| `storage/` | `media/` only | `media/` (+ `backups/`, `release-staging/`, `manifests/` created at runtime) |

**Consequence:** the `DataRepairService` + `POST /release/data-repairs…` endpoints, `BackupManagerService`,
`ReleaseExecutionService` etc. **cannot be invoked on the current server** — that code is not deployed
and its dependencies are not installed in the nodevenv. The Deployment Engine is architecturally
compatible with the server (see §2) but is **not yet present on it**. Two options, both viable:

- **A. Migration/CLI path for the immediate UUID repair** (no Release Center needed) — the server
  already has `tools/data-repair/` and the deferred `RepairNonCompliantUuids.ts`. Needs the two
  fixes in §1 first.
- **B. Deploy the Release Center once** (bootstrap: ship `foundation/release/*`, add `yauzl`+`multer`
  to the nodevenv, run its 5 migrations), then use the tracked `DataRepairService` flow for this and
  every future repair.

---

## 1. MUST FIX before running the UUID repair on the real server

| # | Issue on the server | Fix |
|---|---|---|
| 1a | Deployed `RepairNonCompliantUuids.ts` (in `tools/data-repair/deferred-migrations/`) is the **old self-contained version WITHOUT `SET CONSTRAINTS ALL IMMEDIATE`**. Its final `ALTER … NOT DEFERRABLE` loop **will fail with SQLSTATE 55006 `cannot ALTER TABLE … because it has pending trigger events`** — proven by `scratch-rehearsal.sh`. | Deploy the updated `src/database/uuid-repair.core.ts` + the thin-wrapper `RepairNonCompliantUuids.ts` from this workspace (or, if not deploying the Release Center, hand-patch the one `SET CONSTRAINTS ALL IMMEDIATE` line into the server's copy before `migration:run`). |
| 1b | Deployed `data-source.ts` **and** `dist/database/database.module.js` still use `migrations/*{.ts,.js}`, and `src/database/migrations/` on the server **contains `extension-dependencies.spec.ts`**. `npm run migration:run` (the ts-node CLI) there **still hits `TS2582 Cannot find name 'describe'`** — the v1.0.2 bug, un-deployed. | Deploy the `[0-9]*{.ts,.js}` glob (both files) **or** use `npm run migration:run:prod` (compiled `dist/database/data-source.js`, no ts-node) — added this session. The compiled dist has no spec file, so the prod path is safe even before the glob fix lands. |
| 1c | The repair needs a real pre-repair backup, and `storage/` has no `backups/`. | Take a manual `pg_dump -Fc` (or run `BackupManagerService` once the Release Center is deployed). Keep it + the mapping + the results as Release Evidence (`DATA_REPAIR_RUNBOOK.md`). |

---

## 2. Point-by-point reconciliation (the CTO's 12 items)

### 2.1 Actual paths — Backend / Frontend / backend/public / releases / staging / backups / node_modules / Node

| Path | Real server value | Architecture assumption | Verdict |
|---|---|---|---|
| Backend app root | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` (`.htaccess` `PassengerAppRoot`) | `RELEASE_APP_ROOT` default `process.cwd()`, prod value documented as this exact path | **MATCH** |
| Startup file | `dist/main.js` (`.htaccess` `PassengerStartupFile`) | `dist/main.js` | **MATCH** |
| Node binary | `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node` (v20.20.2, `.htaccess` `PassengerNodejs` + `stderr.log`) | `NODE_BIN` — prod value documented as this exact path | **MATCH** |
| `node_modules` | **symlink** → `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/lib/node_modules` | packages never ship `node_modules`; `ALLOWED_PREFIXES = src/ dist/ public/` (never `node_modules/`) | **MATCH** — but see §3 |
| Frontend runtime | `release-new/backend/public/` — real Vite build (`index.html` + `assets/index-DtuYiAhd.js` + `assets/index-j2WWxJ8K.css` + `favicon.svg` + `icons.svg`) | `FRONTEND_RUNTIME_PATH` default `<appRoot>/public`; "served from backend/public, NOT frontend/dist" | **MATCH** |
| Frontend source/build | `release-new/frontend/` present; `release-new/frontend/dist/index.html` references the **same** `index-DtuYiAhd.js` / `index-j2WWxJ8K.css` as `backend/public` | drift check compares `backend/public/index.html` vs `frontend/dist/index.html` | **MATCH** — currently **no drift** (v1.0.3 site bug already corrected by the manual copy) |
| `releases` layout | flat: `release-new/`, `release-v1.0.2-staging/`, `release-v1.0.3-staging/`, `frontend-v1.0.2-staging/` — **no `releases/<version>` + `current` symlink** | architecture keeps `release-new` as the live tree; the symlink layout is explicitly deferred (report §28) | **MATCH** (intentionally) |
| `staging` | `release-v1.0.3-staging/Daii-Hotfix-Delta-2026-08-30/` = the extracted delta package (uses `MANIFEST.sha256` + `DELTA_MANIFEST.md`) | `RELEASE_STAGING_PATH` default `./storage/release-staging` — the Release Center's own staging, separate from these hand-extracted trees | **DIFFERS** — see §2.9 |
| `backups` | **none** — `storage/media/` only. Rollback today = `public.backup.20260829-205543/`, `public.pre-v1.0.3/`, `dist.backup.20260829-190613/` (ad-hoc copied dirs) | `RELEASE_BACKUP_STORAGE_PATH` default `./storage/backups` (db/, media/, manifests/, app-snapshots/) created on first backup | **DIFFERS** — architecture formalises what is currently ad-hoc; compatible, not yet present |
| Passenger restart | `release-new/backend/tmp/restart.txt` exists (0 bytes) | `PASSENGER_RESTART_FILE` default `<appRoot>/tmp/restart.txt`; deploy + rollback touch it | **MATCH** |

### 2.2 Snapshot structure vs adopted Deployment Architecture

Compatible. The architecture's path model (`RELEASE_APP_ROOT` + `public` + `tmp/restart.txt` +
`storage/`) is exactly the server's layout. The only structural things the architecture ADDS are
`storage/backups|release-staging|manifests` (created at runtime) and — if the Release Center is
deployed — `src/foundation/release/` + `dist/foundation/release/`. Nothing in the architecture
assumes a directory the server forbids.

### 2.3 CloudLinux / LiteSpeed / Passenger / Node 20 / startup / .htaccess

- **One `.htaccess`, at the web root** (`daii.xnexustech.com/.htaccess`). None inside
  `release-new/backend/`. It carries BOTH the Passenger block and the env-var block:
  ```
  PassengerAppRoot "/home/xnexdrgr/daii.xnexustech.com/release-new/backend"
  PassengerBaseURI "/"
  PassengerNodejs   "/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node"
  PassengerAppType node
  PassengerStartupFile dist/main.js
  <IfModule Litespeed> SetEnv DB_HOST 127.0.0.1 … SetEnv PORT 3000 … SetEnv DB_PASSWORD … </IfModule>
  ```
- **Env delivery is `.htaccess` `SetEnv`, NOT a `.env` file and NOT the cPanel UI.** `DB_HOST=127.0.0.1`
  (correct — not `localhost`), `DB_NAME=xnexdrgr_daii_staging`, `DB_USER=xnexdrgr_daii_app2`,
  `PORT=3000`.
- **The deploy engine must never touch the root `.htaccess`** — it is CloudLinux-managed
  (`DO NOT REMOVE OR MODIFY`). The architecture already never writes there. New env vars this
  session added (`RELEASE_APP_ROOT`, `NODE_BIN`, …) all have working defaults, so a release that
  does not set them still boots; production sets them in the same `<IfModule Litespeed>` block.
- **`stderr.log`** shows the real deploy timeline: `MODULE_NOT_FOUND` from `lsnode.js` (a boot
  failure), then `relation "users" does not exist` on `AuthController.register` and
  `relation "stock_reservations" does not exist` on the hold-expiry scheduler — i.e. the app booted
  before its schema existed. This is exactly the gap `verify-deploy.sh` §3 / `ReleaseHealthCheckService`
  close (schema-readiness before sign-off). **Compatible and directly relevant.**
- Node 20.20.2 confirmed everywhere. The architecture targets Node 20; `engines` is `>=20`.

### 2.4 Does the Deployment Engine assume a different structure? — NO

Every path it uses is a config value whose production setting equals the server's real layout
(§2.1). It shells out only to `pg_dump`/`pg_restore`/`tar` (all standard on CloudLinux) via
`execFile` + arg arrays. It writes only under `RELEASE_APP_ROOT` (`src/ dist/ public/`) and
`RELEASE_BACKUP_STORAGE_PATH`. It touches `tmp/restart.txt`. It never writes `.htaccess`,
`node_modules`, or anything outside those roots. **No structural mismatch.**

### 2.5 Old releases and what each path is

| Path | What it is | Status |
|---|---|---|
| `daii.xnexustech.com/release-new/backend` | **the live app** (Passenger `AppRoot`) | ACTIVE |
| `daii.xnexustech.com/backend/` (top level) | an **older** deployment tree (`dist/foundation/` has no `release/`; `dist.backup.20260829-190613/` beside it) | DEAD — not served; candidate for the cleanup team |
| `release-v1.0.2-staging/Daii-v1.0.2/` | the v1.0.2 release package, **with a bundled `node_modules`** (the one whose `.bin` symlinks broke Windows extraction) | STALE staging artifact |
| `release-v1.0.3-staging/Daii-Hotfix-Delta-2026-08-30/` | the v1.0.3 delta package as extracted (`MANIFEST.sha256` + `DELTA_MANIFEST.md` convention) | the source of the current live deploy |
| `frontend-v1.0.2-staging/` | a staged v1.0.2 frontend build | STALE |
| `release-new/frontend/` | frontend **source + `dist/`** kept next to the backend; `dist/` currently equals `backend/public/` | ACTIVE (build source) |
| `release-new/backend/public.backup.20260829-205543/`, `public.pre-v1.0.3/` | ad-hoc pre-overwrite copies of the served bundle (the current "frontend rollback") | rollback artifacts |
| `release-new/backend/dist.backup…` | ad-hoc pre-overwrite copy of `dist/` | rollback artifact |

**The architecture keeps `release-new` as the single live tree** and replaces the ad-hoc
`*.backup.<timestamp>` copies with `BackupManagerService` (DB + a whole-tree `pre-deploy`
filesystem snapshot) + `ReleaseExecutionService` per-file snapshots. Compatible; the cleanup team
should not delete `public.pre-v1.0.3/` / `dist.backup…` until a formal backup replaces them.

### 2.6 node_modules & `.bin` symlinks — DO NOT ship node_modules from Windows

- Server `release-new/backend/node_modules` is a **symlink into the nodevenv**
  (`…/20/lib/node_modules`). Server `release-v1.0.2-staging/Daii-v1.0.2/backend/node_modules` is a
  **real tree with `.bin/*` symlinks** (`semver`, `js-yaml`, …) — precisely the ones that fail to
  extract on Windows ("File name too long").
- **Architecture position (already enforced, now explicit as a standard):**
  1. A release package **never** contains `node_modules` — `build-release.sh` excludes it;
     `PackageValidatorService` rejects any `node_modules/` entry; `ALLOWED_PREFIXES` is
     `src/ dist/ public/`.
  2. The deploy **never** replaces the `node_modules` symlink.
  3. Dependency changes are applied by running the **nodevenv's** `npm install` in the app dir
     (installs into the symlink target) — `MANIFEST.json.dependencyChanges` records them; the
     runbook has an explicit "install new deps in the nodevenv" step.
  4. `build-release.sh` builds on a **Linux build host / the server's own nodevenv**, never
     packaging a Windows `node_modules`.

### 2.7 `npm not found` / `tsc not found` / `node Permission denied` / Rolldown EAGAIN

All four were **build-environment** failures on the shared host, not app bugs. Root causes and the
server-reality fixes:

| Symptom | Cause | Fix (server-reality) |
|---|---|---|
| `node: Permission denied` (`/usr/bin/env node`) | the correct Node (`…/nodevenv/…/20/bin`) was not on `PATH`; a child tool's `#!/usr/bin/env node` shebang found a non-executable `node` | `build-release.sh` uses `$NODE_BIN` (absolute, = the `.htaccess` `PassengerNodejs` path) and only prepends its dir to `PATH` for shebang tools |
| `npm not found` | bare `npm` not on `PATH` | `$NPM_BIN` (absolute nodevenv npm) |
| `tsc not found` | frontend `npm ci` ran with `omit=dev` (host default), so `typescript`/`vite` were absent | `build-release.sh` runs the **frontend** `npm ci --include=dev` |
| `Rolldown panicked … Resource temporarily unavailable` (EAGAIN) | thread exhaustion on the shared host (Rayon global pool) | `RELEASE_BUILD_MAX_THREADS` (default 2) exported as `RAYON_NUM_THREADS` by `build-release.sh` |

These fixes assume the **server's own nodevenv** (or an identical Linux build host), not a
different dev environment. `NODE_BIN`/`NPM_BIN`/`RELEASE_BUILD_MAX_THREADS` are config, set from
the `.htaccess` `PassengerNodejs` path.

### 2.8 `backend/public/index.html` + `backend/public/assets/*` — is `backend/public` the real runtime frontend?

**Yes, confirmed.** `release-new/backend/public/index.html`:
```html
<title>frontend</title>
<script type="module" crossorigin src="/assets/index-DtuYiAhd.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-j2WWxJ8K.css">
```
and `public/assets/` contains exactly `index-DtuYiAhd.js` + `index-j2WWxJ8K.css`. `dist/main.js`
has the SPA fallback (`getHttpAdapter().get('*')` + `sendFile` from `public`). So the served SPA
is `backend/public`, and it is **internally consistent right now**. The architecture treats
`backend/public` as `FRONTEND_RUNTIME_PATH`, checks its `index.html`↔`assets/*` consistency in
`ReleaseHealthCheckService` and `check-frontend-bundle.sh`, and `PackageValidatorService` blocks a
package that would re-introduce drift. **Fully aligned.**

### 2.9 Existing backup/restore structure vs `BackupManager` + Release Manifest

| Aspect | Server today | Architecture |
|---|---|---|
| DB backup | manual `pg_dump` (per the report's own §8) | `PgDumpRunnerService.dump` (`-Fc`) + `pg_restore --list` verify + `BackupArtifact` row + SHA256 |
| App/file backup | `cp -r` to `*.backup.<timestamp>` / `*.pre-v1.0.3` | `pre-deploy` whole-tree tar + per-file snapshots, linked to the `Release` row |
| Manifest | `MANIFEST.sha256` (flat sha list) + `DELTA_MANIFEST.md` (prose) in the delta package | `MANIFEST.json` (`version`, `baseVersion`, `packageType`, `files:[{path,action,checksum}]`, `migrations`, …) — the shape `PackageValidatorService` validates; plus `storage/backups/manifests/<runId>.json` linking DB dump + fs snapshot + SHA256 + migration head + Node version |
| Restore | manual `pg_restore` + `cp -r` back | two-call preflight/confirm, safety-backup-before-restore, checksum re-verify |
| Rollback | swap the `*.backup` dirs back by hand | migrations-undone-first → files-restored → fallback full DB restore from the **linked** verified backup; Passenger restart touched |

**Compatible and strictly a formalisation** of what the server does ad-hoc. The one convention
change to standardise: **`MANIFEST.json` replaces `MANIFEST.sha256` + `DELTA_MANIFEST.md`** so the
artifact the CTO reviews is the artifact the engine deploys.

### 2.10 Differences that must be resolved before adopting the Deployment Engine

1. **Release Center not deployed** (`src/foundation/release/` absent; `yauzl`/`multer` not in the
   nodevenv; 5 migrations un-run). → Decide path A vs B in §0. If B: bootstrap deploy + nodevenv
   `npm install` + run the 5 migrations.
2. **Migrations glob not fixed on the server** (§1b). → Deploy the `[0-9]*` glob or use
   `migration:run:prod`.
3. **`RepairNonCompliantUuids` on the server lacks the 55006 fix** (§1a). → Deploy the updated
   `uuid-repair.core.ts` / patch the line.
4. **Packaging convention** — server uses `MANIFEST.sha256`; engine expects `MANIFEST.json`. →
   Adopt `build-release.sh` output as the standard for the next release.
5. **`.env.example` on the server is stale** (says "PORT 3500"; no `RELEASE_*` keys). → Ship this
   session's `.env.example`; document that prod env lives in the root `.htaccess` `<IfModule
   Litespeed>` block, not a `.env` file.
6. **Secret hygiene** (not built by this session; flagged): the root `.htaccess` has
   `JWT_REFRESH_SECRET` == `INTEGRATION_ENCRYPTION_KEY` (same literal
   `DaiiProdIntegration_2026_X9kP4mR7SecureKey`) and `DB_PASSWORD` in plaintext. Two distinct
   secrets must not share a value. This is an operator change (edit the `<IfModule Litespeed>`
   block), not a code change — and it means **the snapshot tar now contains production secrets on
   the Windows workstation**; treat that file as sensitive.

---

## 3. SERVER SNAPSHOT COMPATIBILITY REVIEW

**Verdict: the Deployment / Release / Backup / Restore / Rollback system is ARCHITECTURALLY
COMPATIBLE with the current server, but is NOT YET DEPLOYABLE to it without the bootstrap +
must-fix steps below. Nothing in the architecture assumes a structure the server does not have.**

| Area | Compatible with server? | Action needed before adoption |
|---|---|---|
| Application root / startup file / Node binary | ✅ Exact match | none |
| `backend/public` as frontend runtime | ✅ Exact match | none |
| Passenger restart via `tmp/restart.txt` | ✅ Exact match | none |
| `node_modules` symlink / no-ship-node_modules rule | ✅ Compatible | make it a written standard (done here) |
| Env vars via root `.htaccess` `SetEnv` | ✅ Compatible (all new keys have defaults) | set prod values in the `<IfModule Litespeed>` block |
| Build pipeline (`build-release.sh`, absolute Node/npm, `--include=dev`, `RAYON_NUM_THREADS`) | ✅ Compatible | run on the server's nodevenv / a Linux build host, never Windows |
| `MANIFEST.json` packaging | ⚠️ New convention | adopt for the next release (replaces `MANIFEST.sha256`) |
| Migrations glob / `migration:run:prod` | ❌ Server still has the bare-star glob + spec file | deploy the `[0-9]*` glob **or** use `migration:run:prod` |
| `RepairNonCompliantUuids` (55006 fix) | ❌ Server copy is the old version | deploy the updated core / patch the `SET CONSTRAINTS ALL IMMEDIATE` line |
| `DataRepairService` + `/release/data-repairs` endpoints | ❌ Release Center not deployed | path A (CLI migration) now, or path B (deploy Release Center) |
| `BackupManagerService` / `ReleaseExecutionService` / health check | ❌ Release Center not deployed | path B; until then, the manual `pg_dump` + `*.backup` dirs remain the rollback |
| `verify-deploy.sh` (strict UUID, frontend-bundle, census) | ✅ Runs standalone (bash + psql) | deploy the updated script (server has the old one) |
| `check-frontend-bundle.sh` | ✅ Runs standalone | deploy it (not on the server) |

### Standard to lock in for the future (server-reality)

1. **One live tree:** `/home/xnexdrgr/daii.xnexustech.com/release-new/backend`. `release-new/frontend/dist` is the build source; `backend/public` is the runtime — a deploy syncs `frontend/dist` → `backend/public` atomically and the health gate verifies the bundle.
2. **Node/npm are always the nodevenv absolutes** (`…/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/{node,npm}`), never bare commands. Same string as `.htaccess` `PassengerNodejs`.
3. **`node_modules` is a nodevenv symlink** — never packaged, never overwritten; new deps via nodevenv `npm install` recorded in `MANIFEST.json`.
4. **Env vars live in the root `.htaccess` `<IfModule Litespeed>` block** (CloudLinux-managed) — the deploy engine never touches `.htaccess`; every new config key ships with a safe default.
5. **Migrations always via `migration:run:prod`** (compiled `dist/database/data-source.js`), never the ts-node CLI on the server.
6. **Release artifact = a single `MANIFEST.json`-based zip** from `build-release.sh` (forward-slash paths, 755/644, no `node_modules`, no `.env`), self-verified with `--verify`.
7. **Every deploy: verified backup gate → deploy → `migration:run:prod` → health check (schema + strict RFC4122 + `frontend.bundle`) → touch `tmp/restart.txt` → `verify-deploy.sh`.** No sign-off without `verify-deploy.sh` exit 0.
8. **UUID data repair = Controlled Data Repair** (backup → audit → mapping → repair-in-one-txn (with `SET CONSTRAINTS ALL IMMEDIATE`) → integrity verify), rehearsed on a scratch DB first. Never weaken `@IsUUID()`.
9. **Rollback artifacts** (`public.pre-v1.0.3`, `dist.backup…`) are kept until a formal `BackupManagerService` snapshot replaces them.

---

## 4. Future architecture requirements — KEPT IN SCOPE

The Deployment/Release architecture must not foreclose the platform's stated direction. These stay
first-class design constraints (nothing in Workstream A conflicts with them; the Release Center
already runs under `foundation/` as a cross-cutting capability, and the Permission Engine is now in
real use):

- **Modular ERP** — Sales / Accounting / HR / Inventory (and future modules) as independently
  sellable units.
- **Packages / Modules / Entitlements** — a tenant buys a package (a set of modules) or individual
  modules; entitlements gate module availability at runtime.
- **Roles / Permissions** — the existing Permission Engine (deny-by-default, ancestor-chain
  resolution, seed-migration grants) extends to per-module permission nodes.
- **Multi-tenant access** — one deployed system serves multiple tenants with per-tenant
  entitlements, data isolation, and config; **no separate code copy per customer**.
- **Deployment implication:** a release ships the whole platform; entitlements (not the build)
  decide what each tenant sees. The Release Center's `MANIFEST.json` / migration model already
  supports this — module-scoped migrations and entitlement/tenant tables are additive, not a
  structural change to the deploy engine.

---

## 5. Workstream A status

**Not closed.** Per the CTO instruction, Workstream A is not final until this review's must-fix
items (§1, §2.10) are actioned and the two flows (Deposit Approval, Treasury Cash-In) succeed on
the real staging DB after the Controlled Data Repair with no UUID error. The code + rehearsal
(against real PostgreSQL) are done and green; the server-side steps are the operator's, guided by
`DATA_REPAIR_RUNBOOK.md`, `PRODUCTION_DEPLOYMENT_GUIDE.md`, and this document.

**Bootstrap package for path B** (assembled in the parallel hardening pass):
`1-hosting/zip file to upload/Daii/release-center-hardening-2026-08-31/Daii-ReleaseCenter-Hardening-v1.0.3-2026-08-31.zip`
— full `dist`+`src` + `package*.json` + `tools/` + all deployment docs + `MANIFEST.json`, applied
**manually** per `DEPLOYMENT_RUNBOOK.md` Phase 0 (the Release Center can't deploy itself). This
resolves §2.10 items 1–5 in one step: it carries the `[0-9]*` glob fix, the `SET CONSTRAINTS ALL
IMMEDIATE` repair fix, the updated `verify-deploy.sh`/`check-frontend-bundle.sh`, and the
`package.json` for the nodevenv `npm install` of `yauzl`/`multer` (`PackageValidatorService` now
permits `package.json`/`package-lock.json` as root files for exactly this).
