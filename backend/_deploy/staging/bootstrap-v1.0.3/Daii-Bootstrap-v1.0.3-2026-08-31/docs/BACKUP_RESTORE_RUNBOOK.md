# Daii — Backup & Restore Runbook

Two ways to back up / restore, matching the two deployment phases:

- **Manual** (Phase 0, before the Release Center exists on the host).
- **Release Center** (`BackupManagerService` / `RestoreManagerService`,
  after bootstrap).

A backup is **never** considered valid because a file was created — it is
valid only after `pg_restore --list` parses it and its recorded SHA-256
still matches (CTO directive; `BackupManagerService.verifyArtifact`).

Storage root: `/home/xnexdrgr/backups/daii/` (outside the docroot).

---

## 1. Manual backup (Phase 0)

```bash
cd /home/xnexdrgr/daii.xnexustech.com
TS=$(date -u +%Y%m%d_%H%M%S)
mkdir -p /home/xnexdrgr/backups/daii/{db,fs,media,manifests}

# 1a. Database (custom format)
PGPASSWORD="$DB_PASSWORD" "$PG_DUMP_BIN" -h 127.0.0.1 -U xnexdrgr_daii_app2 -Fc \
  -f /home/xnexdrgr/backups/daii/db/daii_staging_${TS}.dump  xnexdrgr_daii_staging

# 1b. Verify it (MANDATORY — no verify, no backup)
"$PG_RESTORE_BIN" --list /home/xnexdrgr/backups/daii/db/daii_staging_${TS}.dump | head

# 1c. Application filesystem (source + build + served frontend — NOT node_modules)
tar -czf /home/xnexdrgr/backups/daii/fs/release-new-backend_${TS}.tar.gz \
  -C release-new/backend  --exclude=node_modules --exclude='*.log'  src dist public package.json package-lock.json .htaccess

# 1d. User uploads
tar -czf /home/xnexdrgr/backups/daii/media/media_${TS}.tar.gz \
  -C release-new/backend/storage  media

# 1e. Checksums + a manifest
cd /home/xnexdrgr/backups/daii
for f in db/*_${TS}.dump fs/*_${TS}.tar.gz media/*_${TS}.tar.gz; do sha256sum "$f"; done | tee manifests/${TS}.sha256
cat > manifests/${TS}.json <<JSON
{ "schema":"daii.backup-manifest/1", "timestamp":"${TS}",
  "database":"xnexdrgr_daii_staging",
  "migrationHead":"$(PGPASSWORD=$DB_PASSWORD "$PG_DUMP_BIN" --version >/dev/null; PGPASSWORD=$DB_PASSWORD psql -h 127.0.0.1 -U xnexdrgr_daii_app2 -d xnexdrgr_daii_staging -tAc "select name from migrations order by timestamp desc limit 1")",
  "node":"$($NODE_BIN -v)", "artifacts":["db/daii_staging_${TS}.dump","fs/release-new-backend_${TS}.tar.gz","media/media_${TS}.tar.gz"] }
JSON
```

**Naming convention** (PART 1 §14): `daii_<db-or-fs-or-media>_<base>_pre_<target>_<UTC-timestamp>`
for deploy-related backups; the Release Center uses `<backupRunId>` as the
stem and links the human context in `manifests/<runId>.json`.

## 2. Manual restore (Phase 0)

```bash
# 2a. SAFETY backup of current state FIRST (§1, tag it *_pre_restore_*)
# 2b. Database — restore ON TOP of the existing DB (no DROP DATABASE)
PGPASSWORD="$DB_PASSWORD" "$PG_RESTORE_BIN" -h 127.0.0.1 -U xnexdrgr_daii_app2 \
  -d xnexdrgr_daii_staging --clean --if-exists  <the>.dump
# 2c. Filesystem
cd /home/xnexdrgr/daii.xnexustech.com/release-new/backend
mv src src.broken && mv dist dist.broken && mv public public.broken
tar -xzf /home/xnexdrgr/backups/daii/fs/release-new-backend_<TS>.tar.gz
# node_modules symlink is untouched (not in the archive)
# 2d. Media (only if it changed)
tar -xzf /home/xnexdrgr/backups/daii/media/media_<TS>.tar.gz -C storage
# 2e. Restart + verify
touch tmp/restart.txt
bash tools/deploy/verify-deploy.sh
```

`--clean --if-exists` drops each object before recreating it — the
connection, role, and grants on `xnexdrgr_daii_staging` are untouched.

## 3. Release Center backup (Phase 1)

```
POST /api/release/backups                          → BackupRun (db + media artifacts, verified)
GET  /api/release/backups/:id                      → run + artifacts (status must be "verified")
POST /api/release/backups/artifacts/:artifactId/verify   → re-verify on demand
```
Writes `db/<runId>.dump`, `media/<runId>.tar.gz`, `manifests/<runId>.json`
(with migration head, Node version, artifact SHA256s). Retention never
drops below the 3 most recent runs regardless of age.

## 4. Release Center restore (Phase 1) — two deliberate calls

```
POST /api/release/backups/:backupRunId/restore/preflight   → RestoreOperation (read-only;
      re-checks file exists + checksum still matches; 15-min confirmation window)
POST /api/release/restores/:id/confirm                     → takes a FRESH pre_restore_safety
      backup, THEN pg_restore --clean --if-exists, THEN a minimal post-restore query
```
Restore can never be a one-click accident — two calls, a real preflight
report to read, a bounded window, and a safety backup before the
destructive step.

## 5. Restore TEST (mandatory before trusting the system — PART 2 §14)

On staging (data is disposable):
1. `POST /api/release/backups` → note `runId`, confirm `verified`.
2. Change something visible (create a customer via the UI).
3. `preflight` + `confirm` the restore of that `runId`.
4. Confirm the customer from step 2 is **gone** and the app still boots,
   logs in, and `/api/health/deep` passes.
5. This is also exercised end-to-end in the scratch rehearsal
   (`tools/data-repair/rehearsal-evidence/09-restore.json`): `pg_restore`
   of a pre-repair dump returned the DB to its exact prior state (ids +
   row counts).
