# Daii v1.0.3 — Server Bootstrap Package

One-time Phase-0 bootstrap: current server (v1.0.3 hotfix, pre-Release-Center)
→ v1.0.3 Hardening + Release Center. Applied by **manual rsync** — the Release
Center cannot deploy itself.

**Do not deploy or run anything before the pre-bootstrap backup passes
(`docs/BACKUP_RESTORE_RUNBOOK.md` §1).**

## Contents

| Path | What | Deployed? |
|---|---|---|
| `src/`, `dist/` | full backend (specs stripped); `dist/` is the runtime | yes → `<AppRoot>/src|dist/` (`rsync -a --delete`) |
| `package.json`, `package-lock.json` | + `yauzl` dep, + `migration:*:prod` scripts | yes → `<AppRoot>/` |
| `tools/` | build / deploy / data-repair / validation scripts | yes → `<AppRoot>/tools/` (`rsync -a`, no `--delete`) |
| `MANIFEST.json` | runtime delta manifest (src/ dist/ package*) | package metadata |
| `MANIFEST.sha256` | SHA-256 of every file in the package | package metadata |
| `docs/` | 18 reference docs + `rehearsal-evidence/` | **no** — operator reference only |

## Procedure

Follow **`docs/DEPLOYMENT_RUNBOOK.md` Phase 0** exactly. In short:

1. Host facts + `mkdir` skeleton + **manual verified backup**.
2. Set env keys in cPanel (NOT `.htaccess`); rotate `JWT_REFRESH_SECRET` /
   `INTEGRATION_ENCRYPTION_KEY` (currently identical).
3. `rsync` `src/` + `dist/` (`--delete`), `tools/` (no `--delete`), `package*.json`.
4. `"$NPM_BIN" install` (resolves `yauzl` into the nodevenv — confirm
   `node_modules` is still a symlink).
5. `npm run migration:run:prod` (5 Release-Center migrations; compiled
   datasource — **never `npm run migration:run`** on the host).
6. `touch tmp/restart.txt` → `bash tools/deploy/verify-deploy.sh` (exit 0).
7. Controlled UUID Data Repair (`docs/DATA_REPAIR_RUNBOOK.md`).
8. Staging acceptance (`docs/POST_DEPLOY_VERIFICATION.md` S1–S12) — including
   `POST /treasury/cash-in` + `POST /deposits/:id/approve` = 2xx, **no UUID error**.

Full analysis, per-file classification, and the excluded-files report:
`BOOTSTRAP_PACKAGE_REPORT.md` (delivered alongside this package).

**Not in scope for this bootstrap:** frontend changes, server cleanup, the
UUID repair execution, declaring v1.0.3 VERIFIED.
