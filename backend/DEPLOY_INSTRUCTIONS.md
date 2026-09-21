# Deploy Instructions — v1.1.1 Hosting-Test Candidate

**v1.1.0 superseded** — failed real Hosting candidate verification, never activated. Use v1.1.1.

**This package is a Hosting-test release candidate — built and verified
for testing purposes only. It is NOT a production deployment
authorization.** Actual deployment to any live Hosting target happens
only after separate, explicit authorization. This document explains how
to load the package onto a Hosting-test target once that authorization
is given — it does not itself authorize that step.

For the full, incident-derived rules behind every step below (cPanel/
Passenger specifics, why `DB_HOST` must be `127.0.0.1` not `localhost`,
why no migration may ever run `CREATE EXTENSION`, the exact 2026-08-27
outage chain), see `PRODUCTION_DEPLOYMENT_GUIDE.md` — this document is
the release-specific supplement, not a replacement for it.

## What's in the package

Built by the project's own approved release engine
(`tools/build/build-release.sh`) — never a manually-assembled ZIP:

```
Daii-Release-v1.1.1-<date>.zip
├── MANIFEST.json          (machine-readable: version, file checksums,
│                            migration list, runtimeDependencies)
├── dist/                  (compiled backend)
├── src/                   (source, for migrations the compiled
│                            migration-datasource.ts loader reads)
├── public/                (compiled frontend)
├── package.json
└── package-lock.json
```

No `.env`, no `.htaccess`, no `node_modules/`, no test files
(`*.spec.ts`/`*.test.ts` excluded during packaging), no database dump,
no seed/test data — code and migrations only. See `MIGRATION_REPORT.md`
for exactly what schema changes this package will apply.

## Verifying the package before use

The build engine already ran this verification as its own last step
(see `TEST_REPORT.md`), but it can be re-run independently against the
`.zip` at any time:

```bash
bash tools/build/build-release.sh --verify <path-to>/Daii-Release-v1.1.1-<date>.zip
```

Checks: every `MANIFEST.json` file entry exists with a matching
SHA-256, the Metadata Contract (`database.migrationCount`,
`runtimeDependencies`) is internally consistent, every compiled JS file
parses (`node --check`), no backslash paths/`.env`/`node_modules` are
packaged, the frontend bundle is self-consistent, and a secret scan
finds nothing.

## Loading onto a Hosting-test target

1. **Confirm the target is a test/Hosting-test instance, never
   production**, and confirm its database is either fresh (no prior
   DAII schema) or an already-known, disposable test database — never
   restore or point this package at production/recovery data (see
   "Critical Data Rule" below).
2. Extract the package to a **staging directory** on the target, not
   directly on top of any existing Application Root (the exact cause of
   the 2026-08-27 outage — see `PRODUCTION_DEPLOYMENT_GUIDE.md`
   "Troubleshooting").
3. Sync into the target Application Root, excluding `.env`/`.htaccess`
   if either already exists there:
   ```bash
   rsync -a --exclude='.env' --exclude='.htaccess' /path/to/staging/ /path/to/target/approot/
   ```
4. Set environment variables per `PRODUCTION_DEPLOYMENT_GUIDE.md`'s
   table (`NODE_ENV`, `PORT`, `DB_HOST=127.0.0.1`, `DB_PORT`, `DB_USER`,
   `DB_NAME`, `DB_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
   `INTEGRATION_ENCRYPTION_KEY`) — a real, non-dev-default value for
   every starred variable; the app refuses to boot on the dev-default
   literal once `NODE_ENV=production`/a hardened mode is set.
5. Run permissions/environment verification:
   ```bash
   bash backend/tools/deploy/verify-deploy.sh
   ```
6. Run migrations against the target's own database:
   ```bash
   node ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run
   ```
   (or the target's own equivalent invocation — see
   `package.json`'s `migration:run:prod` script). This applies the 8
   new migrations listed in `MIGRATION_REPORT.md`, plus any of the 234
   total this target's database doesn't already have.
7. Restart the application via the target's own supervised-process
   mechanism (cPanel → Setup Node.js App → Restart, or equivalent) —
   never a manual `kill`/direct process restart.
8. Verify: `GET /api/health`, `GET /api/health/db`, `GET
   /api/health/deep`, and confirm the target's own base URL returns
   `HTTP/2 200` (or an expected redirect).

## Critical Data Rule

**Do not move any production or recovered data into this test
candidate unless that is a documented, specific part of a named test.**
This Hosting-test candidate should start from a clean, reproducible test
dataset with defined seed data — never from a copy of live production
or recovery data. This package itself carries no data at all (see
"What's in the package" above); whatever data the target database holds
before migrations run is entirely the responsibility of whoever
provisions that target, not this package.

## Rollback

Keep the target's previous release directory instead of deleting it.
Rollback is: point the Application Root back at the previous release
(or `rsync` it back, same `.env`/`.htaccess` exclusions), then restart.
This is a code/asset rollback only — no migration is auto-reverted;
reverting migrations 8→1 is a separate, deliberate, manual
`migration:revert` sequence and is not expected to be needed for a
Hosting-test candidate (see "Reversibility" in `MIGRATION_REPORT.md`).

## Status

```
BUILD    = PASS
TEST     = PASS
VERIFY   = PASS
PACKAGE  = PASS
RELEASE VERSION = 1.1.1 — ISSUED
HOSTING DEPLOYMENT = WAITING FOR AUTHORIZATION
```
