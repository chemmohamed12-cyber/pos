# Role names i18n - merge into integration (2026-10-20)

Merge commit **f71bd14** (feature/role-names-i18n 1ac5ed2 into integration/local-2026-10-16; the integration tip before the merge was 346c016). No conflicts. package.json stays 1.1.10. No deployment, no flag, hosting or production change; no database change was made by this session.

## Migration review (core/1790019200000-SeedPlatformRoleNames)
Data only: four INSERTs into `terminology_entries` (role.platform_super_admin, role.company_manager, role.support_operations, role.platform_audit_readonly; category role_label; Arabic and English text identical to `PLATFORM_ROLES` in `platform-nodes.ts`). `ON CONFLICT (code) DO NOTHING` so a re-run never duplicates or overwrites; `down` deletes only rows that still hold exactly the seeded text. No role, permission, membership or authorization file is touched (diff: migration, one real-PG spec, regression list line, Layout.tsx, displayNames.ts, Dashboard.tsx, AdminCover.tsx, report/evidence).

## Git state
Before: integration 346c016; worktree dirty only with the regenerated `controlled-scenario-results.json` and untracked gate evidence folders (preserved, not committed). After: f71bd14, same dirty files, nothing lost.

## Database state (read-only checks)
Dry run of the integration build against daii_dev + Alpha/Beta/Delta/Gamma: **0 pending** on all five. Each of the five has the migration recorded exactly once (308 migrations), the four role terms exactly once, no duplicates.

## Checks
- Frontend tsc / build OK; lint 0 errors, 55 warnings (unchanged). Backend lint 0 errors; unit tests 451/451.
- Browser (:5173, integration frontend): Arabic header lists all 13 roles by name, English likewise, 0 raw `role.*` keys; after switching Alpha -> Beta the header and the /auth/me role keys are identical to before (13 keys, unchanged) - no role data from the previous Company; dashboard greeting shows the same names.
- PASS: the above. NOT TESTED in this session: the real-PG spec platform-role-names (5/5 per the other session; not re-run here), the unknown-role fallback path in the browser (covered by that session's check file).
