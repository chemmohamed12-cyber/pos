# Daii — Server Baseline Report

**Reference snapshot:** `Daii-Server-Full-Snapshot-2026-08-31.tar.gz`
(130 MB, cPanel File Manager archive of `/home/xnexdrgr/daii.xnexustech.com`).
Handover states SHA256 `cfb6031954d39d851d6050c64561c6bcd62841716b57aa603842bce008e6865d`
— **the value in the handover text is 62 chars (malformed / truncated in
transcription); recompute and record the real 64-char digest when the
canonical copy is confirmed.** This analysis was done on the pre-extracted
working copy alongside the archive; the archive itself was not modified.

**Environment (confirmed from the snapshot, matches the handover):**

| | Value |
|---|---|
| Host | CloudLinux + LiteSpeed + Passenger (`/usr/local/lsws/fcgi-bin/lsnode.js`) |
| Application root (Passenger) | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` |
| Node runtime (Passenger) | `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node` — Node 20.20.2, npm 10.8.2 |
| Startup file | `dist/main.js` |
| Static/SPA root | `<AppRoot>/public` (`app.useStaticAssets(process.cwd()+'/public')` in `main.ts`; `process.cwd()` == AppRoot under Passenger) |
| DB | PostgreSQL 10.x, `127.0.0.1:5432`, database `xnexdrgr_daii_staging`, user `xnexdrgr_daii_app2` — **staging / disposable test data** |
| Env delivery | LiteSpeed `SetEnv` block inside `.htaccess` (there is **no** `backend/.env` on the host) |

---

## 1. Directory inventory (`/home/xnexdrgr/daii.xnexustech.com`)

| Path | Files | Classification | Notes |
|---|---:|---|---|
| `release-new/` | 2,321 | **RUNTIME (active release)** | Passenger points here. `backend/` + `frontend/` + doc trees. |
| `release-new/backend/dist/` | 982 | **RUNTIME** | The running compiled app. |
| `release-new/backend/src/` | 374 | SOURCE | Deployed source (v1.0.3, pre-hardening — see §3). |
| `release-new/backend/public/` | 5 | **RUNTIME (frontend)** | `index.html` + `assets/index-DtuYiAhd.js` + `index-j2WWxJ8K.css` + `favicon.svg` + `icons.svg`. Matches `release-new/frontend/dist/` exactly (bundle IS synced). |
| `release-new/backend/node_modules/` | 0 in snapshot | RUNTIME (**symlink**) | **`node_modules` is a SYMLINK** → `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/lib/node_modules`. The `tar` failed to recreate it on extraction ("Cannot create symlink … No such file or directory"), which is why the working copy shows it empty. A release artifact must **never** contain `node_modules` and a deploy must **never** overwrite this symlink; new dependencies are installed with `npm install` (via `$NPM_BIN`) so they land in the nodevenv lib. |
| `release-new/backend/public.pre-v1.0.3/` | 5 | BACKUP | Pre-v1.0.3 frontend bundle. Keep as rollback evidence. |
| `release-new/backend/public.backup.20260829-205543/` | 2 | BACKUP | Older public snapshot. Keep. |
| `release-new/backend/storage/media/` | 1 | **RUNTIME (user data)** | 1 real uploaded file (`*-OIP.webp`). Must be in the backup set. |
| `release-new/backend/tmp/restart.txt` | 1 | RUNTIME | Passenger restart trigger — **exists**, so a deploy touches (not creates) it. |
| `release-new/backend/tools/` | 9 | SOURCE | `verify-deploy.sh`, `check-dist-integrity.js`, `validate-structure.js`, `generate-domain.js`, `data-repair/*` (incl. both deferred migrations). **Does NOT contain** `tools/build/build-release.sh` or `tools/deploy/check-frontend-bundle.sh` — the v1.0.3 hardening is not deployed. |
| `release-new/backend/stderr.log` | — | LOG | 34 KB. Historical boot errors — see §4. Not source; `.gitignore`d. |
| `backend/` (server root) | **35,410** | **LEGACY** | Pre-`release-new` backend, *with* `node_modules`. Not the runtime. Candidate for archival once confirmed unreferenced. |
| `frontend/` (server root) | 103 | **LEGACY** | Pre-`release-new` frontend source. Not the runtime. |
| `release-v1.0.2-staging/` | **33,782** | **LEGACY** | Old staging tree with `node_modules`. Largest single space consumer. Archive candidate. |
| `release-v1.0.3-staging/` | 98 | STAGING (recent) | `Daii-Hotfix-Delta-2026-08-30/` + its `.zip`. The v1.0.3 delta as delivered. |
| `frontend-v1.0.2-staging/` | 107 | **LEGACY** | Old frontend staging. Archive candidate. |
| `backend.zip`, `Daii-Frontend-v1.0.2.zip`, `Daii_Final_Release_2026-08-25.zip`, `Daii_Final_Release_20260828.zip` (server root) | — | **LEGACY (incoming artifacts)** | Old upload artifacts left in place. Move to a dedicated `artifacts/` area. |
| `architecture/` (41), `planning/` (26), `_source-audits/` (4), `docs/` (1), `MASTER_*.md`, `README.md`, `FINAL_RELEASE_REPORT.md`, `LOCAL_*.md` | — | REFERENCE (docs) | Duplicated at server root **and** in `release-new/`. Keep one canonical copy. |
| `.htaccess` | — | **RUNTIME (config + SECRETS)** | Passenger config + `SetEnv` env vars — see §5. |
| `.well-known/pki-validation/` | 1 | **REQUIRED** | SSL/ACME domain validation. Do not touch. |
| `cgi-bin/` | 0 | REQUIRED (cPanel default) | Empty; leave. |
| `.claude/launch.json` | 1 | UNUSED (dev tooling) | Harmless. |
| `import-template.xlsx` | 1 | REFERENCE | Sample import file. |
| `.gitignore` | — | SOURCE | Excludes `dist/`, `node_modules/`, `.env*`, `*.log`, `backend/storage/`, and an `احمد/` folder flagged as possibly-sensitive real business data. |

**Nothing is marked for deletion.** LEGACY items are archival candidates
only, and only after a reference check (see `CLEANUP_REPORT.md`). Per the
CTO directive, `UNKNOWN` is never deleted — there are currently no `UNKNOWN`
items; the classification above is evidence-based.

**One symbolic link exists on the host:** `release-new/backend/node_modules`
→ the nodevenv `lib/node_modules` (see the table row above). The snapshot
`tar` could not recreate it, so the extracted working copy has no live
symlink and IS safe on Windows — but the **deploy pipeline must preserve
that symlink on the host** (never `rm -rf node_modules`, never extract an
archive over it). No other symlinks in the tree.

---

## 2. Passenger / `.htaccess` (current, working)

```
PassengerAppRoot     "/home/xnexdrgr/daii.xnexustech.com/release-new/backend"
PassengerBaseURI     "/"
PassengerNodejs      "/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node"
PassengerAppType     node
PassengerStartupFile dist/main.js
```

`main.ts` registers `app.useStaticAssets(process.cwd()+'/public')` and an
Express `get('*')` SPA fallback to `public/index.html` excluding `/api/*`
(Hotfix 4). This is present in the deployed `release-new/backend/src/main.ts`
— PART 1 §6 concern is satisfied in the running release, not only in the delta.

---

## 3. CRITICAL — deployed source still has the unsafe migrations glob

`release-new/backend/src/database/data-source.ts` (and its compiled
`dist/database/data-source.js`) on the server:

```js
migrations: [`${__dirname}/migrations/*{.ts,.js}`]   // BARE STAR
```

This is **not** the digit-anchored `[0-9]*` fix. `extension-dependencies.spec.ts`
is present in `src/database/migrations/` on the server, so a `ts-node`
`npm run migration:run` there **will** try to type-check it →
`Cannot find name 'describe'` (exactly PART 1 §15/§16). The running app is
unaffected (`tsconfig.build.json` keeps the spec out of `dist/`), but the
CLI migration path is broken on the host today.

**Fix (workspace, ready to ship):** `data-source.ts` now uses
`migrations/[0-9]*{.ts,.js}`; a new `migration:run:prod` script runs the
TypeORM CLI against the **compiled** `dist/database/data-source.js` (no
`ts-node`), and `migration-glob.spec.ts` guards all three glob sites.

---

## 4. Historical incidents visible in `stderr.log` (all since resolved)

1. `Cannot find module '.../release-new/backend/backend/dist/main.js'` — note
   the **doubled `backend/backend/`**. A prior `.htaccess` had
   `PassengerStartupFile backend/dist/main.js` against
   `PassengerAppRoot .../release-new/backend`. The current `.htaccess`
   (`dist/main.js`) is correct.
2. `QueryFailedError: relation "users" does not exist` on `AuthController.register`
   and `relation "stock_reservations" does not exist` on the preliminary-hold
   scheduler — dated 2026-08-29, **before** the v1.0.3 migrations ran. This is
   the class of gap `verify-deploy.sh`'s schema-readiness check exists to
   catch pre-restart.

These are the exact failure categories the hardened deploy pipeline now
gates on (pre-deploy: schema readiness; post-deploy: health check +
frontend-bundle check + strict UUID check).

---

## 5. SECURITY FINDINGS (act before real production data)

The `.htaccess` `SetEnv` block stores **plaintext secrets** on disk:
`DB_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`INTEGRATION_ENCRYPTION_KEY`. Values are **not reproduced here** (this file
is shareable; the snapshot is CONFIDENTIAL and must never reach Git/public
storage).

1. **`JWT_REFRESH_SECRET` and `INTEGRATION_ENCRYPTION_KEY` are set to the
   same value.** These must be independent — a leak of one otherwise
   compromises the other. Rotate both to distinct 32+ char random values.
2. `JWT_ACCESS_SECRET` is ~39 chars (passes the 32-min rule) but is a
   guessable pattern, not random material. Rotate.
3. Secrets in `.htaccess` are world-readable to anything that can read the
   docroot and survive in the snapshot. Prefer cPanel's "Setup Node.js App
   → Environment variables" UI (which the app already supports — no
   `backend/.env` needed) and keep `.htaccess` to Passenger directives only.
4. When these are rotated, **all issued JWTs are invalidated** (users
   re-login) and any integration-connector credentials encrypted with the
   old key must be re-entered. Do this now, while data is disposable.

Rotation is an **operator action on the host** — not something this
codebase change performs.

---

## 6. Node/npm on PATH (PART 1 §4, §7, §8, §14)

`npm` / `node` are **not** on the host's default `PATH`; the correct
runtime is `.../nodevenv/.../20/bin/`. The manual v1.0.3 build hit
`bash: npm: command not found`, `tsc: command not found` (prod-only
`node_modules`), and `/usr/bin/env: node: Permission denied`.

**Fix (workspace):** `NODE_BIN` / `NPM_BIN` config keys (default to the
nodevenv absolutes in production via `.env.example`), and
`tools/build/build-release.sh` which uses `$NODE_BIN` / `$NPM_BIN`
explicitly, runs `npm ci --include=dev` for the frontend, and exports
`RAYON_NUM_THREADS=$RELEASE_BUILD_MAX_THREADS` (default 2) for the Rolldown
EAGAIN issue (PART 1 §9).

---

## 7. What is NOT on the server yet

The entire **Release Center** (`src/foundation/release/` — Backup, Restore,
Release Execution, Data Repair) does **not exist** in the deployed
`release-new/backend/src/foundation/` (21 submodules, no `release`). It
ships to the host for the first time in the next delta. Until then, backup /
restore / rollback on the host are the manual `pg_dump` / `tar` procedures
in `BACKUP_RESTORE_RUNBOOK.md` / `ROLLBACK_RUNBOOK.md`.
