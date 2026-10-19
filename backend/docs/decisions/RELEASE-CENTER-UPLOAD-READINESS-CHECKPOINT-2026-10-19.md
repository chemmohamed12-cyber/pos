# Release Center upload readiness - CTO checkpoint (2026-10-19)

Status: **investigation only (read-only). Nothing in the application, `.env`, release artifacts or any host was changed.** Waiting for CTO approval before any change.

## 1. Root cause of each preflight failure (screenshot: `bin.pg_dump`, `bin.pg_restore`)

| Check | Where it is produced | Cause |
|---|---|---|
| `bin.pg_dump: "pg_dump" is not an absolute path` | `src/foundation/release/deploy-preflight.service.ts:70-73` (rule: the value must start with `/` or a drive letter) | `PG_DUMP_BIN` is read through `AppConfigService.releaseBackup.pgDumpBin` (`app-config.service.ts:217`) from env var `PG_DUMP_BIN`, whose schema default is the bare command `pg_dump` (`configuration.schema.ts:66`). The local `backend/.env` sets no `PG_*` / `RELEASE_*` key, so the default is used and the absolute-path rule (intentional, v1.0.3 report item 13/14) rejects it. |
| `bin.pg_restore: "pg_restore" ...` | same | identical, env var `PG_RESTORE_BIN` (`configuration.schema.ts:67`). |

The binaries exist on this machine, but not on `PATH`: `C:\Program Files\PostgreSQL\18\bin\pg_dump.exe` and `pg_restore.exe` (server `daii_dev` is 18.6, so client and server majors match). Existence of the files was checked by listing the directory only - nothing was executed.

## 2. Actual upload limits and where they come from

| Limit | Value | Source |
|---|---|---|
| Multipart file size | **200 MB, hard-coded** | `release.controller.ts:292` (`FileInterceptor limits.fileSize`) - not configurable |
| Upload temp location | OS temp dir (`os.tmpdir()`), file `release-upload-<uuid>.zip` | `release.controller.ts:291`; on this machine that drive has **~2.2 GB free (99 % used)** |
| Free space required by preflight | 500 MB on the app root and on the backup path | `deploy-preflight.service.ts:24` |
| Package rules | allow-listed prefixes (`src/ dist/ public/`) and root files, `.env` / `node_modules/` / symlinks / dangerous extensions denied, manifest + SHA-256 checks | `package-validator.service.ts` |
| Global body parser limit | none relevant (multipart is handled by multer, not the JSON parser) | `main.ts` |
| Reverse proxy / hosting limits | **not assessed** (no host access; out of scope) | - |

Observation (not changed): the validator has no cap on number of entries or total uncompressed size - only path/type/integrity rules. A decompression-size guard would be a hardening item, proposed separately.

## 3. Exact changes proposed (not made)

1. **Local environment (`backend/.env`, not tracked, not shared):** set
   `PG_DUMP_BIN=C:\Program Files\PostgreSQL\18\bin\pg_dump.exe` and `PG_RESTORE_BIN=C:\Program Files\PostgreSQL\18\bin\pg_restore.exe`. Shared defaults stay unchanged; no machine path enters the repository.
2. **`.env.example`:** document both keys with placeholder absolute paths (Windows and Linux examples).
3. **`deploy-preflight.service.ts` diagnostics (message text only; the absolute-path rule is NOT weakened):** name the environment variable to set (`PG_DUMP_BIN`), distinguish "not set / bare command", "path not found", "not executable", and "is a directory", and say which config key supplied the value. Executable check uses `fs.access` / `stat` only - no dump or restore is ever invoked.
4. **Upload limit:** make the 200 MB cap an explicit setting (`RELEASE_UPLOAD_MAX_MB`, default 200 = today's behaviour) with a clear 413-style error naming the limit, and add a free-space check of the temp dir before accepting the file; stream cleanup of the temp file on every failure path is verified by tests (existing code already `rm`s the file on bad `packageType`).
5. **Tests (isolated, temp files only):** valid package within the limit; package above the limit; corrupted ZIP; manifest/checksum mismatch; duplicate version; missing / bare / non-existent / non-executable `PG_*` values; upgrade-path validation of the displayed 1.1.10 over 1.1.9 (the screen already reports "installs directly over 1.1.9 - eligible").

## 4. Compatibility and regression risks
- Changing `.env` takes effect after a backend restart (a second restart of :3500).
- The new setting keeps today's default, so existing behaviour is unchanged unless it is set.
- Diagnostics are text-only changes; preflight pass/fail outcomes for the same inputs are identical.
- The protected 1.1.9 baseline, existing artifacts, migration/upgrade ordering and rollback protections are not touched. Nothing is published, deployed or activated.
- Temp-disk headroom on this machine (2.2 GB) is itself an operational risk for large uploads; it is reported, not altered.

## 5. Decision requested
Approve items 1-5 (or a subset). Items 1-2 are configuration only; 3-4 change shared code and need your approval per the task's checkpoint rule.
