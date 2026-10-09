# H3 Verification + Deployment Safety Gate — evidence report, 2026-10-06

**Final status: `H3 = OPEN — HOSTING DEPLOYMENT BLOCKED BY D3 AUTHORIZATION`** (CTO decision, Option B — see "Decision log" at the end; `:5433` not evidenced).
Manufacturing M10 remains CLOSED; no Manufacturing code, Event Engine, Company data or `readEnabledModules` architecture was touched.
Registry fix (`MIGRATION_TAGS` = all 13 tag dirs) stands and is verified.
**Update (CTO GO on RB-1 only):** the pre-existing Release Engine defect **RB-1 is FIXED and verified** (see below; uncommitted). The open items are now the hosting deployment-safety evidence and the `:5433` check. The three other findings (G-1 missing-directory preflight gap, G-2 silent unknown module code, D-2 untracked `backend/tools/build/`) are **documented only — no implementation scope opened**.

## Evidence matrix

| Gate | Result | Environment | Evidence |
|---|---|---|---|
| `:5433` impact | **NOT EVIDENCED** | :5433 | The read-only inspection was **denied by the permission classifier** and was not retried by any other route. Outstanding — see "Open items". |
| Registry drift spec | PASS | unit | `enabled-modules.spec.ts` 23/23 (dirs ↔ `MIGRATION_TAGS` ↔ module registry ↔ `data-source.ts`; closure; fallbacks). |
| Entitlement selection | PASS | :5544 `daii_test_h3reg_*` | `release-migration-registry.real-pg.spec.ts` 17/17. Selected tags == expected closure; executed migrations == exactly the on-disk migrations of those tags (none omitted, none unrelated). |
| Accounting | PASS | :5544 | tags `accounting,core,finance,inventory,sales`; 193 migrations; `accounting_fiscal_years`, `accounting_gl_accounts` present; `work_orders`/`routings` absent. |
| Manufacturing | PASS | :5544 | tags `+manufacturing`; 200 migrations; `work_orders`, `work_order_components`, `routings`, `work_centers` present (the previously missing `work_orders` proof). |
| Commerce chain sales→finance→accounting | PASS | :5544 | sales-only entitlement → same 5-tag set, 193 migrations, accounting schema present (was 152 / absent before the fix). |
| Company migration runner | PASS | :5544 `daii_test_h3_ambient` | `company-migration-runner.spec.ts` PASS (264 migrations applied = 266 source − 2 held D3). |
| Release migrations endpoint | PASS | :5544 | `release-migrations-endpoint.spec.ts` PASS. |
| Restore audit chain | PASS | :5544 | `restore-manager-audit-chain.real-pg.spec.ts` PASS (pg_dump mocked, as designed). |
| build-release | PASS | local | `build-release.spec.ts` PASS (these four suites: 16 tests; final combined run of 8 suites: 81/81) — needed `tools/build/` copied in (see D-2). |
| Upgrade (existing Company) | PASS | :5544 | N (196 migrations) → N+1 (200): preflight READY, `pending` == exactly the 4 new; history ids/names of N byte-identical; +4 rows, no duplicates; business rows (warehouse, product) intact; no table dropped/row removed; re-run is a no-op (0 pending, 0 run records); entitlement **narrowing** removes nothing and runs nothing; a bystander Company DB is untouched. |
| Release artifact | PASS (limited) | build | `nest build` → `dist/database/migrations`: 13 tag dirs, per-tag counts equal `src` (accounting 41/41, manufacturing 7/7, …). `build-release.sh --manifest-only` on a staged real `dist`: `migrations[]`=266, `database.migrationCount`=266, includes all 41 accounting + 7 manufacturing. Script discovers tags from disk (no hardcoded list). **Limitation:** the full `npm run build:release` package was not produced; "same artifact as tested" is by construction (spec copies the built `dist`), not by hash. |
| Rollback — class resolution, no-manifest (production config) | PASS | :5544 | accounting+manufacturing run undone through `resolveEntitlementTags` with the fixed registry. **Negative control:** with the pre-fix 6-tag registry the same undo fails (`No migration … was found in the source code`) and falls to backup restore. |
| Rollback — **staged post-swap** | PASS (after RB-1 fix) | :5544 | Was FAIL (red proof recorded: `No migration SeedManufacturingMasterDataTerminology1790000200000 was found in the source code`). After the fix: undo from the failed slot reverts exactly the 4 migrations, no backup restore; wiring tests through real `rollbackAfterSwap` and `rollbackReleaseStaged`; fallback and FAILED-SAFE preserved when classes are genuinely absent. |
| Failure safety | PASS (with 3 documented gaps) | :5544 | mid-batch failing migration → whole batch rolled back, `migrations` unchanged, `h3_partial_marker` absent, 5 run records `success=false` with the error; class missing from artifact → preflight **BLOCKED** (tag/migration drift); pre-fix registry + shipped manufacturing migration → was already BLOCKED (loud). Gaps G-1…G-3 below. |
| Hosting deployment path | REVIEWED, **not executed on a host** | code trace | see §Hosting trace. No staging/hosting deployment was possible from this machine. |

## RB-1 (separate defect, pre-existing, NOT caused by H3 — FIXED under CTO GO, see "Fix applied")

`deployReleaseStaged` runs migrations from the **CANDIDATE** tree, swaps, and on a post-swap failure calls `rollbackAfterSwap` → `stagedActivation.rollbackSwap()` (ACTIVE ← PREVIOUS) → `undoReleaseMigrations()`.
`undoReleaseMigrations` builds its DataSource from `config.releaseExecution.appRoot`, which the config contract requires to equal the ACTIVE slot (`<deployRoot>/<activeDirname>`). After `rollbackSwap` that slot is the **previous** release, which does not contain release N+1's migration classes (they sit in the `.failed-<id>` slot).
TypeORM `undoLastMigration` then throws `No migration <X> was found in the source code` → `fallbackFullRestore` (verified-backup restore). **Executed proof:** spec "post-rollbackSwap state…" — undo rejects, `restore.preflight` called once, DB left exactly as migrated (not half-undone). Spec "with the forward tree available (appRoot = N+1 tree)" — the same undo succeeds and reverts exactly the 4 migrations, so the defect is *only* class resolution against the wrong tree.
Effect: for any staged release that adds migrations, the in-place migration **undo is effectively dead code**; recovery always depends on the linked backup + `pg_restore` (which this environment cannot exercise; the restore spec mocks `pg_dump`). Fail-safe state is preserved (FAILED-SAFE if restore fails), so this is a recoverability/availability defect, not silent corruption.
**Fix applied (CTO GO, RB-1 only; uncommitted):** `release-execution.service.ts` — `undoReleaseMigrations(release, actor, head, migrationTreePath?)`; the DataSource is built from `migrationTreePath ?? appRoot`; `rollbackAfterSwap` and `rollbackReleaseStaged` pass the `failedPath` returned by `rollbackSwap()` (read defensively: `?.failedPath`, existing mocked specs return `undefined`). Tag selection (`resolveEntitlementTags(appRoot)`) and the legacy in-place rollback (no path → `appRoot`) are unchanged.
**Verification (real PG :5544, isolated):** `release-migration-registry.real-pg.spec.ts` 21/21 —
- RB-1 proof (was red, now green): appRoot = previous tree + failed-slot path → undo succeeds, history back to N exactly, no restore call.
- Safety fallback preserved: failed-slot path lacking the classes → rejects with `No migration … was found`, `restore.preflight` called once, DB left as migrated.
- Legacy in-place path unchanged (no path → appRoot).
- WIRING `rollbackAfterSwap` and `rollbackReleaseStaged` (real engine methods, real undo, stubbed slot/health/LKG): `rollbackSwap` called with the release id → `failedPath` → status `rolled_back`, no restore; LKG popped on the operator path.
- WIRING fail-safe preserved: failed slot lacks the classes + no restorable backup → `failed_safe`, DB untouched.
Regression: `src/foundation/release` + `src/foundation/release-orchestration` + `enabled-modules.spec`: **23 suites / 205 tests PASS** (release-execution-gates, staged-activation, reconcile-interrupted-deploys, migration-preflight, company-migration-runner, release-migrations-endpoint, restore-manager-audit-chain, build-release all included; DB target 127.0.0.1:5544, ambient `daii_test_h3_ambient`, disposable `daii_test_h3reg_*`).
**Still not proven:** the same sequence on a real host (real slot renames, Passenger restart, live health, real `pg_restore`). The wiring tests stub `StagedActivationService`, the health check and the LKG; they prove the engine passes the right path and the undo resolves from it, not the filesystem swap itself.

## Hosting trace (code review; nothing deployed)

Package → `uploadPackage` (validator: only `src/ dist/ public/` + manifest/package files) → backup gate → `deployRelease` → `DeployPreflightService` → **staged** (`stagedActivation=true`): `buildCandidate` (cp -a of ACTIVE + staged files) → `verifyCandidate` → Artifact Integrity Gate → `applyEntitlementManifestPreSwap` (signature verified, `entitlement.manifest.json` written *before* migrations) → `resolveEntitlementTags` (→ `readEnabledModules` → `tagsForModules`; **only when the release carries an `entitlement` section**, otherwise `tags=undefined` → `discoverMigrationTags(candidate)`) → **Migration Preflight (mandatory, BLOCKED stops pre-swap)** → expand/contract scan (always enforced) → `runReleaseMigrations(candidatePath)` → `verifyMigrationsComplete` → **atomic swap** → Passenger restart → health + smoke → entitlement seeding → LKG commit.
- **Where/who:** inside the running Nest app process (Release API), via a fresh short-lived `DataSource` from `createMigrationDataSource`; DB from `AppConfigService` (`DB_*` env). The app's own boot DataSource never runs migrations.
- **Order:** staged = migrate **before** the new code is active (old code keeps running on the migrated schema — hence expand/contract); legacy (`stagedActivation=false`) = files deployed in place → migrate → health → restart.
- **dist used:** the candidate's `dist/database/migrations/<tag>/[0-9]*.js` (staged); `appRoot`'s (legacy, and undo — RB-1).
- **Migration failure:** pre-swap → `PreSwapAbort`/failed, candidate removed, ACTIVE bit-for-bit untouched, entitlement manifest file restored; TypeORM batch transaction rolls back (executed-proven). Post-swap failure → `rollbackAfterSwap`; any rollback failure → `failed_safe` + `FAILED-SAFE` marker + webhook, "DO NOT deploy again".
- **Restart with incompatible schema:** cannot happen on the staged path before the migration gate passes; the exposure is the migrate→swap window (mitigated by expand/contract, I-8) and RB-1 on rollback.
- **Unentitled-module migrations:** with an entitlement section, only the closure tags are globbed (executed-proven). With **no** entitlement section (current production config) all tags run by design (DAII_STANDARD) — not a per-Company restriction.
- **Startup-fails-after-migration:** exercised only through the mocked `release-execution-gates` / `staged-activation` specs and the undo tests above; the real swap/Passenger/health sequence was **not** run.

## Documented gaps / separate observations (not fixed)

- **G-1** An entitled tag whose directory is absent from the artifact, in a delta that ships no file for it, is silently empty (preflight READY) — executed characterization. Mitigated only post-swap (seeding/health), not pre-swap.
- **G-2** An unknown module code in a signed manifest is silently ignored by `tagsForModules` (→ core only) — executed characterization in `enabled-modules.spec.ts`.
- **G-3** `verifyMigrationsComplete` cannot catch a dropped tag by itself (it only cross-checks files the manifest ships); the Preflight tag-drift check is the real net, and only for shipped files.
- **D-1** `database/database.module.ts` hand-lists 7 tags for the app's boot DataSource (missing procurement, manufacturing, attendance, payroll, targets, commission) while its comment says "every tag". Inert today (never runs migrations); a third hand-kept list.
- **D-2** `backend/tools/build/` (incl. `build-release.sh`) is **untracked**: the root `.gitignore` rule `build/` ignores it. A fresh checkout has no release build script, and `build-release.spec.ts` fails there. Needs a `!backend/tools/build/` rule + commit.

## Open items before H3 can be CLOSED

1. **`:5433` read-only inspection** — denied by the permission classifier; needs the user to run it (or grant the permission). Suggested: `SELECT datname FROM pg_database WHERE datname LIKE 'daii\_test\_%' ORDER BY 1;` on :5433.
2. ~~RB-1~~ — fixed and verified (uncommitted; commit only after the CTO accepts the verification).
3. **Hosting/staging execution** of the deploy path (artifact → candidate → migrations → swap → restart → health → injected failure → staged rollback → migration undo, without falling back to full restore) — **mandatory next gate; not possible from this machine without a staging host**. H3 stays OPEN until it exists.
4. Full `npm run build:release` artifact + hash comparison with the tested tree.

## Test-environment notes

- All DB work on isolated PG 127.0.0.1:5544 (`isolated_admin`); `daii_test_h3reg_*` databases are dropped by the spec; `daii_test_h3_ambient` (provisioned for the four Release-path suites) remains. **The isolated instance had stopped (crash-recovery in its log) and was restarted with `pg_ctl` on its own data dir `D:\DAII-ISOLATED-PG\data`.**
- D3 migrations 1789860000000/1789870000000: never applied — excluded from the worktree `dist` (moved to the session scratchpad) and from every tree the new spec copies (`HELD_MIGRATION_IDS`).
- Worktree support files (all git-ignored): `backend/node_modules` junction → main checkout, `backend/dist` (built here), `backend/tools/build` (copied from the main checkout).
- New/changed tracked-candidate files: `src/database/enabled-modules.ts`, `src/database/enabled-modules.spec.ts`, `src/foundation/release/release-migration-registry.real-pg.spec.ts`, this report and `MIGRATION_TAGS_REGISTRY_FINDING_2026-10-06.md`. Nothing committed.

## Decision log

**2026-10-06 — CTO decision: D3 option B (wait for the D3 decision). Hosting gate BLOCKED by D3 authorization.**
- The staging runbook (`H3_STAGING_DEPLOYMENT_RUNBOOK_2026-10-06.md`) is accepted as documentation and is kept **unchanged**. No code change and **no deployment** is authorized until D3 status is resolved.
- NOT authorized: removing D3 migrations from source trees; an H3-only artifact; a new migration-exclusion mechanism; modifying the Release Engine to bypass D3; any `nest build` in the isolated worktree for this gate. An altered artifact must not be used to claim the normal hosting path is safe.
- D3 is a **separate decision with its owner**. The only question: *are the two D3 migrations (`core/1789870000000`, `inventory/1789860000000`) authorized to be included and executed by the standard release/deployment path?* YES → document the authorization, build the normal artifact, run the staging runbook. NO → open a separate architecture/release scope for a migration-hold mechanism (not an H3-specific exclusion).
- Verified and unchanged: Migration Registry, entitlement selection, Accounting, Manufacturing, existing-Company upgrade, RB-1 staged rollback.
- Before staging execution, confirm (runbook §1): (1) approved staging host; (2) active/candidate slot paths; (3) staging Company/database; (4) real deployment endpoint prefix; (5) a **process watcher that actually restarts on the restart-file touch** (otherwise health/smoke test the old process = false PASS); (6) backup/restore mechanism (`pg_dump`/`pg_restore` present); (7) health-check mechanism; (8) exact release artifact and SHA-256.
- `:5433` remains NOT EVIDENCED (classifier-blocked; no workaround; needs an approved read-only path).
- Documented findings only (no scope): missing-directory preflight gap; silent unknown module code; untracked `backend/tools/build/`; 7-tag boot DataSource list in `database.module.ts`.
- **Release Readiness checklist — must not drop off:** `backend/tools/build/` is untracked (root `.gitignore` rule `build/`); a fresh checkout/CI has no `build-release.sh`. Confirm the build host has the script and record its sha before any real release.
