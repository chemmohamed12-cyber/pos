# Role key localization — report (2026-10-20)

CTO decision (option 1): add display names for four platform roles that the page header showed as raw keys. **Localization only — no role, permission, membership or authorization change.**

**Branch:** `feature/role-names-i18n`, worktree `.claude/worktrees/role-names-i18n`, from the integration tip `346c016`. **Not merged into the integration branch** (it follows the established branch and review process).

## 1. Migration
- **Identifier:** `SeedPlatformRoleNames1790019200000` (`backend/src/database/migrations/core/1790019200000-SeedPlatformRoleNames.ts`, tag `core`, after the latest existing core migration `1790018400000`).
- **Mechanism:** the same Terminology Registry seed convention as the latest seeds: `INSERT … ON CONFLICT (code) DO NOTHING` into `terminology_entries`, category `role_label` (the category the other role names use).
- **Safe to rerun:** an existing row is never rewritten, so a customised translation survives. `down` deletes only rows that **still hold exactly the seeded text**, so a customised row is left alone.
- **Changes only translation data:** the migration's SQL touches `terminology_entries` only (asserted by a test).

## 2. Exact entries (names reused from the CTO-approved role definitions, `foundation/platform/platform-nodes.ts` PLATFORM_ROLES, 2026-10-07 — nothing invented)
| Code (internal key, unchanged) | Category | Arabic | English |
|---|---|---|---|
| `role.platform_super_admin` | role_label | مدير المنصة الأعلى | Platform Super Admin |
| `role.company_manager` | role_label | مدير الشركات | Company Manager |
| `role.support_operations` | role_label | الدعم والتشغيل | Support / Operations |
| `role.platform_audit_readonly` | role_label | التدقيق / للقراءة فقط | Audit / Read-only |

A real-Postgres test also compares these entries with the role definitions in code, so the two sources cannot drift apart.

## 3. Readable fallback for a role that is not in the registry (frontend)
`roleLabel(t, role)` in `frontend/src/lib/displayNames.ts` returns the registry name, or — if none exists — the key as readable words (`regional_auditor` → `Regional auditor`), never `role.some_key`. Used in the three places that show arbitrary roles: the page header (`Layout.tsx`), the dashboard greeting (`Dashboard.tsx`) and the admin overview (`AdminCover.tsx`). The `Admin.tsx` role picker uses a fixed list and is unchanged. Internal role keys are not modified anywhere.

## 4. Target database
**`daii_dev` on `localhost:5433` (PostgreSQL 18.6)** — the canonical shared development database (`SHARED-DEV-DATABASE-AND-SESSION-REGISTRY-2026-10-19.md`: :5173 → :3500 → `daii_dev`). Identity confirmed before applying: the env file used by the running :3500 backend names `DB_NAME=daii_dev`, `DB_PORT=5433`; the database itself answered `current_database() = daii_dev`, `inet_server_port() = 5433`. Terminology is read from the platform database; the release engine's own fan-out rule also applies a `core` migration to each company database, so the tool ran it on the platform database and on the four registered company databases (Alpha, Beta, Delta, Gamma). Not production, not hosting. The tool refuses any target but `daii_dev` on :5433.

| | Before | After |
|---|---|---|
| Migrations recorded (platform) | 307 | 308 |
| `terminology_entries` (platform) | 2021 | 2025 (exactly +4) |
| The four role rows | 0 | 4 |
| Pending (platform + 4 companies) | 1 each (this migration only; dry run) | **0** |

Evidence: `evidence-2026-10-20-role-names/1-dry-run.json`, `2-apply.json`, `3-verify-zero-pending.json`.

## 5. Verification
| Check | Result |
|---|---|
| Backend `tsc`, build | PASS |
| Backend lint | PASS — 0 errors, 5 warnings (baseline) |
| Frontend `tsc`, build | PASS |
| Frontend lint | PASS — **0 errors, 55 warnings** (baseline 55) |
| Real-Postgres spec `platform-role-names.real-pg.spec.ts` (added to `regression-specs-all.txt`): exact names vs the code definitions; rerun is safe; a customised translation survives `up` and `down`; `up` after `down` restores only what was removed; unrelated role labels untouched; SQL touches `terminology_entries` only | **5 / 5 PASS** (`real-pg-spec.log`) |
| Unknown-role fallback (helper checks) | **5 / 5 PASS** (`unknown-role-fallback-checks.txt`) |
| Live header on :5173 (the real development frontend; reload, read-only), Arabic and English, **Alpha and Beta** company context | **PASS** — all 13 roles of the signed-in user translated; the four named roles show the exact names in all four combinations (AR/Alpha, AR/Beta, EN/Alpha, EN/Beta); **0 raw `role.*` keys anywhere on the page**; the dashboard greeting is translated too; `live-5173-header-ar-beta.jpg` |
| Role identity / authorization | unchanged: no role, permission, membership or authorization code or data was touched |

### Not tested in the browser
- The readable fallback for an unknown role **in the live header**: :5173 serves the integration worktree, which does not contain this branch's frontend change, and the signed-in account used for the check has no role outside the registry. It is verified on the helper only.
- The three `roleLabel` call sites (header, dashboard greeting, admin overview) run from this branch's code only after it is merged and the front end is rebuilt; the live header above was fixed by the **terminology data**, which is independent of the frontend change.

### Observation (not caused by this change)
In the Beta company context the dashboard requests modules Beta is not entitled to (purchase requests, purchase orders, returns, shipments, some reports) and receives 404 — the permission guard's by-design answer; Alpha shows none. Not touched.

## 6. Boundaries
No change to permissions, role assignments, company membership or authorization logic; no production or hosting change; no feature flag change; version stays **1.1.10**; the integration branch was not modified (this work is a separate branch); no restart of :5173 or :3500 (terminology is read live); no uncommitted work of other sessions was touched. Cluster 5546 was used for one test run (disposable database, removed by the harness).

## 7. Remaining limitations
- Merging this branch into the integration branch, and rebuilding the front end so `roleLabel` is live, is the integration owner's step. Until then, a role missing from the registry would still show `role.<key>` on :5173 (none does at the moment).
- A future platform role added to code needs its own terminology entry; the fallback only makes a missing one readable.
