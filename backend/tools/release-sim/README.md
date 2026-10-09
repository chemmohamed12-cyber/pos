# release-sim — local production-path deployment simulation

Drives the **real Release Engine services of the installed build** against a named database, in the official order
`backup → upload → link backup → deploy` (Verified-Backup Gate, preflight, candidate build + verification, artifact integrity, expand/contract scan,
migrations, atomic slot swap, restart trigger, health check, LKG commit). It does **not** start the application — no HTTP, no schedulers — because the
application's background sweeps would touch Company databases, which a deployment simulation must not do. The only layer not exercised is the HTTP controller + auth;
every engine service behind it is the production code.

## Layout (outside the repository)
```
<SIM_ROOT>/                     default D:/DAII-LOCAL-DEPLOY
  deploy/app/                   the ACTIVE slot = the INSTALLED build (dist/, src/, package.json, REAL node_modules)
  deploy/app.next-<id>/         CANDIDATE   deploy/app.prev-<id>/  PREVIOUS (rollback source)   deploy/app.failed-<id>/  FAILED
  host/package.json             engine host cwd; mirrors the INSTALLED version (the engine reads process.cwd()/package.json)
  storage/                      staging, manifests (LAST_KNOWN_GOOD.json), backups
```

## Windows adaptations (environment, not engine behaviour)
- A process cannot rename a directory that is its current working directory → the harness runs from `host/`, never from inside the ACTIVE slot.
- `fs.cp` cannot recreate a junction/symlink without the symlink privilege → the installed tree carries a **real** `node_modules` directory (production uses a
  symlink to the shared nodevenv, which works on Linux).

## Safety
`SIM_TARGET_DB` must equal the `DB_NAME` of the env file — an explicit statement of exactly which database will be upgraded. Credentials are read from
`SIM_ENV_FILE` and never printed.

## Use
```
SIM_ENV_FILE=<.env with DB_*> SIM_TARGET_DB=<db> node tools/release-sim/local-deploy-harness.js info
... backup                          # engine's own pg_dump + verification; prints the backupRunId
... upload <package.zip>            # PackageValidator → release registered as `validated`
... link <releaseId> <backupRunId>  # Verified-Backup Gate: release becomes `backup_verified`
... deploy <releaseId>              # the pipeline; prints final status + every audit event of the release
... events <releaseId>
```
Company fan-out (`RELEASE_COMPANY_MIGRATIONS`) is part of the engine, not of this tool; it is `off` by default. An engine that predates the capability reports
`engineHasCompanyFanout:false` in `info`.
