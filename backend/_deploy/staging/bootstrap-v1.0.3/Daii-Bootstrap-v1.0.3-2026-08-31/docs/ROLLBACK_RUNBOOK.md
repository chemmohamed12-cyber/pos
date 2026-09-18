# Daii — Rollback Runbook

Rollback returns the server to the **last known-good release**. It is
**automatic** on any deploy-pipeline failure from file-publish onward; this
doc covers what happens, and the manual path for Phase 0 / a stuck state.

Golden rule (ADR-020 §6): **roll forward, not down-migration**, except a
migration's own `down()` during an automatic rollback. A DB rollback beyond
that = restore the pre-deploy backup.

---

## 1. Automatic rollback (Phase 1 — `ReleaseExecutionService.rollbackRelease`)

Triggered by: migration failure, health-check failure, or an explicit
`POST /api/release/releases/:id/rollback`.

Order (matters):

1. **Undo migrations**, newest-first — the just-deployed migration files
   are still on disk so their `down()` bodies load. Each undo is audited
   (`release.rollback.migration_undone`).
2. **Restore files** from the per-file pre-deploy snapshot
   (`<backup-storage>/app-snapshots/<releaseId>/`). `add` files are
   removed; `modify`/`delete` files are put back.
3. If **migration-undo fails partway**: stop, and do a **full DB restore**
   from the *same verified backup this release was gated on*
   (`fallbackFullRestore` → `RestoreManagerService`). This is the
   documented last resort.
4. `touch tmp/restart.txt`.
5. Final status: `rolled_back` (success) or `failed` (even the fallback
   restore failed → manual intervention; `errorMessage` says so).

Never reports `rolled_back` unless the DB and files are actually back — a
dedicated test asserts this (`release-execution.service.spec.ts`
"ROLLBACK FAILURE … never falsely 'rolled_back'").

## 2. What a failed deploy leaves behind (for diagnosis)

| Where | What |
|---|---|
| `GET /api/release/releases/:id` | `status`, `errorMessage`, `backupRunId` |
| `GET /api/release/releases/:id/migrations` | per-migration `success` / `errorMessage` |
| `audit_records` | `release.deploy.preflight` / `.started` / `.failed` / `.rollback.*` with the check details |
| `<backup-storage>/app-snapshots/<releaseId>/` | the pre-deploy file snapshot |
| the linked `BackupRun` + its `manifests/<runId>.json` | the DB restore point |

## 3. Manual rollback (Phase 0, or if the app process itself won't start)

```bash
cd /home/xnexdrgr/daii.xnexustech.com/release-new/backend

# 3a. Files — from the pre-bootstrap copies made in DEPLOYMENT_RUNBOOK 0.4
rm -rf src dist && mv src.pre-bootstrap src && mv dist.pre-bootstrap dist
#     or from a filesystem backup: BACKUP_RESTORE_RUNBOOK §2c
#     public/: restore public.pre-v1.0.3/ if the frontend regressed

# 3b. Database — only if migrations ran and need reverting
"$NODE_BIN" ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:revert   # once per migration to undo
#     or, if that fails / schema is inconsistent: full restore
PGPASSWORD="$DB_PASSWORD" "$PG_RESTORE_BIN" -h 127.0.0.1 -U xnexdrgr_daii_app2 \
  -d xnexdrgr_daii_staging --clean --if-exists  <pre-deploy>.dump

# 3c. Deps — if the rollback target had different dependencies
"$NPM_BIN" install

# 3d. Restart + verify
touch tmp/restart.txt
bash tools/deploy/verify-deploy.sh https://daii.xnexustech.com
```

## 4. Rollback of the Controlled UUID Data Repair

The repair migration / `DataRepairService.execute` has **no automated
undo** — primary keys were rewritten. To reverse it:

```bash
PGPASSWORD="$DB_PASSWORD" "$PG_RESTORE_BIN" -h 127.0.0.1 -U xnexdrgr_daii_app2 \
  -d xnexdrgr_daii_staging --clean --if-exists  <the pre-repair dump linked to the data_repair_run>
```

The pre-repair backup is **kept as Release Evidence** precisely for this —
do not delete it after a successful repair (`UUID_REPAIR_REPORT.md` §3).
Proven in the scratch rehearsal: `pg_restore` of the pre-repair dump
returned every repaired id and every row count to their pre-repair values
(`rehearsal-evidence/09-restore.json`).

## 5. Application rollback ≠ Database rollback

If a release ran a schema migration, restoring only the application files
leaves the DB ahead of the code. The pipeline handles this (undo
migrations first, then files, DB-restore fallback). A **manual** files-only
rollback of a release that migrated the schema is **wrong** — always pair
it with §3b or §3’s full restore.
