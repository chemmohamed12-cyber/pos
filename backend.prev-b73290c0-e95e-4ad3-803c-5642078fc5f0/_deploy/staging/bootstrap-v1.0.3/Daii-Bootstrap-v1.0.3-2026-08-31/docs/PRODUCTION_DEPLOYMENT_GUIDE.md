# Daii — Production Deployment Guide (cPanel / Passenger)

Written after the 2026-08-27 `daii.xnexustech.com` production outage. See
"Troubleshooting" at the end for the full incident chain — every rule in
this document exists because one of those steps went wrong on that
deployment. `planning/v1-release/DEPLOYMENT_GUIDE.md` covers the
generic build/migrate/start sequence; this document covers the
cPanel/Passenger-specific hosting layer on top of it.

## Production architecture

- Hosting: cPanel shared hosting (Namecheap **Shared Stellar Plus**
  plan, confirmed by Namecheap support 2026-08-28), app served through
  **Phusion Passenger** under LiteSpeed/Apache via cPanel's **"Setup
  Node.js App"** feature.
- Runtime: Node.js 20, selected in that same cPanel UI.
- Database: PostgreSQL, same host, reached over TCP loopback (not a
  Unix socket) — see "Database connection" below. **No PostgreSQL
  contrib extensions are available on this plan** — no `pgcrypto`, no
  `uuid-ossp` (confirmed: missing `.control` files, not a permissions
  restriction) — see "UUID generation strategy" below. Do not add a
  migration that assumes any extension is installable here without
  re-confirming with the hosting provider first.
- The Node process is **spawned and supervised by Passenger**, not by a
  process manager (no PM2/systemd unit). It is never started by hand in
  production.

## cPanel configuration (Setup Node.js App)

| Setting | Value |
|---|---|
| Application Root | the domain's document root, e.g. `/home/<user>/daii.xnexustech.com` |
| Application URL | `daii.xnexustech.com` |
| Application Startup File | `backend/dist/main.js` |
| Node.js version | 20 |
| Environment Variables | see table below — entered in this same UI |

**Node runtime note:** don't assume `node`/`npm` are on `PATH` in a bare
SSH shell on this host — they are not, by default. cPanel's Node
Selector provisions a dedicated virtualenv-style directory
(`~/nodevenv/<app>/<version>/`); its `bin/activate` script is for manual
SSH use only (`source ~/nodevenv/.../bin/activate`) and has no bearing
on how Passenger itself spawns the app in production. Never use a
manual `node backend/dist/main.js` invocation to "test" the production
app — it bypasses Passenger's spawn path entirely and will behave
differently (see "Troubleshooting").

## Environment variables required in production

Setting `NODE_ENV=production` triggers strict validation
(`src/foundation/configuration/configuration.schema.ts`) — the app
refuses to boot with a missing/invalid value for any starred variable,
with a message that explicitly identifies it as an environment problem
(see `configuration.module.ts`).

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PORT` | yes | must match what Passenger expects to proxy to |
| `DB_HOST` | yes | **`127.0.0.1`, not `localhost`** — see below |
| `DB_PORT` | yes | `5432` |
| `DB_USER` / `DB_NAME` | yes | must match the PostgreSQL role/database **exactly**, character for character — see "Troubleshooting" |
| `DB_PASSWORD` * | yes | real value; the literal `daii_dev_only` is rejected in production |
| `JWT_ACCESS_SECRET` * | yes | 32+ chars; dev-default literal rejected in production |
| `JWT_REFRESH_SECRET` * | yes | 32+ chars; dev-default literal rejected in production |
| `INTEGRATION_ENCRYPTION_KEY` * | yes | 32+ chars; dev-default literal rejected in production |
| `JWT_ACCESS_TTL_SECONDS` | no | defaults to 900 |
| `JWT_REFRESH_TTL_DAYS` | no | defaults to 30 |
| `MEDIA_STORAGE_PATH` | no | defaults to `./storage/media` |

**Why `DB_HOST=127.0.0.1` and never `localhost`:** Node.js 17+ resolves
`localhost` to the IPv6 loopback address (`::1`) first. If the host's
PostgreSQL/`pg_hba.conf` isn't configured for an IPv6 connection (common
on shared hosting), this produces exactly:
```
no pg_hba.conf entry for host "::1", user "...", database "...", SSL off
```
Using the literal IPv4 address sidesteps the DNS resolution step
entirely.

**Why exact DB_USER/DB_NAME spelling matters:** cPanel's PostgreSQL
Databases wizard auto-manages `pg_hba.conf` entries scoped to the exact
role/database names it creates. A value that's off by even one
character (e.g. a transposed/missing letter) won't match that
auto-provisioned entry, and Postgres reports the same generic
`"no pg_hba.conf entry for host ..., user ..., database ..."` error as
a genuine host-access-policy problem — it is not always that; verify the
literal string first (cPanel → PostgreSQL Databases page) before
assuming `pg_hba.conf` itself needs a hosting-provider change.

## UUID generation strategy

Namecheap Shared Stellar Plus does not provide the `pgcrypto` or
`uuid-ossp` PostgreSQL contrib extensions — confirmed by Namecheap
support 2026-08-28 (`pg_available_extensions` returns zero rows for
`pgcrypto`; `CREATE EXTENSION` fails with a missing `.control` file, not
a permissions error).

**Production is PostgreSQL 10.23** (confirmed live via `SHOW
server_version;`, 2026-08-28) — not 13+. `gen_random_uuid()` only
became a PostgreSQL **core** built-in in v13, so it does not exist here
either, extension or no extension (confirmed live: `SELECT
gen_random_uuid();` on production fails with `function
gen_random_uuid() does not exist`). The fix below does **not** depend
on PostgreSQL version at all — do not reintroduce a
"core since PG13" assumption in a future change without re-confirming
the server version first.

Every UUID primary-key default in this codebase uses one of two
functions, and **neither requires an extension or a specific PG
version**:

- **`gen_random_uuid()`** — defined as a plain SQL function directly in
  `1755840100000-CreateUsers.ts` (the first migration that needs it),
  using only `md5()`, `random()`, and `clock_timestamp()` — core SQL
  functions present in every PostgreSQL version back to well before
  v10. This is what replaced the original
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` line. It's safe even on a
  server where a real `gen_random_uuid()` already exists (core PG13+,
  or `pgcrypto` installed): `pg_catalog` is always searched before
  `public` for an unqualified call, so the genuine one wins there and
  this definition simply goes unused — no conflict either way. Used
  directly by ~29 migrations after `CreateUsers`, none of which needed
  any edit.
- **`uuid_generate_v4()`** — normally supplied by `uuid-ossp`. Four
  migrations predate this fix and call it directly
  (`CreateTreasuryTables`, `AddTreasuryAccountTypeHierarchy`,
  `AddReturnsEngineCustomerReturns`, `AddCustomerFinancialCore`) — none
  of them, nor anything else in the repo, ever ran
  `CREATE EXTENSION "uuid-ossp"` (a latent defect independent of the
  hosting restriction, simply never triggered before). Rather than edit
  four already-written migrations,
  `1755840150000-UuidGenerateV4Compatibility.ts` defines
  `uuid_generate_v4()` as a plain SQL wrapper over `gen_random_uuid()`
  (the one defined above). This is a **compatibility function, not an
  extension** — it produces a random UUID identically to the real
  thing, which is all every call site in this codebase needs (a unique
  primary key, never a specific-version UUID guarantee).

**Rule for future migrations:** never add `CREATE EXTENSION` for
anything, and never assume a PostgreSQL version without checking
production's actual `SHOW server_version;` first. Use `gen_random_uuid()`
for new UUID primary keys — it's already proven to work here and needs
nothing installed. A regression test
(`src/database/migrations/extension-dependencies.spec.ts`) fails CI if
any migration introduces `CREATE EXTENSION` or calls a known
extension-only function (`crypt`, `digest`, `hmac`, `pgp_sym_encrypt/
decrypt`, `uuid_generate_v1/v3/v5`, `unaccent`, `similarity`, etc.)
without that extension being added to the test's explicit approved
list — which requires re-confirming hosting support first, the same way
this incident should have been caught before reaching production.

## Permissions model

Permissions are a **deployment-layer responsibility, not application
code** — do not add `chmod` calls to `src/`. `tools/deploy/verify-deploy.sh`
(below) is the one place this is enforced, and it only ever sets:

- `755` on directories under `backend/` that the web server must
  traverse (`backend`, `backend/src`, `backend/dist`, and their
  subtrees, `backend/tools`).
- `644` on files, including any `.htaccess` LiteSpeed/Passenger reads
  along that path.

Never run a recursive `chmod -R 777`, and never change permissions on
`.env`, credentials, or anything under `storage/`.

## Deployment procedure

1. Build locally / in CI: `cd backend && npm run build` (produces
   `dist/`), `cd frontend && npm run build`.
2. Package the release **without** anything server-specific:
   `.env`, `.htaccess`, `node_modules/`. (`.gitignore` already excludes
   `.env`/`dist`/`node_modules` from the repo; make sure the release
   packaging step excludes them from the ZIP too, or excludes them from
   the extraction target — see next point.)
3. Deploy by extracting to a **staging directory**, then syncing into
   the live Application Root with `.env` and `.htaccess` excluded, e.g.:
   ```bash
   rsync -a --exclude='.env' --exclude='.htaccess' /path/to/staging/ /home/<user>/daii.xnexustech.com/
   ```
   Extracting a release ZIP **directly on top of** the Application Root
   is what caused the 2026-08-27 outage (see "Troubleshooting") — it
   silently deleted the production `.env`/`.htaccess` along with
   whatever permissions were previously set.
4. Run `bash backend/tools/deploy/verify-deploy.sh` (see below).
5. Restart **only** via cPanel → Setup Node.js App → the app → **Restart**.
   Never `kill`/`pkill` the Passenger-managed process directly.

## Rollback procedure

Keep the previous release's extracted directory (e.g.
`releases/2026-08-25/`) instead of deleting it on the next deploy.
Rollback is: point the Application Root at the previous release
directory (or `rsync` it back over the live path, same `.env`/`.htaccess`
exclusions as above), then Restart via cPanel. This is a code/asset
rollback only — no migration is ever auto-reverted (`migration:revert`
is a separate, deliberate, manual step; see the general deployment
guide) and no production data is touched by any of the above.

## Verification (post-deploy, required before calling a release done)

- `GET /api/health` — shallow boot-proof (process is up).
- `GET /api/health/db` — real round-trip query against Postgres.
- `GET /api/health/deep` — full component health (`src/foundation/observability/health.service.ts`);
  returns `{ status, components }`, never a secret value.
- `curl -I https://daii.xnexustech.com` — must return `HTTP/2 200` (or
  `301`/`302` only if that's the expected redirect chain to the app).
- Database schema readiness (read-only `to_regclass` checks) and both
  UUID functions (`SELECT gen_random_uuid();`, `SELECT uuid_generate_v4();`)
  — see "UUID generation strategy" above for why these are checked
  explicitly rather than inferred from HTTP 200.

`tools/deploy/verify-deploy.sh` runs all of the above in sequence —
application path, permissions, environment file presence, schema/UUID
readiness, then post-restart health/HTTP — and fails loudly (non-zero
exit) if any step doesn't pass. A release isn't done until this script
exits `0`.

## Troubleshooting — 2026-08-27 incident chain (read this before assuming a new bug)

The production outage that prompted this document had **three
independent, stacked causes**, diagnosed in this order:

1. **`.htaccess` files under `backend/src`, `backend/dist`, and
   `backend/tools` were unreadable by LiteSpeed (`Permission denied`)**
   after a ZIP extraction. This blocked every request at the
   web-server layer — Passenger never even got a chance to spawn the
   Node process. This is why `ps aux | grep backend/dist/main.js`
   showed nothing at every prior check: the app was never reached, not
   "crashing invisibly." **Fix:** the permissions step in the
   deployment procedure above; never skip it after extracting a ZIP.
2. Once permissions were fixed and the domain was actually hit through
   Passenger (not tested via a manual SSH `node dist/main.js`, which
   proves nothing about the production path), the cPanel-configured
   environment variables **did** reach the process correctly — the
   earlier "env vars not reaching NestJS" hypothesis was a red herring
   caused entirely by cause #1: no request had ever actually gone
   through Passenger's spawn path yet.
3. With the app running, `DB_HOST=localhost` resolved to `::1` and
   PostgreSQL rejected it — see "Why `DB_HOST=127.0.0.1`" above. A
   separate, one-character discrepancy between the configured
   `DB_USER`/`DB_NAME` and the actual PostgreSQL role/database names was
   also found and corrected during the same investigation — see "Why
   exact DB_USER/DB_NAME spelling matters" above.

**Lesson embedded in this document:** don't jump to `pg_hba.conf`/SSL/
socket-path theories, and don't ask the hosting provider to change
server-level Postgres config, before ruling out (a) a permissions
regression from the last ZIP deploy, and (b) an exact-string mismatch
between configured and actual DB identifiers. Both are self-serviceable
and were the actual causes here; neither required a hosting-provider
ticket.

## Troubleshooting — 2026-08-27/08-28 migration blocker: `pgcrypto`/`uuid-ossp`

After the above was resolved, `npm run migration:run` reached
`CreateUsers1755840100000` and failed:
```
could not open extension control file /usr/share/pgsql/extension/pgcrypto.control:
No such file or directory
```
Namecheap confirmed `pgcrypto` is not available on Shared Stellar Plus
hosting — this is a missing OS-level contrib package, not a permissions
or `pg_hba.conf` issue (a permissions problem reads differently:
`permission denied to create extension`). See "UUID generation
strategy" above for the fix (remove the `CREATE EXTENSION` line;
`gen_random_uuid()` is core since PG13) and the separate `uuid-ossp`
latent defect it also surfaced. **Do not upgrade to VPS over this** —
the fix is a source-level compatibility change, not an infrastructure
limitation; only escalate to a hosting-tier change if a future
capability is proven to have no in-core or wrapper-function equivalent.

---

## v1.0.3 deployment hardening — real server layout & the automated path

The v1.0.3 hand-deployment surfaced a set of operational gaps
(`DEPLOYMENT_INCIDENT_CASE_STUDY_01.md` maps each one to its guardrail).
The real runtime facts, now encoded as config instead of tribal knowledge:

| Fact | Value | Config key |
|---|---|---|
| Application root | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend` | `RELEASE_APP_ROOT` |
| Passenger startup file | `dist/main.js` | (`.htaccess` `PassengerStartupFile`) |
| Node runtime | `/home/xnexdrgr/nodevenv/daii.xnexustech.com/release-new/backend/20/bin/node` (v20.20.2, npm 10.8.2) | `NODE_BIN` / `NPM_BIN` |
| **Frontend serving path** | `<app root>/public` — **NOT** `frontend/dist` | `FRONTEND_RUNTIME_PATH` |
| Passenger reload trigger | `<app root>/tmp/restart.txt` (touch to reload) | `PASSENGER_RESTART_FILE` |
| `pg_dump` / `pg_restore` | must be the absolute host path in prod | `PG_DUMP_BIN` / `PG_RESTORE_BIN` |
| Frontend build thread cap | `2` (Rolldown/Rayon EAGAIN fix) | `RELEASE_BUILD_MAX_THREADS` → `RAYON_NUM_THREADS` |

### Building a release

```bash
bash tools/build/build-release.sh --package-type delta --base-version 1.0.2
```

Produces a `MANIFEST.json`-based package the Release Center loads directly.
It uses `$NODE_BIN`/`$NPM_BIN` (never a bare `node`/`npm`), runs the frontend
`npm ci --include=dev`, exports `RAYON_NUM_THREADS`, places the frontend
build under `public/`, enforces `/`-only paths and `755`/`644` perms, and
self-verifies (`build-release.sh --verify <zip>`).

### Migrations in production

Use the **compiled** data source, never ts-node:

```bash
npm run migration:show:prod    # what's pending
npm run migration:run:prod     # dist/database/data-source.js
```

### Post-deploy verification

```bash
bash tools/deploy/verify-deploy.sh https://daii.xnexustech.com
bash tools/deploy/check-frontend-bundle.sh \
  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/public \
  /home/xnexdrgr/daii.xnexustech.com/release-new/frontend/dist
```

`verify-deploy.sh` now: strict RFC4122 check on `gen_random_uuid()` /
`uuid_generate_v4()` (a UUID-shaped-but-non-compliant result **fails**);
a legacy non-compliant primary-key census (warning — points at the
Controlled Data Repair); and the frontend runtime bundle check.

### The UUID data repair

Existing rows created before `1755852500000` have non-RFC4122 primary keys
(that is why `accountId/treasuryAccountId must be a UUID` persists). Fix them
with the **Controlled Data Repair** — `DATA_REPAIR_RUNBOOK.md` (rehearse on a
scratch DB with `tools/data-repair/scratch-rehearsal.sh` first). Do NOT
weaken `@IsUUID()`.
