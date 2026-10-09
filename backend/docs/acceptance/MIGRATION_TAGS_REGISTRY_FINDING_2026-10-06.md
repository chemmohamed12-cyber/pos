# MIGRATION_TAGS registry — finding (Manufacturing handoff H3), 2026-10-06

**Verdict: real defect, in the entitlement path only. Fixed with a one-constant change + a drift-guard spec.**
Manufacturing is not reopened; this is a platform follow-up.

## What was reviewed

| Path | Uses `MIGRATION_TAGS` / `tagsForModules`? | Result |
|---|---|---|
| `database/data-source.ts` (CLI `migration:run`, dev) | No — own hardcoded list of all 13 tags | OK (but a second hand-kept list; now pinned by spec) |
| `release/migration-datasource.ts` `createMigrationDataSource(…, tags?)` | No — takes `tags`; omitted → `discoverMigrationTags` (reads disk) | OK |
| Release Engine deploy **without** an `entitlement` section (`tags` = `undefined`) | No — discovers disk | OK (this is the current production configuration) |
| Release Engine deploy **with** an entitlement manifest (`resolveEntitlementTags` → `readEnabledModules` → `tagsForModules`) | **Yes** | **DEFECT** — tags outside the 6-tag list are dropped |
| Release rollback `undoReleaseMigrations` (`release-execution.service.ts:703`) | **Yes**, always (even with no manifest on disk) | **DEFECT** — see below |
| `EntitlementModule` `ENABLED_MODULES` boot snapshot | **Yes** | Reports a wrong "schema tag set" (no current consumer beyond export) |
| Company provisioning (`DatabaseProvisioningService` → `runMigrationsForDatabase`) | No — caller `tags`, omitted → disk discovery | OK |

## The defect

`MIGRATION_TAGS = ['core','sales','inventory','logistics','finance','hr']`, but `migrations/` has 13 tag dirs. `tagsForModules` ends in `MIGRATION_TAGS.filter(...)`, so the seven missing tags can never be selected:
`accounting, attendance, commission, manufacturing, payroll, procurement, targets`.

Consequences (all verified):
1. **Entitled to `manufacturing`** → `core, sales, inventory, finance` only; `manufacturing/` migrations never run.
2. **Entitled to anything that depends on `accounting`** — `finance` depends on `accounting`, and `sales`→`finance`, so even a **sales-only** entitlement loses `accounting/`.
   This is wider than the seven-tag reading of H3: it breaks the core module family, not just the new modules.
3. **Rollback, no manifest** (the current production config): `readEnabledModules` falls back to `[...MIGRATION_TAGS]` (6 tags) while the forward deploy used disk discovery (13). Undo then loads fewer migration classes than ran, so `undoLastMigration` cannot find an `accounting/`/`manufacturing/` migration → drops to `fallbackFullRestore` (or throws). Inconsistent with the forward path.
4. Unsigned `DAII_STANDARD` installation row (dev/test) → same 6-tag "all".

Not currently exercised in production (no deploy carries an `entitlement` section yet), so latent — but it would fire on the first entitled deploy, and the rollback case (3) fires on any release that ships an accounting/manufacturing migration.

## Evidence

**Unit** — `backend/src/database/enabled-modules.spec.ts` (22 tests). Before the fix: **15 failed / 7 passed** (disk-vs-registry, per-module `tagsForModules`, closure, fallback). After: all pass.

**Real PG (isolated 127.0.0.1:5544, disposable `daii_test_migtags_*`, dropped afterwards)** — `createMigrationDataSource` + `runMigrations()` using the pre-fix `tagsForModules` result vs the correct dependency closure, on a scratch copy of `dist` with the two D3 migrations (1789860000000 / 1789870000000) removed:

| Entitlement | Tags selected (pre-fix) | Migrations run | `work_orders` | `accounting_fiscal_years` |
|---|---|---|---|---|
| manufacturing | core, sales, inventory, finance | 152 | **absent** | **absent** |
| manufacturing | *correct closure* (+accounting, manufacturing) | 200 | present | present |
| sales | core, sales, inventory, finance | 152 | n/a | **absent** |
| sales | *correct closure* (+accounting) | 193 | n/a | present |

(Finance migrations ran without accounting tables in the "pre-fix" rows — schema silently incomplete rather than failing loudly.)

## Fix (minimal)

`database/enabled-modules.ts`: `MIGRATION_TAGS` now lists all 13 tag directories (`reporting` has a manifest but no migrations dir, so it is intentionally absent).
`enabled-modules.spec.ts` pins it so it cannot drift again: every on-disk `migrations/<tag>/` ∈ registry; no phantom tags; every manifest `migration_tag` with a directory ∈ registry; equals the `data-source.ts` list; `tagsForModules` closure == dirs-on-disk ∩ closure for every module; fallbacks return all disk tags.

Deliberately **not** done (flag for CTO if wanted): replacing the static list by disk discovery in `readEnabledModules` (would match the 2026-09-15 "no hand-maintained list" directive but changes a dependency-free reader's contract); de-duplicating `data-source.ts`'s own list.

## Verified unaffected
`enabled-modules.spec`, `release/migration-preflight`, `release-execution-gates`, `company-migration-runner.unit`, `module-registry/company-aware-guards` pass (the entitlement and module-lifecycle directories contain no runnable specs of their own). Specs needing a compiled `dist/` (company-migration-runner real-PG, restore-manager-audit-chain, release-migrations-endpoint, build-release) cannot run in this worktree (no `dist/`, unrelated to this change — they never import `enabled-modules`).
