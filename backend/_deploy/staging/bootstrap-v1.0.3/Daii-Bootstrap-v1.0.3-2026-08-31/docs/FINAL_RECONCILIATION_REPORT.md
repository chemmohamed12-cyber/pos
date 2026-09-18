# Daii v1.0.3 — Final Reconciliation Report

**Inputs reconciled:**
1. Workspace code — `1-hosting/4-Daii_Final_Release_20260828/backend`
2. Server snapshot — `Daii-Server-Full-Snapshot-2026-08-31.tar.gz` (root `daii.xnexustech.com/`)
3. Team-B docs — `SERVER_BASELINE_REPORT.md`, `CANONICAL_SERVER_STRUCTURE.md`, `CLEANUP_REPORT.md`, `DEPLOYMENT_ARCHITECTURE.md`, `RELEASE_ARTIFACT_SPEC.md`, `RELEASE_MANIFEST_SPEC.md`, `DEPLOYMENT_RUNBOOK.md`, `BACKUP_RESTORE_RUNBOOK.md`, `ROLLBACK_RUNBOOK.md`, `POST_DEPLOY_VERIFICATION.md`, `UUID_AUDIT_REPORT.md`, `UUID_REPAIR_REPORT.md`, `FINAL_V1.0.3_DEPLOYMENT_REPORT.md`
4. Release / Backup / Restore / Rollback architecture (this workstream)

**Method:** every path, binary, glob, and invariant in `foundation/release/*`, `foundation/configuration/*`,
`tools/*`, `package.json`, and the migrations was checked against the extracted snapshot and against
each Team-B doc. Two Claude sessions built Workstream A in parallel and converged on the same design;
the code on disk is the merged result (this report treats it as one codebase).

---

## PART 1 — WORKSPACE ↔ SERVER ↔ TEAM-B: MATCH / DIFFER

### 1A. MATCHES (no change needed — architecture assumption == server reality == Team-B)

| Item | Value (all three agree) |
|---|---|
| `RELEASE_APP_ROOT` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` (`.htaccess` `PassengerAppRoot`) |
| `NODE_BIN` | `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node` (`.htaccess` `PassengerNodejs`; Node 20.20.2) |
| `NPM_BIN` | `…/20/bin/npm` (npm 10.8.2) |
| Passenger startup | `dist/main.js` (`.htaccess` `PassengerStartupFile`) |
| `FRONTEND_RUNTIME_PATH` | `<RELEASE_APP_ROOT>/public` — the SPA is served from `backend/public`, NOT `frontend/dist` (`main.ts` `useStaticAssets(join(process.cwd(),'public'))` + `get('*')` → `public/index.html`, `/api/*` excluded) |
| `PASSENGER_RESTART_FILE` | `<RELEASE_APP_ROOT>/tmp/restart.txt` — file exists on the server |
| Frontend bundle state | `backend/public/` == `frontend/dist/` (both `index-DtuYiAhd.js` + `index-j2WWxJ8K.css`) — currently **no drift** |
| `node_modules` | a **symlink** → nodevenv `…/20/lib/node_modules` — never packaged, never overwritten |
| Env delivery | `<IfModule Litespeed> SetEnv …` in the **web-root** `.htaccess` (no `backend/.env`, no cPanel-UI vars today) |
| DB | PostgreSQL 10.x, `127.0.0.1:5432`, `xnexdrgr_daii_staging` / `xnexdrgr_daii_app2` — staging / disposable |
| SPA fallback (Hotfix 4) | present in deployed `dist/main.js` |
| Release-artifact rules | `.zip` only, `/`-paths, 755/644, no `node_modules`/`.env`/secrets, `MANIFEST.json` + checksums — `RELEASE_ARTIFACT_SPEC.md` == `PackageValidatorService` + `build-release.sh` |
| Backup validity rule | "created ≠ valid" — must pass `pg_restore --list` + SHA-256 re-check (`BackupManagerService.verifyArtifact`) |
| Rollback order | undo migrations (newest-first) → restore files → DB-restore fallback → touch restart |

### 1B. DIFFERENCES — server is BEHIND the workspace (closed by the one-time bootstrap)

| # | On the server today | In the workspace | Bootstrap step |
|---|---|---|---|
| D1 | `src/foundation/release/` + `dist/foundation/release/` **absent**; no `yauzl`/`multer`; Release-Center migrations un-run | full Release Center + `DeployPreflightService` + `DataRepairService` | Phase 0.4–0.5 (`DEPLOYMENT_RUNBOOK.md`) |
| D2 | `data-source.ts` **and** `dist/database/database.module.js` use bare `migrations/*{.ts,.js}`; `src/database/migrations/` contains `extension-dependencies.spec.ts` → `npm run migration:run` (ts-node) still hits `TS2582` | `[0-9]*{.ts,.js}` in all 3 glob sites + `migration:run:prod` (compiled) + `migration-glob.spec.ts` | Phase 0.4 (ship the fix) — until then use `migration:run:prod` only |
| D3 | `tools/data-repair/deferred-migrations/1755852700000-RepairNonCompliantUuids.ts` is the **pre-`SET CONSTRAINTS ALL IMMEDIATE`** version → **fails SQLSTATE 55006** if run as-is | thin wrapper over `src/database/uuid-repair.core.ts` which has the fix | Phase 0.4 (ships `tools/` + `uuid-repair.core.ts`); **do NOT run the server's current copy** |
| D4 | `package.json`: old scripts, no `migration:run:prod` / `build:release` / `verify:frontend-bundle` | updated | Phase 0.4 (`cp package*.json` + `npm install`) |
| D5 | `tools/` has no `build/build-release.sh`, no `deploy/check-frontend-bundle.sh` | both present | Phase 0.4 |
| D6 | `.env.example` stale ("PORT 3500", no `RELEASE_*` keys) | updated (this reconciliation adds the two path prod-values) | Phase 0.3 (set real env via cPanel UI) |
| D7 | `storage/` = `media/` only; no `backups/`, no `_deploy/`; rollback = ad-hoc `public.backup.*` / `dist.backup.*` dirs | `BackupManagerService` writes `db/ media/ manifests/`; `ReleaseExecutionService` writes `app-snapshots/<releaseId>/` | Phase 0.1 (`mkdir` per `CANONICAL_SERVER_STRUCTURE.md`) |

### 1C. DISCREPANCIES found IN THE DOCS / CODE (all minor; resolutions below)

| # | Discrepancy | Resolution |
|---|---|---|
| R1 | `CANONICAL_SERVER_STRUCTURE.md` tree lists `backups/daii/fs/<backup-run-id>.tar.gz` as "the filesystem snapshot" but the **Release Center writes per-file snapshots to `<backup-storage>/app-snapshots/<releaseId>/`**, not a single `fs/` tar. `fs/` is only the **manual** Phase-0 full-tree tar (`BACKUP_RESTORE_RUNBOOK.md` §1c). | **Both are correct, different tools.** `CANONICAL_SERVER_STRUCTURE.md` should add `├── app-snapshots/<release-id>/   # Release Center per-file pre-deploy snapshot` under `backups/daii/`. `fs/` stays as the manual-tar location. (Correction filed to Team B.) |
| R2 | This workstream's `.env.example` did not list `RELEASE_STAGING_PATH` / `RELEASE_BACKUP_STORAGE_PATH` production values; `DEPLOYMENT_RUNBOOK.md` §0.3 does (`…/_deploy/staging`, `/home/xnexdrgr/backups/daii`). | **Fixed here** — `.env.example` now carries both, matching the runbook. |
| R3 | `main.ts` serves the SPA from `join(process.cwd(),'public')` — a literal, not `FRONTEND_RUNTIME_PATH`. The health check verifies `FRONTEND_RUNTIME_PATH`. They are equal **only while** `RELEASE_APP_ROOT` == the Passenger process cwd and `FRONTEND_RUNTIME_PATH` == `<RELEASE_APP_ROOT>/public` (the defaults, and what the runbook sets). | **Invariant, documented (PART 5).** Recommended: add a `DeployPreflightService` check `path.frontend_runtime_matches_served` (warn if `frontendRuntimePath !== join(process.cwd(),'public')`). Proposed to Team B; not blocking. |
| R4 | `SERVER_BASELINE_REPORT.md` §preamble: the snapshot SHA-256 quoted in the handover text is 62 chars (malformed). | Operator recomputes `sha256sum` on the confirmed canonical snapshot copy and records the real 64-char digest. Not a code issue. |
| R5 | CTO PART 11: "add validation that prevents accidental secret packaging". Today the guard is **path-based only** (`.env` denylisted, only `src/ dist/ public/` + `MANIFEST.json` + `package*.json` allowed). A secret hard-coded inside a `src/`/`dist/` file would pass. | **Fixed here** — `build-release.sh` now runs a targeted `scan_secrets` over the staged tree (private-key headers, `PGPASSWORD=`, `SetEnv <SECRET>`, long hex/base64 assigned to `*_SECRET`/`*_KEY`/`*_PASSWORD`, any `.env` that is not `.env.example`) and refuses to package on a hit. `--verify` re-runs it. |

**No discrepancy invalidates the architecture.** R1–R5 are documentation alignment + two additive
guards. There is **no** path where Doc A says one thing and Doc B says another about a runtime path.

---

## PART 2 — UPDATED CANONICAL SERVER STRUCTURE (delta only)

`CANONICAL_SERVER_STRUCTURE.md` stands as written **with these two corrections**:

```
/home/xnexdrgr/backups/daii/
├── db/<backup-run-id>.dump                 # pg_dump -Fc  (manual Phase-0 AND Release Center)
├── fs/<TS>.tar.gz                          # MANUAL full-tree tar (Phase 0 / BACKUP_RESTORE_RUNBOOK §1c)
├── app-snapshots/<release-id>/             # ← ADD: Release Center per-file pre-deploy snapshot
├── media/<backup-run-id>.tar.gz            # storage/media archive
├── manifests/<backup-run-id>.json          # daii.backup-manifest/1
└── server-snapshots/                       # full-server baselines (CONFIDENTIAL)
```

Config keys — **canonical production values** (this is the single source; `.env.example` and
`DEPLOYMENT_RUNBOOK.md` §0.3 now match it exactly):

| Key | Production value |
|---|---|
| `RELEASE_APP_ROOT` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` |
| `FRONTEND_RUNTIME_PATH` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/public` |
| `PASSENGER_RESTART_FILE` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/tmp/restart.txt` |
| `RELEASE_STAGING_PATH` | `/home/xnexdrgr/daii.xnexustech.com/_deploy/staging` |
| `RELEASE_BACKUP_STORAGE_PATH` | `/home/xnexdrgr/backups/daii` |
| `NODE_BIN` / `NPM_BIN` | `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/{node,npm}` |
| `PG_DUMP_BIN` / `PG_RESTORE_BIN` | absolute host path (`which pg_dump` on the host — record it) |
| `RELEASE_BUILD_MAX_THREADS` | `2` |

`releases/<version>` + atomic `current` symlink swap: **still deferred** — needs a scratch-subdomain
test that LiteSpeed/Passenger follows a symlinked `PassengerAppRoot` and picks up the swap on
restart. Until then `release-new/` is the literal runtime and a deploy updates it in place with
`app-snapshots/` + `_deploy/previous/` as the rollback anchors.

---

## PART 3 — UPDATED DEPLOYMENT ARCHITECTURE (delta only)

`DEPLOYMENT_ARCHITECTURE.md` is accurate against the code. One clarification and one recommended
guard:

- **Backup step wording**: "per-file filesystem snapshot" is correct — it is written to
  `<RELEASE_BACKUP_STORAGE_PATH>/app-snapshots/<releaseId>/`, not `fs/`. `BackupManagerService`
  additionally writes `db/<runId>.dump` + `media/<runId>.tar.gz` + `manifests/<runId>.json`. A
  whole-tree tar is the **manual** belt-and-suspenders path, not part of the automatic pipeline.
- **Recommended additional preflight check** (R3): `frontendRuntimePath === join(process.cwd(),'public')`
  → `warn` on mismatch, so a mis-set `FRONTEND_RUNTIME_PATH` can't let the health check pass against
  a directory the app doesn't actually serve.

Everything else — the 12-stage pipeline, the auto-rollback branch, the "server-reality invariants"
table — matches `release-execution.service.ts` / `deploy-preflight.service.ts` /
`release-health-check.service.ts` / `package-validator.service.ts` as they stand.

---

## PART 4 — BOOTSTRAP CHECKLIST (one-time, manual, on the host)

Ordered. Do not skip the backup. Full commands: `DEPLOYMENT_RUNBOOK.md` Phase 0.

- [ ] **B1.** Record host facts: `"$NODE_BIN" -v` (20.20.2), `"$NPM_BIN" -v` (10.8.2), `which pg_dump pg_restore`, `df -h` on the app + `/home/xnexdrgr/backups` volumes (≥ 500 MB free each).
- [ ] **B2.** `mkdir -p` the canonical dirs: `_deploy/{incoming,staging,build,previous,manifests,logs}`, `archive/`, `/home/xnexdrgr/backups/daii/{db,fs,media,manifests,app-snapshots,server-snapshots}`.
- [ ] **B3.** **Manual pre-bootstrap backup** (`BACKUP_RESTORE_RUNBOOK.md` §1): `pg_dump -Fc` + `pg_restore --list` verify + `release-new/backend` fs tar (`--exclude=node_modules`, includes `.htaccess`) + `storage/media` tar + SHA-256s + a `manifests/<TS>.json`. **Do not proceed without a passing `pg_restore --list`.**
- [ ] **B4.** `cp -a release-new/backend _deploy/previous/backend` (first filesystem rollback baseline).
- [ ] **B5.** Set env vars in **cPanel → Setup Node.js App → Environment variables** (NOT `.htaccess`): the 8 `RELEASE_*` / `NODE_BIN` / `NPM_BIN` / `PG_*` / `RELEASE_BUILD_MAX_THREADS` keys from PART 2.
- [ ] **B6.** **Security (PART 11 / `SERVER_BASELINE_REPORT.md` §5):** move `DB_PASSWORD` / `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `INTEGRATION_ENCRYPTION_KEY` from `.htaccess` to the cPanel env UI; **rotate `JWT_REFRESH_SECRET` and `INTEGRATION_ENCRYPTION_KEY` to distinct random 32+ char values** (they are currently identical); rotate `JWT_ACCESS_SECRET` to random material; delete the `SetEnv` secret lines from `.htaccess` (keep only Passenger directives). Expect: all sessions invalidated (re-login); integration-connector credentials re-entered.
- [ ] **B7.** Build the hardening delta on dev/CI: `bash tools/build/build-release.sh --package-type delta --base-version 1.0.3` → `bash tools/build/build-release.sh --verify <zip>` (must PASS, incl. the new `scan_secrets`).
- [ ] **B8.** Upload the `.zip` + `.sha256` to `_deploy/incoming/`; `sha256sum -c`; extract to `_deploy/staging/bootstrap/`.
- [ ] **B9.** Publish (files only — no Release Center yet): `cp -a src src.pre-bootstrap && cp -a dist dist.pre-bootstrap`; `rsync -a --delete staged/src/ ./src/`; `rsync -a --delete staged/dist/ ./dist/`; `rsync -a staged/public/ ./public/`; `cp staged/package*.json ./`.
- [ ] **B10.** `"$NPM_BIN" install` (resolves `yauzl` + `multer` into the nodevenv lib — the symlink target). Confirm `node_modules` is still the symlink (`ls -ld node_modules`).
- [ ] **B11.** Migrations via the **compiled** datasource only: `npm run migration:show:prod` then `npm run migration:run:prod` (runs `AddReleaseBackupTables` … `AddDataRepairRunTable`; does NOT re-run `FixGenRandomUuidRfc4122Compliance` — server head is already `1755852500000`). **Never `npm run migration:run` (ts-node) on the host.**
- [ ] **B12.** `touch tmp/restart.txt` → `bash tools/deploy/verify-deploy.sh https://daii.xnexustech.com` → **exit 0** (schema readiness, strict RFC4122 UUID-function check, frontend-bundle check, legacy-PK census WARNING).
- [ ] **B13.** Confirm the Release Center is live: `GET /api/release/version`, `GET /api/release/backups` (200, admin token). Permission seed check: `admin` resolves `system.release` (parent grant covers `system.release.*`).
- [ ] **B14.** **Controlled UUID Data Repair** — `DATA_REPAIR_RUNBOOK.md` + `UUID_REPAIR_REPORT.md` §6 acceptance. Backup → audit → mapping → link verified backup → execute → integrity verify. Keep the pre-repair dump + `data_repair_runs` row as evidence.
- [ ] **B15.** **Staging acceptance** — PART 6 checklist below. Only on full pass: declare `v1.0.3 SOFTWARE RELEASE = VERIFIED`.
- [ ] **B16.** Server cleanup — `CLEANUP_REPORT.md` §3 reference check per item, then **move** (never `rm`) LEGACY trees to `archive/`. Re-run `verify-deploy.sh` after (proves nothing archived was load-bearing).
- [ ] **B17.** From here on: **every release goes through the Release Center** (PART 7). No more manual `rsync` deploys.

---

## PART 5 — EXACT SERVER BOOTSTRAP FILE LIST

What the bootstrap delta MUST land on the host (all under `RELEASE_APP_ROOT`), and why:

| Path (in the artifact → on the host) | Why it must be in the bootstrap |
|---|---|
| `dist/**` (full compiled tree) | replaces the running app with the Release-Center-included build |
| `dist/foundation/release/**` | the Release Center itself (Backup / Restore / Execution / Preflight / DataRepair / health) — **D1** |
| `dist/database/data-source.js` | compiled datasource for `migration:run:prod` — **D2** |
| `dist/database/database.module.js` | carries the `[0-9]*` glob fix into the running app — **D2** |
| `dist/database/migrations/1755852800000…1755853200000-*.js` | the 5 Release-Center migrations (`AddReleaseBackupTables`, `AddReleaseRestoreTable`, `AddReleasesTable`, `AddReleaseExecutionTables`, `AddDataRepairRunTable`) — **D1** |
| `dist/database/uuid-repair.core.js` | the repair algorithm **with `SET CONSTRAINTS ALL IMMEDIATE`** — **D3** |
| `src/**` | deployed source for traceability (not executed); includes `src/database/data-source.ts` with the `[0-9]*` glob |
| `public/index.html` + `public/assets/index-<hash>.{js,css}` + `public/favicon.svg` + `public/icons.svg` | frontend runtime (only if the bundle changed; otherwise omit — bundle is currently synced) |
| `package.json` | new scripts (`migration:run:prod`, `migration:show:prod`, `build:release`, `verify:frontend-bundle`) + the `yauzl` dependency |
| `package-lock.json` | deterministic `npm install` of `yauzl` + `multer` into the nodevenv |
| `tools/build/build-release.sh` | **D5** — future artifact builds |
| `tools/deploy/verify-deploy.sh` (updated) | strict RFC4122 + frontend-bundle + legacy-PK census |
| `tools/deploy/check-frontend-bundle.sh` | **D5** — bundle-drift check |
| `tools/data-repair/uuid-audit.sql`, `post-repair-verification.sql`, `zero-baseline-deletion-report.sql` | operator SQL for the repair (also usable pre-bootstrap) |
| `tools/data-repair/deferred-migrations/1755852700000-RepairNonCompliantUuids.ts` (wrapper) + `1755852600000-ZeroBaselineCleanup.ts` (with the IMMEDIATE fix) | **D3** — replaces the server's broken copies; stay deferred |
| `tools/data-repair/scratch-rehearsal.sh` + `.ts` | rehearsal on a scratch DB before the real run |
| `tools/validation/check-dist-integrity.js`, `validate-structure.js` | unchanged; included for completeness |
| `MANIFEST.json` | required by `PackageValidatorService` (Phase 1 onward) |

**Host-side, not in the artifact:** the 8 env keys (cPanel UI), the rotated secrets, the `mkdir`'d
`_deploy/` + `backups/daii/` skeleton, `"$NPM_BIN" install`.

---

## PART 6 — FILES / DIRS THAT MUST **NEVER** BE IN A RELEASE ZIP

Enforced by `PackageValidatorService` (path) + `build-release.sh` `scan_secrets` (content). Any one → **package rejected**.

| Must NOT be in the ZIP | Enforcement |
|---|---|
| `node_modules/` (any depth) | `DENYLISTED_PREFIXES` — `node_modules/` prefix rejected. It is a **host symlink to the nodevenv**; shipping it would break the runtime. |
| `.env`, `.env.production`, `.env.local`, any `.env.*` except `.env.example` | `.env` denylisted exact; `.env.*` not under `src/ dist/ public/` and not in `ALLOWED_ROOT_FILES` → rejected. `.env.example` is documentation-only and also currently not shipped (not an allowed root file). |
| `.htaccess` | not under an allowed prefix → rejected. (It holds Passenger config + secrets and is host-managed.) |
| Any file containing a secret (private-key header, `PGPASSWORD=`, `JWT_*_SECRET=<value>`, `INTEGRATION_ENCRYPTION_KEY=<value>`, long hex/base64 assigned to `*_SECRET`/`*_KEY`/`*_PASSWORD`) | `build-release.sh` `scan_secrets` (new, R5) + `--verify` |
| `*.sh`, `*.exe`, `*.bat`, `*.ps1`, `*.cmd`, `*.msi`, `*.dll`, `*.so` | `DANGEROUS_EXTENSIONS`. (The `tools/*.sh` scripts reach the host **only** in the one-time bootstrap `rsync`, never through the Release Center upload path.) |
| Symlinks (any) | `externalFileAttributes` Unix-mode `S_IFLNK` check → rejected. No dev-machine symlink can ride along. |
| Backslash (`\`) path separators | rejected outright (yauzl `strictFileNames` + explicit check) — the v1.0.3 Windows-zip failure. |
| `..` path-traversal (any encoding) | string check + `resolve()`-based staging-dir containment check. |
| `storage/`, `dist.backup.*`, `public.backup.*`, `*.log`, `stderr.log`, `tmp/` | not under `src/ dist/ public/` → rejected. Runtime data / logs / ad-hoc backups are host state, never artifact content. |
| Anything outside top-level `src/`, `dist/`, `public/` (+ `MANIFEST.json`, `package.json`, `package-lock.json`) | allow-list — everything else rejected by default. |
| `Daii-Server-Full-Snapshot-*.tar*` | it is a **server snapshot, not a release artifact**, and is **CONFIDENTIAL** (contains production secrets). Never in a ZIP, never in Git, never in shared storage. |

---

## PART 7 — FINAL RELEASE ARTIFACT VALIDATION CHECKLIST

Run `bash tools/build/build-release.sh --verify <zip>` — it performs all of these. Manual sign-off list:

- [ ] Single `.zip`, one top-level `Daii-Release-v<version>-<date>/`, sibling `.zip.sha256`, `sha256sum -c` passes.
- [ ] `MANIFEST.json` at the root; parses; `version` == `package.json` version; `packageType` ∈ {`full`,`delta`}; `baseVersion` present for `delta` and == the currently installed version.
- [ ] Every `files[]` entry: `/`-separated, starts with `src/`/`dist/`/`public/` (or is `MANIFEST.json`/`package.json`/`package-lock.json`); `action` ∈ {`add`,`modify`,`delete`}; `checksum` present for non-delete, absent for delete.
- [ ] Bidirectional cross-check: every manifest file is staged with a matching SHA-256; every staged file (besides `MANIFEST.json`) is declared. No undeclared extras.
- [ ] If `public/index.html` is in the manifest: every `assets/*.{js,css}` it references is also in the manifest, staged, non-empty (frontend-bundle-drift guard).
- [ ] If any migration file is present: `dist/database/data-source.js` is present; `dist/database/migrations/` has **no** `*.spec.js` / `*.test.js`; every migration `.js` is `[0-9]`-anchored.
- [ ] `node --check` passes on every `dist/**/*.js`.
- [ ] No `node_modules/`, no `.env*` (except none), no `.htaccess`, no `*.sh`/`*.exe`/… , no symlinks, no `\` paths, no `..`.
- [ ] `scan_secrets` finds nothing (no private-key headers, no `PGPASSWORD=`, no assigned `*_SECRET`/`*_KEY`/`*_PASSWORD` literals).
- [ ] Dirs `755`, files `644` inside the archive.
- [ ] `dependencyChanges` in `MANIFEST.json` matches any `package.json` diff (drives the host `npm install` note).

---

## PART 8 — FINAL STAGING ACCEPTANCE CHECKLIST

On the real `xnexdrgr_daii_staging` DB, after the bootstrap and the Controlled Data Repair
(`POST_DEPLOY_VERIFICATION.md` §2 is the full smoke list; these are the gating items):

- [ ] **S1. Login** — token issued; `GET /api/health/deep` → `success:true`.
- [ ] **S2. DB health** — `ReleaseHealthCheckService.check()` `ok:true`; canary tables present; `gen_random_uuid()` / `uuid_generate_v4()` return **strict RFC4122**.
- [ ] **S3. Frontend bundle** — `bash tools/deploy/check-frontend-bundle.sh <AppRoot>/public` exit 0; `component.frontend.bundle` true.
- [ ] **S4. Migration verification** — `npm run migration:show:prod` shows **no** `[ ]` pending; `GET /api/release/releases/:id/migrations` all `success:true`.
- [ ] **S5. Controlled UUID Data Repair** — pre-repair backup verified + retained; audit count recorded; mapping reviewed; `execute` → `rowsRepaired` recorded; `verifyUuidRepairIntegrity` → **passed, 0 orphans, 0 remaining non-compliant**.
- [ ] **S6. `POST /api/treasury/cash-in`** with a real repaired `accountId` → **2xx, NO `accountId must be a UUID`**; a `posted` `treasury_transactions` row; balance moves.
- [ ] **S7. `POST /api/deposits/:id/approve`** with a real repaired `treasuryAccountId` → **2xx, NO `treasuryAccountId must be a UUID`**.
- [ ] **S8. Ledger correctness** — S7 created a `treasury_transactions` row **and** a `customer_ledger_entries` credit for the deposit amount, linked to the order/customer.
- [ ] **S9. Backup verification** — `POST /api/release/backups` → `verified` DB artifact; `manifests/<runId>.json` written with migration head + SHA-256s.
- [ ] **S10. Restore test** — `BACKUP_RESTORE_RUNBOOK.md` §5: create a visible record → `preflight` + `confirm` restore → record is gone, app still boots + logs in + `/api/health/deep` ok.
- [ ] **S11. Rollback verification** — `pg_restore` of the pre-repair dump returns every repaired id + every row count to pre-repair values (proven in `rehearsal-evidence/09-restore.json`; repeat on staging).
- [ ] **S12. Final deploy health** — `verify-deploy.sh` exit 0; legacy-PK census now **0**; new records created in S2–S8 all strict-RFC4122.
- [ ] **New-record UUID check** — every id created during S1–S8 matches strict RFC4122 (generation fix `1755852500000`).

**Only when S1–S12 all pass:** `v1.0.3 = SOFTWARE RELEASE = VERIFIED`. Not before — tests and build
passing are necessary, not sufficient (`FINAL_V1.0.3_DEPLOYMENT_REPORT.md` is the evidence record).

---

## PART 9 — REMAINING MANUAL STEPS (and why each is manual)

| Step | Manual because |
|---|---|
| **Phase-0 bootstrap** (PART 4, B1–B13) | The Release Center cannot deploy itself onto a server that doesn't have it. Files must land via `rsync` + `npm install` + `migration:run:prod` once. **One time only.** |
| **Secret rotation + move to cPanel env UI** (B6) | Editing production secrets and cPanel's Node.js App settings is an operator action on the host console — no API, and deliberately outside any script. |
| **Server-directory `mkdir` skeleton** (B2) | Creating `_deploy/` + `backups/daii/` on the host filesystem. (The app auto-creates `storage/backups` subdirs at runtime, but the canonical `/home/xnexdrgr/backups/daii` root and `_deploy/` are host layout.) |
| **cPanel restart button** — fallback only | The pipeline touches `tmp/restart.txt` automatically. If Passenger doesn't pick that up (rare), the cPanel "Restart" button is the manual fallback. The pipeline logs a WARNING, never rolls back a good deploy over this. |
| **Server cleanup** (B16 / `CLEANUP_REPORT.md`) | Moving LEGACY trees to `archive/` needs a per-item reference check (`.htaccess`, app code, crontab, env) that a human confirms. Nothing is deleted. |
| **The staging acceptance run** (PART 8) | Requires a human/QA driving the 12 business flows against the live staging app with real repaired data. The regression tests cover the code; the acceptance proves the deployed system. |
| **`releases/<version>` + `current` symlink** — future | Needs a scratch-subdomain test of Passenger's symlink-follow behaviour before it can be trusted. Deferred, documented. |
| **`pg_dump` / `pg_restore` absolute path** (B1) | Must be read from the host (`which pg_dump`) — it is not knowable from the workspace. |
| **Snapshot SHA-256 recompute** (R4) | The handover digest is malformed; the operator recomputes on the confirmed copy. |

---

## PART 10 — AUTOMATED AFTER BOOTSTRAP?

### **AUTOMATED AFTER BOOTSTRAP: YES** — for the release pipeline.

Once the Phase-0 bootstrap (PART 4) is done **once**, every subsequent release is:

```
build-release.sh --verify   (dev/CI — deterministic artifact)
        │
        ▼   upload one .zip
POST /api/release/releases/upload
        ▼
validate (zip safety + MANIFEST + checksums + bundle-drift)
        ▼
version check (delta baseVersion == installed)
        ▼
POST /api/release/backups  +  link-backup            ← two API calls (or the UI's deploy flow does it)
        ▼
POST /api/release/releases/:id/deploy
        ▼
host preflight → verified-backup gate → snapshot → publish files →
migrate (compiled datasource) → touch restart.txt → health check
        ▼
succeeded          OR          auto-rollback → rolled_back
```

No SSH, no manual `chmod`/`tsc`/`vite`, no path guessing, no manual migration CLI, no manual restart.
Failure at any stage stops and rolls back (migrations undone → files restored → DB-restore fallback →
restart), with full evidence on the `Release` row + `release_migration_runs` + `audit_records` + the
backup manifest.

### The residue that stays manual (and is acceptable):

1. **Building + uploading the artifact** — a deliberate human gate (review the diff, decide to
   release). `build-release.sh` makes the *artifact* deterministic; a human still clicks upload.
2. **Taking + linking the backup** — two explicit API calls (or one UI action). Deliberately not
   folded into `deploy` so "deploy" can never run without an operator having a verified restore
   point in hand. This is the "No Verified Backup → No Deployment" rule, by design.
3. **Staging acceptance sign-off** — a human confirms the business flows before `VERIFIED`.
4. **A dependency change** — adds one host `npm install` step (the manifest's `dependencyChanges`
   flags it; the runbook has the step). Deltas without dep changes skip it.
5. **Secret rotation** — operator-only, on the host, forever.
6. **DB rollback beyond a migration's `down()`** — auto-fallback restores from the linked backup;
   a *deeper* recovery (wrong backup, corruption) is operator-driven per `ROLLBACK_RUNBOOK.md` §3.

None of these are v1.0.3-deployment failures re-appearing — they are intentional human gates on an
otherwise-automated pipeline.

---

## PART 11 — FUTURE ERP ARCHITECTURE — NOT IN SCOPE, NOT FORECLOSED

Not implemented in this workstream (CTO PART 17). Confirmed the current architecture leaves the door
open:

| Future capability | Why it is not blocked |
|---|---|
| Modular ERP (Sales / Accounting / HR / Inventory as units) | Domains are already isolated (`domains/*`, boundary-enforced by ESLint); a module boundary is an additive grouping, not a restructure. |
| Packages / Modules / Entitlements | Additive tables + an entitlement guard; the Release Center deploys the whole platform, entitlements (runtime data) decide what a tenant sees — **no per-customer build**. |
| Roles / Permissions | The Permission Engine (deny-by-default, ancestor-chain resolution, seed-migration grants) is now in real production use (`system.release.*`) — per-module nodes extend it with zero engine change. |
| Multi-tenancy | One deployed system, per-tenant entitlements + data scoping + config. The deploy pipeline is tenant-agnostic (it ships code, not tenant data). |
| Feature limits / integration layer | `foundation/integrations/` already exists (connector pattern); limits are entitlement checks. |

Each is its own future Workstream. This report only asserts: **nothing in the deploy / release /
backup / restore / rollback system needs to change to support them.**

---

## SUMMARY

- **Workspace ↔ Server ↔ Team-B: consistent.** Every runtime path assumption matches the real
  server. No Doc-A-vs-Doc-B path contradiction exists.
- **5 minor discrepancies (R1–R5):** 2 fixed in this pass (`.env.example`, `build-release.sh`
  `scan_secrets`), 2 are doc-alignment corrections filed to Team B (R1, R3), 1 is an operator action
  (R4).
- **7 server-behind-workspace gaps (D1–D7):** all closed by the **one-time** Phase-0 bootstrap.
- **AUTOMATED AFTER BOOTSTRAP: YES** for the release pipeline; a small, deliberate set of human
  gates remains (artifact upload, backup link, acceptance sign-off, secret rotation).
- **Workstream A is NOT closed.** It closes when the Phase-0 bootstrap is applied and PART 8 (S1–S12)
  passes on the real staging DB — specifically `POST /treasury/cash-in` and `POST /deposits/:id/approve`
  succeeding with **no UUID error** after the Controlled Data Repair.
- **v1.0.3 is NOT `SOFTWARE RELEASE = VERIFIED`** until PART 8 passes and is recorded in
  `FINAL_V1.0.3_DEPLOYMENT_REPORT.md`.
- **No file was deleted from the server. No UUID repair was run on staging. The snapshot is
  CONFIDENTIAL.**
