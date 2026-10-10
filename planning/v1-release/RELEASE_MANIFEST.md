# Release Manifest — Daii V1

- **Release version**: V1 (no formal version tag in this repo; treat this manifest's date as the release point)
- **Build date**: 2026-08-23
- **Source state**: not under git version control (`git status` in the workspace root reports "not a git repository") — this manifest and `CHANGELOG_V1.md` are the record of what changed
- **Migration count**: 70 (all applied, all forward-only, no `synchronize`)
- **Test count**: 39 suites / 280 tests, backend, all passing on a fresh run
- **Frontend**: `tsc -b` clean, `vite build` clean (68 modules, 383.60 kB / 96.45 kB gzip)

## Files/modules changed this release round

See `CHANGELOG_V1.md` for the itemized list (security fixes: 13 backend files + 3 spec files; UI: 2 files; Warehouse Phase 1: ~15 backend files, 4 migrations, 6 frontend files, 2 spec files).

## Known limitations

See `KNOWN_LIMITATIONS.md` — 3 named by the CTO (all verified accurate, non-blocking), plus items found this round (dual-Postgres-instance environment ambiguity, test data left in the verification database, no dedicated cross-warehouse activity report) and carried-forward non-blocking security/migration hygiene items.

## Deployment prerequisites

See `DEPLOYMENT_GUIDE.md` — required production env vars (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `DB_PASSWORD`, all fail-closed against dev-default values), migration sequence, build/start commands, health checks, smoke tests.

## Rollback procedure

See `ROLLBACK_GUIDE.md` — `npm run migration:revert` per-migration, standard artifact redeploy for the application layer, explicit guidance against reverting any security fix.

## Package contents

- `planning/v1-release/FINAL_RELEASE_REPORT.md` — executive summary and final gate verdict
- `planning/v1-release/WAREHOUSE_ERP_PHASE1_COMPLETION_REPORT.md`
- `planning/v1-release/SALES_ORDER_COMPLETION_REPORT.md`
- `planning/v1-release/SECURITY_AUDIT_FINAL.md`
- `planning/v1-release/DATABASE_MIGRATION_AUDIT.md`
- `planning/v1-release/UI_VERIFICATION_REPORT.md`
- `planning/v1-release/LIVE_E2E_VERIFICATION_REPORT.md`
- `planning/v1-release/KNOWN_LIMITATIONS.md`
- `planning/v1-release/DEPLOYMENT_GUIDE.md`
- `planning/v1-release/ROLLBACK_GUIDE.md`
- `planning/v1-release/CHANGELOG_V1.md`
- `planning/v1-release/RELEASE_MANIFEST.md` (this file)
- Full project archive: see `FINAL_RELEASE_REPORT.md` for the exact path (generated after this manifest).
