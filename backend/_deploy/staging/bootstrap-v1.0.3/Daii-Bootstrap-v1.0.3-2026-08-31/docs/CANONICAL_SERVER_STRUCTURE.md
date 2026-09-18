# Daii — Canonical Server Structure

Target layout for `/home/xnexdrgr/daii.xnexustech.com` so every path has
one defined purpose and the deploy/backup/restore automation has stable
anchors. Derived from the real snapshot (`SERVER_BASELINE_REPORT.md`) and
constrained by **CloudLinux + LiteSpeed Passenger** rules.

## Design constraints (non-negotiable on this host)

1. **Passenger `PassengerAppRoot` is a fixed path in `.htaccess`.** Changing
   which directory is "current" by editing `.htaccess` + restarting is
   allowed; a filesystem swap under a fixed path is not observed atomically
   by Passenger.
2. **No symlink-swap `current -> releases/vX` scheme yet.** LiteSpeed/
   Passenger behaviour with a symlinked `PassengerAppRoot` on this plan is
   unverified. Until it is tested on a scratch subdomain, `release-new/`
   stays the literal runtime directory. (Documented as a future item, not
   applied.)
3. The frontend is served from `<AppRoot>/public`, never `frontend/dist`.
4. `node_modules`, `dist`, `.env*`, `*.log`, `storage/` are never in a
   release artifact and never committed.
5. **`release-new/backend/node_modules` is a symlink** to the nodevenv
   `lib/node_modules`. The deploy pipeline must never delete or overwrite
   it; new dependencies are added with `$NPM_BIN install` (which writes
   into the nodevenv), not by shipping `node_modules` in the artifact.

## Canonical tree

```
/home/xnexdrgr/
├── nodevenv/daii.xnexustech.com/release-new/backend/20/bin/{node,npm}   # Passenger Node runtime — RUNTIME_NODE_BIN / RUNTIME_NPM_BIN
│
├── daii.xnexustech.com/                       # docroot (Passenger BaseURI "/")
│   ├── .htaccess                              # Passenger directives ONLY (secrets move to cPanel env UI)
│   ├── .well-known/                           # ACME/SSL — never touched by deploy
│   │
│   ├── release-new/                           # ── CURRENT RELEASE (runtime) ──
│   │   └── backend/                           #    PassengerAppRoot
│   │       ├── dist/                          #    running compiled app  (StartupFile dist/main.js)
│   │       ├── src/                           #    deployed source (traceability + ts-node-free migration CLI not needed here)
│   │       ├── public/                        #    FRONTEND RUNTIME  (index.html + assets/*) — synced from the build
│   │       ├── node_modules/                  #    npm ci output (not in artifact)
│   │       ├── storage/media/                 #    user uploads (RUNTIME DATA — in every backup)
│   │       ├── tmp/restart.txt                #    Passenger restart trigger
│   │       ├── package.json / package-lock.json
│   │       └── tools/                         #    deploy/build/verify scripts
│   │
│   ├── _deploy/                               # ── DEPLOY WORKSPACE (new; created by the pipeline) ──
│   │   ├── incoming/                          #    uploaded Release/Delta .zip lands here
│   │   ├── staging/<release-id>/              #    validated + extracted, pre-publish
│   │   ├── build/<release-id>/                #    build workspace (npm ci --include=dev, tsc, vite) — SEPARATE from runtime
│   │   ├── previous/                          #    last-known-good backend tree (filesystem rollback source)
│   │   ├── manifests/<release-id>.json        #    release manifest as deployed
│   │   └── logs/<release-id>/                 #    per-deploy pipeline logs
│   │
│   ├── archive/                               # ── FROZEN LEGACY (moved, not deleted) ──
│   │   ├── server-root-backend-2026-08/       #    old server-root backend/ (35k files)
│   │   ├── release-v1.0.2-staging/            #    old staging tree (34k files)
│   │   ├── frontend-v1.0.2-staging/
│   │   └── incoming-artifacts/                #    backend.zip, Daii_Final_Release_*.zip, Daii-Frontend-v1.0.2.zip
│   │
│   └── docs/                                  # one canonical copy of architecture/ planning/ MASTER_*.md
│
└── backups/daii/                              # ── BACKUPS (outside the docroot) ──
    ├── db/<backup-run-id>.dump                #    pg_dump -Fc
    ├── fs/<TS>.tar.gz                         #    MANUAL Phase-0 whole-tree filesystem snapshot (BACKUP_RESTORE_RUNBOOK §1c)
    ├── app-snapshots/<release-id>/            #    Release Center per-file pre-deploy snapshot (rollback source — ROLLBACK_RUNBOOK §1.2)
    ├── media/<backup-run-id>.tar.gz           #    storage/media archive
    ├── manifests/<backup-run-id>.json         #    backup manifest (version, migration head, artifact SHA256s)
    └── server-snapshots/                      #    full-server baseline snapshots (CONFIDENTIAL)
```

## Path → config-key map

The application already reads (or will read after the v1.0.3 delta):

| Purpose | Config key | Production value |
|---|---|---|
| Passenger app root | `RELEASE_APP_ROOT` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` |
| Frontend runtime | `FRONTEND_RUNTIME_PATH` | `<RELEASE_APP_ROOT>/public` |
| Passenger restart | `PASSENGER_RESTART_FILE` | `<RELEASE_APP_ROOT>/tmp/restart.txt` |
| Deploy staging | `RELEASE_STAGING_PATH` | `/home/xnexdrgr/daii.xnexustech.com/_deploy/staging` |
| Backup storage | `RELEASE_BACKUP_STORAGE_PATH` | `/home/xnexdrgr/backups/daii` |
| Node / npm | `NODE_BIN` / `NPM_BIN` | `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/{node,npm}` |
| pg_dump / pg_restore | `PG_DUMP_BIN` / `PG_RESTORE_BIN` | absolute CloudLinux path (confirm with `which pg_dump` on host) |
| Build thread cap | `RELEASE_BUILD_MAX_THREADS` | `2` |

## Migration from today's layout (safe order — no runtime interruption)

1. Create `_deploy/{incoming,staging,build,previous,manifests,logs}` and
   `archive/`, `backups/daii/{db,fs,media,manifests}`. (mkdir only.)
2. `cp -a release-new/backend` → `_deploy/previous/backend` (first rollback
   baseline).
3. **Move** (not copy) the LEGACY items into `archive/` one at a time,
   re-checking references after each: server-root `backend/`, `frontend/`,
   `release-v1.0.2-staging/`, `frontend-v1.0.2-staging/`, the four root
   `*.zip` artifacts. Full procedure + reference checks: `CLEANUP_REPORT.md`.
4. De-duplicate the doc trees → keep `docs/` only.
5. Set the new env keys via cPanel "Setup Node.js App → Environment
   variables" (NOT `.htaccess`), and move the existing secret `SetEnv`
   lines there too.
6. Nothing about `release-new/`, `.htaccess` Passenger directives, or
   `.well-known/` changes in this migration.

## Not done in this pass (needs a scratch-subdomain test first)

- `releases/<version>` + atomic `current` swap. Requires confirming
  Passenger follows a symlinked `PassengerAppRoot` and picks up the swap on
  restart without a stale cache. Until then `release-new/` is the runtime
  and a deploy updates it in place (with `_deploy/previous/` as the
  filesystem rollback).
