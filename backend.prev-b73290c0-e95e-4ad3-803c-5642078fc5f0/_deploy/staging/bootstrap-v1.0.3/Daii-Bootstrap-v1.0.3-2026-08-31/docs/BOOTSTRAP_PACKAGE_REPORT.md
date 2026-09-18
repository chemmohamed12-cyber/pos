# Daii — v1.0.3 Server Bootstrap Deployment Package Report

**Package:** `Daii-Bootstrap-v1.0.3-2026-08-31.zip`
**SHA-256:** see the sidecar `Daii-Bootstrap-v1.0.3-2026-08-31.zip.sha256` (this report is also delivered standalone with the digest filled in)
**Location:** `1-hosting/zip file to upload/Daii/bootstrap-v1.0.3-2026-08-31/`
**Size:** ~1.8 MB · 1494 files · `packageType: "delta"` · `baseVersion: "1.0.3"`

**Purpose:** the one-time Phase-0 bootstrap that moves the current server from
its baseline (v1.0.3 hotfix delta on a *pre-Release-Center* base) to the
**Verified v1.0.3 Bootstrap State** (v1.0.3 Hardening + Release Center +
migration-glob fix + prod migration commands + deploy tooling). Applied by
**manual `rsync`** per `docs/DEPLOYMENT_RUNBOOK.md` Phase 0 — the Release
Center cannot deploy itself onto a server that lacks it.

**This task was preparation only.** No deploy, no UUID repair, no server
cleanup, no full-server ZIP, no change to the server snapshot was performed.

**Baseline used:** the real server snapshot
`Daii-Server-Full-Snapshot-2026-08-31.tar.gz` →
`daii.xnexustech.com/release-new/backend/` (read-only; not modified/moved).
Every file in this package was SHA-256-compared against that tree.

---

## Delta summary (package ↔ server baseline)

| Class | Count | Meaning |
|---|---:|---|
| **ADDED** | 140 | Not on the server today — the Release Center (`src/` + `dist/foundation/release/**`), `dist/database/uuid-repair.core.*`, the 5 Release-Center migrations, `tools/build/build-release.sh`, `tools/deploy/check-frontend-bundle.sh`, `tools/data-repair/scratch-rehearsal.*`. |
| **MODIFIED** | 29 | Changed vs the server — `data-source.ts`/`.js` + `database.module.ts`/`.js` (`[0-9]*` glob), `app.module.ts`/`.js` (wires `ReleaseModule`), `deposits`/`treasury` controllers (export the DTO), `app-config.service` + `configuration.schema` (new config keys), the 2 deferred data-repair migrations (55006 fix + wrapper), `tools/deploy/verify-deploy.sh` (strict RFC4122 + census + bundle check), `package.json` + `package-lock.json` (yauzl + scripts). |
| **UNCHANGED** | 1293 | Byte-identical to the server — shipped so `rsync -a --delete` produces a deterministic known state, not because they changed. |
| **REMOVED** | 45 | On the server, deliberately NOT in the package (→ deleted by `rsync --delete`): 44 `*.spec.ts` test files (never executed in prod; **`src/database/migrations/extension-dependencies.spec.ts` removal also closes the ts-node `migration:run` TS2582 risk**) + `dist/tsconfig.build.tsbuildinfo` (build cache). |

Full per-file lists: `docs/` is not the place — they are attached below in
sections C / D and shipped in the package as
`BOOTSTRAP_WORK/{ADDED,MODIFIED,REMOVED,UNCHANGED}.txt` in the workspace
(not in the ZIP; the ZIP carries `MANIFEST.json` + `MANIFEST.sha256`).

---

## Package layout

```
Daii-Bootstrap-v1.0.3-2026-08-31/
├── BOOTSTRAP_README.md          # operator quick-start → points at docs/DEPLOYMENT_RUNBOOK.md
├── BOOTSTRAP_PACKAGE_REPORT.md  # this file
├── MANIFEST.json                # runtime delta manifest (src/ dist/ package*.json) — RELEASE_MANIFEST_SPEC.md format
├── MANIFEST.sha256              # SHA-256 of EVERY file in the package (1493 entries)
├── package.json                 # + yauzl dep, + migration:run:prod / migration:show:prod / build:release / verify:frontend-bundle
├── package-lock.json            # deterministic install of yauzl (3.4.0) + its deps (pend, buffer-crc32)
├── src/                         # 364 files — FULL backend source, spec files stripped (traceability only; not executed)
├── dist/                        # 1083 files — FULL compiled app (the runtime), spec-compiled artifacts + tsbuildinfo stripped
├── tools/                       # 13 files — build / deploy / data-repair / validation scripts  (see §A classification)
└── docs/                        # 18 reference docs + rehearsal-evidence/  (NOT deployed — operator reference)
```

`rsync` targets on the host (`docs/DEPLOYMENT_RUNBOOK.md` Phase 0.9):
`src/ → <AppRoot>/src/`, `dist/ → <AppRoot>/dist/` (both `--delete`),
`tools/ → <AppRoot>/tools/` (`-a`, no `--delete` — keeps any host-only tool),
`package.json` + `package-lock.json` → `<AppRoot>/`. `docs/` stays on the
operator's machine.

---

## A. FILES THAT WILL BE DEPLOYED — and their classification

| Group | Files | Class | Deployed to | Kind |
|---|---|---|---|---|
| **Release Center source** | `src/foundation/release/**` (34), `src/database/uuid-repair.core.ts` | ADDED | `<AppRoot>/src/` | Future Release Center (traceability; the runtime is the `dist/` twin) |
| **Release Center runtime** | `dist/foundation/release/**` (102), `dist/database/uuid-repair.core.{js,d.ts,js.map}` | ADDED | `<AppRoot>/dist/` | **Runtime** — Backup / Restore / Release Execution / Deploy Preflight / Health Check / Package Validation / Controlled Data Repair |
| **Release Center migrations** | `src/database/migrations/17558528–17558532*.ts` (5) + `dist/**` twins (15) | ADDED | `<AppRoot>/src|dist/database/migrations/` | **Runtime** — run once by `migration:run:prod` (§F) |
| **Migration glob fix** | `src/database/data-source.ts`, `src/database/database.module.ts` + `dist/**` twins | MODIFIED | `<AppRoot>/src|dist/database/` | **Runtime** — `[0-9]*{.ts,.js}` glob (closes the `*.spec.ts` pickup) |
| **App wiring** | `src/app.module.ts` + `dist/app.module.js{,.map}` | MODIFIED | `<AppRoot>/` | **Runtime** — imports `ReleaseModule` |
| **DTO export** | `src/domains/{treasury,deposit-control}/interface/*.controller.ts` + `dist/**` twins | MODIFIED | `<AppRoot>/src|dist/domains/…` | **Runtime** — `export`s `CashMoveDto` / `ApproveDepositDto` for the regression tests (no behaviour change) |
| **Config keys** | `src/foundation/configuration/{app-config.service,configuration.schema}.ts` + `dist/**` twins | MODIFIED | `<AppRoot>/src|dist/foundation/configuration/` | **Runtime** — `NODE_BIN`/`NPM_BIN`/`FRONTEND_RUNTIME_PATH`/`PASSENGER_RESTART_FILE`/`RELEASE_BUILD_MAX_THREADS` (all default-safe) |
| **package manifest** | `package.json`, `package-lock.json` | MODIFIED | `<AppRoot>/` | **Runtime** — `yauzl` dep + `migration:*:prod` / `build:release` / `verify:frontend-bundle` scripts |
| **Deploy verification** | `tools/deploy/verify-deploy.sh` (MODIFIED), `tools/deploy/check-frontend-bundle.sh` (ADDED) | — | `<AppRoot>/tools/deploy/` | **Operator-only** — post-deploy sign-off (strict RFC4122, legacy-PK census, bundle drift) |
| **Build pipeline** | `tools/build/build-release.sh` | ADDED | `<AppRoot>/tools/build/` | **Bootstrap-only / dev-CI** — future artifact builds; not run at runtime |
| **Data-repair tooling** | `tools/data-repair/deferred-migrations/*.ts` (MODIFIED — 55006 fix + wrapper), `scratch-rehearsal.{sh,ts}` (ADDED), `*.sql` (UNCHANGED) | — | `<AppRoot>/tools/data-repair/` | **Operator-only** — the Controlled Data Repair (driven per `docs/DATA_REPAIR_RUNBOOK.md`) |
| **Validation tools** | `tools/validation/{check-dist-integrity,validate-structure}.js`, `tools/generators/generate-domain.js` | UNCHANGED | `<AppRoot>/tools/` | Operator-only (already on the server) |
| **Unchanged runtime** | 1287 other `src/` + `dist/` files | UNCHANGED | `<AppRoot>/src|dist/` | **Runtime** — byte-identical; shipped only for `rsync --delete` determinism |

---

## B. FILES THAT WILL **NOT** BE DEPLOYED — and why

| Not deployed | Where it is | Why |
|---|---|---|
| `docs/**` (18 `.md` + `rehearsal-evidence/`) | in the ZIP, at package root | Reference for the operator — stays on the operator machine, never `rsync`'d to `<AppRoot>`. |
| `BOOTSTRAP_README.md`, `BOOTSTRAP_PACKAGE_REPORT.md`, `MANIFEST.json`, `MANIFEST.sha256` | package root | Package metadata — not application files. |
| `node_modules/` | — | **NOT in the package at all.** It is a **symlink** on the host → `/home/xnexdrgr/nodevenv/…/20/lib/node_modules`. Shipping it or letting `rsync` touch it would break the runtime. New deps go in via `$NPM_BIN install` (§E). |
| `.env`, `.env.*` (any), `.env.example` | — | Not in the package. Secrets / env live in the host `.htaccess` `<IfModule Litespeed>` block (or, recommended, the cPanel env UI). |
| `.htaccess` | — | Host-managed CloudLinux/Passenger config **with plaintext secrets**. The bootstrap never touches it. |
| `public/`, `frontend/dist/` | — | **Frontend is unchanged for this bootstrap.** The Release Center is operated via `/api/release/*` (see `docs/DEPLOYMENT_RUNBOOK.md`). A frontend `ReleaseCenter.tsx` UI page exists in the workspace but shipping it is a **separate frontend release**, not part of closing v1.0.3 backend hardening — and shipping an unverified bundle would (correctly) fail the frontend-bundle-drift check. |
| `storage/`, `storage/media/**` | — | Runtime user data. In the backup set, never in a release artifact. |
| `*.spec.ts` / `*.spec.js` (44) | server `src/` today | Test files — never executed in prod. Their removal (via `rsync --delete`) is a bonus cleanup; **`extension-dependencies.spec.ts` removal specifically de-risks `npm run migration:run`** (see §C). |
| `dist/tsconfig.build.tsbuildinfo` | server `dist/` today | TypeScript incremental-build cache — machine-specific, pointless in the package. |
| `dist.backup.*`, `public.backup.*`, `public.pre-v1.0.3/`, `stderr.log`, `tmp/` | server today | Host state / ad-hoc rollback copies / logs — never in a package. Kept on the host until a formal `BackupManagerService` snapshot replaces them. |
| Server snapshot `Daii-Server-Full-Snapshot-2026-08-31.tar*` | `1-hosting/` | **CONFIDENTIAL** (production secrets). Never in a package, Git, or shared storage. |
| Any symlink | — | The package contains **zero** symlinks (verified). |

---

## C. FILES IN THE SERVER SNAPSHOT THAT THIS PACKAGE REPLACES (MODIFIED) or REMOVES

**Replaced (server had a different version — 29 files):**

```
src/app.module.ts                                            (+ dist/app.module.js, .js.map)
src/database/data-source.ts                                  (+ dist/database/data-source.js, .js.map)   ← bare-star → [0-9]* glob
src/database/database.module.ts                              (+ dist/database/database.module.js, .js.map) ← bare-star → [0-9]* glob
src/domains/deposit-control/interface/deposits.controller.ts (+ dist twin .js/.d.ts/.js.map)  ← export ApproveDepositDto
src/domains/treasury/interface/treasury.controller.ts        (+ dist twin .js/.d.ts/.js.map)  ← export CashMoveDto
src/foundation/configuration/app-config.service.ts           (+ dist twin .js/.d.ts/.js.map)  ← releaseBuild getter + new keys
src/foundation/configuration/configuration.schema.ts         (+ dist twin .js/.js.map)        ← NODE_BIN/NPM_BIN/FRONTEND_RUNTIME_PATH/…
tools/data-repair/deferred-migrations/1755852600000-ZeroBaselineCleanup.ts   ← SET CONSTRAINTS ALL IMMEDIATE (55006 fix)
tools/data-repair/deferred-migrations/1755852700000-RepairNonCompliantUuids.ts ← thin wrapper over src/database/uuid-repair.core.ts (55006 fix inside the core)
tools/deploy/verify-deploy.sh                                ← strict RFC4122 UUID check + legacy-PK census + frontend-bundle step
package.json                                                 ← + "yauzl":"^3.4.0", + 4 scripts
package-lock.json                                            ← + yauzl 3.4.0 (+ pend, buffer-crc32)
```

**Removed (server has it; `rsync --delete` on `src/`/`dist/` drops it — 45 files):**

```
src/database/migrations/extension-dependencies.spec.ts        ← the file that breaks `npm run migration:run` (ts-node, TS2582)
src/**/*.spec.ts                                              ← 43 more service/guard/schema unit tests — never run in prod
dist/tsconfig.build.tsbuildinfo                               ← TS incremental build cache
```

No server file is *lost*: every `.spec.ts` remains in the workspace / CI; the
server `src/` is a traceability copy, not the test-runner's source.

---

## D. FILES ADDED (new, not on the server)

**140 files.** By area:

| Area | Count | Files (source; each has a `dist/` twin `.js` + `.d.ts` + `.js.map`) |
|---|---:|---|
| Release Center module | 34 src | `src/foundation/release/`: `release.module`, `release.controller`, `release.entity`, `release-status`, `release-manifest`, `release-migration-run.entity`, `manifest-validation`, `app-version`, `checksum`, `pg-dump-runner.service`, `backup-{run,artifact}.entity`, `backup-{status,trigger}`, `backup-manager.service`, `backup-scheduler.service`, `restore-{operation.entity,status}`, `restore-manager.service`, `release-manager.service`, `package-validator.service`, `release-health-check.service`, `migration-datasource`, `release-execution.service`, `deploy-preflight.service`, `data-repair-{run.entity,status}`, `data-repair.service` |
| UUID repair core | 1 src | `src/database/uuid-repair.core.ts` (shared by `DataRepairService` + the deferred migration; contains the 55006 `SET CONSTRAINTS ALL IMMEDIATE` fix) |
| Release Center migrations | 5 src | `1755852800000-AddReleaseBackupTables`, `1755852900000-AddReleaseRestoreTable`, `1755853000000-AddReleasesTable`, `1755853100000-AddReleaseExecutionTables`, `1755853200000-AddDataRepairRunTable` |
| Deploy tooling | 3 | `tools/build/build-release.sh`, `tools/deploy/check-frontend-bundle.sh`, `tools/data-repair/scratch-rehearsal.{sh,ts}` |
| dist twins | 102 | compiled `.js`/`.d.ts`/`.js.map` for all of the above |

---

## E. DEPENDENCIES NEEDING `npm install`

**One new runtime dependency: `yauzl ^3.4.0`** (used by `PackageValidatorService`
to stream-validate uploaded ZIPs). Transitively pulls `pend ~1.2.0` and
`buffer-crc32 0.2.13`. `@types/yauzl ^3.4.0` is types-only (zero runtime cost).

**`multer` is NOT a new dependency** — it is already resolved on the server as a
transitive dep of `@nestjs/platform-express@10` (`multer 2.0.2`, already used by
`products` / `customers` / `inventory` / `media` / `price-lists` controllers).
`release.controller.ts`'s `FileInterceptor` + `diskStorage` use that same
already-present copy.

**`yazl` + `@types/yazl` are devDependencies** — only for
`package-validator.service.spec.ts` (stripped from this package) and
`build-release.sh`'s zip fallback when the host lacks the `zip` binary.
**Not needed on the server at runtime.** If the host will run `build-release.sh`
and has no `zip`, add `--include=dev` to the install; otherwise skip.

**Operator action (once, after `rsync` of `package*.json`):**
```bash
cd /home/xnexdrgr/daii.xnexustech.com/release-new/backend
"$NPM_BIN" install          # $NPM_BIN = .../nodevenv/daii.xnexustech.com/release-new/backend/20/bin/npm
ls -ld node_modules         # MUST still be the symlink → .../20/lib/node_modules
```
`package-lock.json` in the package makes this deterministic. Subsequent deltas
that don't change dependencies skip this step.

---

## F. MIGRATIONS THAT WILL RUN

Run **once**, via the **compiled** datasource only (never ts-node on the host):
```bash
npm run migration:show:prod      # inspect — expect 5 pending [ ]
npm run migration:run:prod       # node ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run
```

| Migration | Creates |
|---|---|
| `AddReleaseBackupTables1755852800000` | `backup_runs`, `backup_artifacts` + `role_permissions` seed granting `admin` → `system.release` |
| `AddReleaseRestoreTable1755852900000` | `restore_operations` + widens the grant to the parent `system.release` node |
| `AddReleasesTable1755853000000` | `releases` |
| `AddReleaseExecutionTables1755853100000` | `release_migration_runs` + `release_status` terminology |
| `AddDataRepairRunTable1755853200000` | `data_repair_runs` |

**Does NOT run** `FixGenRandomUuidRfc4122Compliance1755852500000` — that already
ran in the v1.0.3 deploy (server migration head is confirmed `1755852500000`).

**The Controlled UUID Data Repair (`RepairNonCompliantUuids`) is NOT a
migration in this package** — it stays deferred in
`tools/data-repair/deferred-migrations/` and is run as a Controlled Data Repair
per `docs/DATA_REPAIR_RUNBOOK.md` **after** the bootstrap, with its own backup +
audit + mapping + integrity gate.

---

## G. REMAINING MANUAL OPERATOR ACTIONS

All are on the host console — none are automatable from a package.

1. **`mkdir`** the canonical skeleton: `_deploy/{incoming,staging,build,previous,manifests,logs}`, `archive/`, `/home/xnexdrgr/backups/daii/{db,fs,media,manifests,app-snapshots,server-snapshots}`.
2. **Manual pre-bootstrap backup** (`docs/BACKUP_RESTORE_RUNBOOK.md` §1) — `pg_dump -Fc` + `pg_restore --list` verify + `release-new/backend` fs tar + `storage/media` tar + SHA-256s. **Do not `rsync` anything before this passes.**
3. `cp -a release-new/backend _deploy/previous/backend` (filesystem rollback baseline).
4. **Set the 8 env keys** in cPanel → Setup Node.js App → Environment variables (`RELEASE_APP_ROOT`, `FRONTEND_RUNTIME_PATH`, `PASSENGER_RESTART_FILE`, `RELEASE_STAGING_PATH=…/_deploy/staging`, `RELEASE_BACKUP_STORAGE_PATH=/home/xnexdrgr/backups/daii`, `NODE_BIN`, `NPM_BIN`, `PG_DUMP_BIN`, `PG_RESTORE_BIN`, `RELEASE_BUILD_MAX_THREADS=2`). All have safe defaults, so the app still boots if one is missed.
5. **Secret rotation** — move `DB_PASSWORD` / `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `INTEGRATION_ENCRYPTION_KEY` from `.htaccess` to the cPanel env UI; **rotate `JWT_REFRESH_SECRET` and `INTEGRATION_ENCRYPTION_KEY` to distinct random 32+ char values** (currently identical); delete the `SetEnv` secret lines. Invalidates all sessions + integration-connector credentials.
6. `pg_dump`/`pg_restore` absolute paths — `which pg_dump` on the host (not knowable from the workspace).
7. The `rsync` publish (Phase 0.9), `$NPM_BIN install` (§E), `migration:run:prod` (§F).
8. `touch tmp/restart.txt` → `bash tools/deploy/verify-deploy.sh https://daii.xnexustech.com` (must exit 0).
9. **Controlled UUID Data Repair** on staging (`docs/DATA_REPAIR_RUNBOOK.md` + `docs/UUID_REPAIR_REPORT.md` §6).
10. **Staging acceptance** (`docs/POST_DEPLOY_VERIFICATION.md` / `docs/FINAL_RECONCILIATION_REPORT.md` PART 8 — S1–S12), including `POST /treasury/cash-in` + `POST /deposits/:id/approve` returning 2xx with **no UUID error**.
11. Server cleanup (`docs/CLEANUP_REPORT.md`) — reference check + **move** LEGACY trees to `archive/` (never `rm`).
12. Recompute the snapshot SHA-256 on the confirmed canonical copy (the handover digest is malformed).

**After step 8 completes and step 10 passes, all future releases go through the
Release Center** — no more manual `rsync`.

---

## H. SECRETS / PRODUCTION DATA — CONFIRMATION

- **No `.env`, no `.env.*`, no `.htaccess`** in the package (verified: `find` + zip listing).
- **No `node_modules`, no symlinks** (verified).
- **`scan_secrets` CLEAN** on the full extracted package (private-key headers, `PGPASSWORD=`, credential-named quoted literals with entropy, `SetEnv` secret lines, non-example `.env` — none found).
- **No production data** — no `storage/`, no DB dump, no `احمد/` folder, no server snapshot.
- The one `.md` that *quotes* the `.htaccess` finding (`docs/SERVER_SNAPSHOT_COMPATIBILITY_REVIEW.md`) does **not** reproduce any secret value — it names the variables and the fact that two share a value, nothing more.

---

## I. FRESH EXTRACT VERIFICATION RESULT

Extracted into a clean `mktemp -d` and run — **ALL 12 CHECKS PASSED**:

| # | Check | Result |
|---|---|---|
| 0 | Fresh extract | 1494 files, one top-level dir |
| 1 | Zip SHA-256 | `0bc02f5f…c9c6b` — matches sidecar `.zip.sha256` |
| 2 | `MANIFEST.sha256` (every file) | `sha256sum -c` — **1493/1493 match** |
| 3 | `MANIFEST.json` shape + per-file checksum | valid; 1449 files, 0 problems; `packageType:"delta"`, `baseVersion:"1.0.3"`; `dependencyChanges:{yauzl,@types/yauzl}` |
| 4 | `node --check` every `dist/**/*.js` | **361/361 parse** |
| 5 | dist integrity (`check-dist-integrity.js`) | every relative `require()` resolves |
| 6 | structure validation (`validate-structure.js`) | no violations |
| 7 | no `node_modules`/`.env`/`.htaccess`/symlink/backslash/`..`; secret scan | all clean; **scan_secrets CLEAN** |
| 8 | migration filenames | 123 `.js` all `[0-9]`-anchored, no `*.spec`/`*.test`; `data-source.js` + `database.module.js` both carry the `[0-9]*` glob |
| 9 | frontend bundle | N/A — no `public/` (backend-only bootstrap, documented §B) |
| 10 | 55006 fix present | `SET CONSTRAINTS ALL IMMEDIATE` in `dist/database/uuid-repair.core.js`; deferred migration is the wrapper |
| 11 | dependency | `yauzl 3.4.0` in `package-lock.json`, `^3.4.0` in `package.json`; `migration:run:prod` script present |

Workspace state at build time: `npm run build` clean · **57 test suites / 692
tests green** · lint 19 pre-existing (0 new) · `check-dist-integrity` +
`validate:structure` clean · `scratch-rehearsal.sh` (real PostgreSQL 18) passed.

---

## J. FINAL SHA-256

```
Daii-Bootstrap-v1.0.3-2026-08-31.zip
```
Sidecar: `Daii-Bootstrap-v1.0.3-2026-08-31.zip.sha256` (same value).
Per-file digests: `MANIFEST.sha256` inside the package (1493 entries).

---

## Delta proof: CURRENT SERVER BASELINE → VERIFIED v1.0.3 BOOTSTRAP STATE

| Property | Server baseline (snapshot) | After applying this package | Proven by |
|---|---|---|---|
| `src/foundation/release/` | absent | present (34 files) | §D + MANIFEST.json |
| `dist/foundation/release/` | absent | present (102 files) | §D + `node --check` (check 4) + dist-integrity (check 5) |
| Migration head reachable by `migration:run:prod` | `1755852500000` | `1755853200000` after the run | §F + migration filename check (check 8) |
| `data-source` / `database.module` glob | `migrations/*{.ts,.js}` (bare) | `migrations/[0-9]*{.ts,.js}` | §C + check 8 |
| `extension-dependencies.spec.ts` in `src/database/migrations/` | present (breaks ts-node `migration:run`) | removed | §C REMOVED |
| `RepairNonCompliantUuids` 55006 fix | absent (would fail SQLSTATE 55006) | present (in the shared core + the wrapper migration) | §C + check 10 |
| `yauzl` dependency | absent | `^3.4.0` (host `npm install`) | §E + check 11 |
| `verify-deploy.sh` | shape-only UUID check | strict RFC4122 + legacy-PK census + frontend-bundle | §C |
| Config keys (`NODE_BIN`, `FRONTEND_RUNTIME_PATH`, …) | absent | present, default-safe | §A + §C |
| Frontend | `index-DtuYiAhd.js` (synced) | **unchanged** (out of scope) | §B |

**v1.0.3 is NOT `SOFTWARE RELEASE = VERIFIED`** — this package makes it
*deployable*; verification is the operator's staging run (§G steps 8–10,
`docs/POST_DEPLOY_VERIFICATION.md`).
