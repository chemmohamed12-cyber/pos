# H3 — Staging Deployment Safety Runbook (final gate), 2026-10-06

**Status: PREPARED — NOT EXECUTED. H3 remains OPEN** (`H3 OPEN — hosting verification unavailable` until a confirmed staging environment runs this).
Scope: platform / Release Engine verification only. Manufacturing M10 stays CLOSED. **No code change, no `nest build` in the isolated worktree, never production.**
Companion: `H3_DEPLOYMENT_SAFETY_GATE_2026-10-06.md` (evidence so far), `MIGRATION_TAGS_REGISTRY_FINDING_2026-10-06.md`.

## 0. STOP finding that must be resolved BEFORE any deployment — D3

D3 migrations `core/1789870000000-SeedManualReceiptTerminology` and `inventory/1789860000000-AddManualReceiptCostAndReasonCode` are **tracked in git** (commit `1517d81`) and D3 is **not approved**. Exact behavior verified from source:

- `tools/build/build-release.sh` packages whatever `dist/database/migrations/<tag>/` the build produced; it has **no exclusion list** (only `*.spec.*`/`*.test.*` are excluded). A normal build of this tree therefore **includes both D3 migrations** (manifest-only run on the full dist: 266 migrations, 264 without D3).
- The Release Engine has **no held-migration mechanism**: without an entitlement section it globs every tag (`discoverMigrationTags`); with one it globs the entitled closure — D3 sits in `core` and `inventory`, always in scope. Migration Preflight reports them as ordinary `pending`, and `runReleaseMigrations` executes them.
- Consequence: **deploying any artifact built from this tree to staging would apply D3** to the staging database.

Per the CTO boundary this is a **deployment-safety finding, not authorization for D3**. Execution is blocked until the CTO chooses one of (agent does not choose):
- **A.** Build Release N and N+1 from trees in which those two source files are removed (a recorded, explicit deviation from `main`; the artifact then is *not* byte-identical to a normal release — state this in the evidence), or
- **B.** Wait for a D3 decision, or
- **C.** Another CTO-specified exclusion mechanism (none exists today; would be a new scope).
Whatever is chosen, record it in the evidence table (§8). If the staging DB already contains the D3 rows/migration records, record that too (H4: D3 rows pre-exist in Company DBs) — do not alter D3 state.

## 1. Environment to be confirmed by the operator (nothing below is assumed)

| # | Item | Value | Confirmed by |
|---|---|---|---|
| 1 | Staging/hosting server (must run the **same** Release Engine config as production: staged activation, Passenger or an equivalent supervisor that restarts on the restart-file mtime) | **TO BE CONFIRMED** | |
| 2 | Current ACTIVE release / slot (`<RELEASE_DEPLOY_ROOT>/<RELEASE_ACTIVE_DIRNAME>`; `appRoot` must equal it) | **TO BE CONFIRMED** (record version, `MANIFEST.json` sha, LKG entry) | |
| 3 | CANDIDATE release / slot (`<active>.next-<releaseId>` created by `buildCandidate`) | produced by the engine at deploy | |
| 4 | Database used by the staging Company (`DB_HOST/PORT/USER/NAME` of the running app; **never** `daii_dev`, never production) | **TO BE CONFIRMED** | |
| 5 | Entitlement under test | signed manifest entitling `manufacturing` (closure ⇒ core, sales, inventory, finance, accounting, manufacturing) | |

**Hard prerequisite:** the staging process must really restart on the restart file. The engine's "restart" is only `touch <passengerRestartFile>`; if nothing watches it, post-swap health/smoke would test the **old in-memory process** and the run proves nothing. Verify this first (touch the file, observe the PID/start time change).

## 2. Mechanism (as implemented — code references)

| Concern | Mechanism |
|---|---|
| Deployment | `POST …/release/releases/upload` (zip) → `…/releases/:id/link-backup` → `…/releases/:id/deploy` (`release.controller.ts`, `@Controller('release')`; `DEPLOYMENT_PROCEDURE.md` writes `/api/releases/...` — confirm the real prefix on staging from the Release Center's own requests). Operator UI = Release Center. |
| Order (staged) | `buildCandidate` → `verifyCandidate` → Artifact Integrity gate → entitlement manifest apply (pre-swap) → **Migration Preflight** (READY_TO_ACTIVATE/BLOCKED) → expand/contract scan → `runReleaseMigrations(candidate)` → `verifyMigrationsComplete` → **atomic swap** → restart-file touch → health check → smoke GET list → entitlement seeding → LKG commit. |
| Migration execution | inside the running app process, short-lived `DataSource` from `createMigrationDataSource(candidatePath, DB_* from AppConfigService, tags)`; tags = entitlement closure (or all on disk when the release has no entitlement section). Failed batch ⇒ TypeORM transaction rollback. |
| Restart | `touch RELEASE… passengerRestartFile` (`triggerPassengerRestart`); failure to touch is logged/audited, never fails the deploy. |
| Health | `RELEASE_HEALTH_BASE_URL` + `RELEASE_HEALTH_ENDPOINTS` (`ReleaseHealthCheckService.check()`), then `RELEASE_SMOKE_GET_ENDPOINTS` (public GETs only; 401/403 is a config error). Tool: `tools/deploy/verify-deploy.sh`. |
| Backup | `POST …/backups` → `…/backups/artifacts/:id/verify` → `link-backup`; deploy refuses without a verified linked backup (needs `pg_dump`/`pg_restore` on the host — confirm binaries; the engine's preflight checks them). |
| Rollback | **Automatic** post-swap: `rollbackAfterSwap` = `rollbackSwap` → `undoReleaseMigrations(…, failedPath)` (RB-1 fix) → restore entitlement manifest → restart → health. **Manual** committed release: `POST …/releases/:id/rollback` body `{"drill":"<name>"}` optional → `rollbackReleaseStaged` (same failedPath undo). Rollback failure ⇒ `failed_safe` + `FAILED-SAFE` marker + optional webhook. |

## 3. Pre-flight checklist (all must be true; otherwise STOP)

1. §0 D3 decision recorded; the artifacts for N and N+1 are built per that decision.
2. Staging DB is a disposable/staging Company DB, backed up (full dump + checksum recorded); not `daii_dev`, not production.
3. Restart-file watcher proven (§1).
4. **Release N** is a known-good deployed build (`GET …/version` = N; LKG seeded; health green; `migrations` head recorded).
5. **Release N+1** adds, relative to N, at least one **accounting** and one **manufacturing** migration and no contracting DDL. Reference delta used in the isolated proof: `CreateWipReconciliationTable1789733000000`, `AddTransientDatabaseErrorClosingExceptionCategory1789760000000` (accounting), `CreateRoutingAndWorkCenterTables1790000100000`, `SeedManufacturingMasterDataTerminology1790000200000` (manufacturing).
6. Release N+1 carries a signed entitlement manifest including `manufacturing` (sealed to the staging installation fingerprint).
7. `RELEASE_EXPAND_CONTRACT_ENFORCE` at its production value (not weakened for the test).
8. A seed set of business rows exists in the staging Company DB (e.g. a warehouse, a product, one GL-posted document) and is recorded (§5 snapshot).

## 4. Artifact verification (same artifact that is deployed)

For **both** N and N+1, using the exact zip uploaded (never a different local `dist`):
1. `bash tools/build/build-release.sh … ` must end `VERIFY: PASSED`; record `sha256` of the zip (`.zip.sha256`) and re-hash the file actually uploaded.
2. Unzip a copy; `MANIFEST.json`: `version`, `packageType`, `database.migrationCount == migrations.length`, `migrations[]` contains the accounting and manufacturing names above, `files[]` lists `dist/database/migrations/accounting/*.js` (41 in this tree) and `dist/database/migrations/manufacturing/*.js` (7).
3. Per-tag file counts in the zip equal `src` counts (isolated reference: accounting 41/41, manufacturing 7/7, 13 tags).
4. Confirm the engine's own Artifact Integrity audit row for the deploy (`release.deploy.artifact_integrity` = success) and Preflight audit row (`release.deploy.migration_preflight`): `decision=READY_TO_ACTIVATE`, `tagsInScope` = the closure, `pending` = exactly N→N+1 delta, `tagDriftIssues=[]`, `manifestDriftIssues=[]`.
5. If D3 is in the zip (option B/unchanged tree) → **STOP** (§0).

## 5. Snapshots to take (before deploy; repeat after deploy and after rollback)

```sql
-- migration history (compare ids+names exactly)
SELECT id, "timestamp", name FROM migrations ORDER BY id;
-- schema presence
SELECT to_regclass('public.accounting_fiscal_years'), to_regclass('public.work_orders'),
       to_regclass('public.routings'), to_regclass('public.work_centers');
-- business data fingerprint (per table row counts + a content hash of the seed rows)
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;
SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT * FROM warehouses) t;   -- repeat per seeded table
-- restore activity (must NOT grow during rollback)
SELECT count(*) FROM restore_operations;
-- release / audit trail
SELECT id, version, status, "errorMessage" FROM releases ORDER BY "uploadedAt" DESC LIMIT 5;
SELECT "migrationName", success FROM release_migration_runs WHERE "releaseId" = '<N+1 id>' ORDER BY "startedAt";
```
Also record: `ls <deployRoot>` (slots), `GET …/version`, app PID/start time, LKG file, `MANIFEST.json` sha of ACTIVE.

## 6. E2E scenario

**Phase 1 — successful deployment of N+1**
1. Upload N+1 zip → `link-backup` (verified) → `deployment-gate` allowed → `deploy`.
2. Expected: preflight READY; migrations N→N+1 run (delta only); swap; restart observed (new PID); health + smoke OK; entitlement seeding OK; LKG = N+1; status `succeeded`.
3. Assert: migration rows = N history + exactly the delta (no duplicates, no unrelated tag); accounting/manufacturing tables exist; `release_migration_runs` for N+1 = delta, `success=true`; app serves; business snapshot unchanged (rows ≥ before, seed hashes equal); `verifyMigrationsComplete` outcome (no `migration_verification_failed` audit row); no D3 rows added unless §0 chose otherwise.

**Phase 2 — controlled post-swap failure → automatic staged rollback** (uses a *second* candidate N+2 = N+1 + one additional trivial expand-only migration, or re-deploy N+1 as a new release row, so there is a release to fail)
1. Inject the failure on **staging only**, without touching the artifact: add a public GET path that is guaranteed to return non-2xx on the candidate (e.g. `/api/__h3_injected_failure`) to `RELEASE_SMOKE_GET_ENDPOINTS` for the duration of this phase; restart the staging app so the config is read; **revert it afterwards**.
2. Deploy N+2 (verified backup linked). Expected sequence in audit: `…migration_preflight` success → `…swapped` → `…restart_triggered` → `release.deploy.failed` (smoke) → `release.rollback.migration_undone` ×(delta) → `release.rollback.completed` `{mode:'staged'}`; release status `rolled_back`.
3. Assert:
   - previous slot is ACTIVE again (`ls <deployRoot>`: ACTIVE has N+1's `MANIFEST.json` sha; `<active>.failed-<id>` still present and holds N+2's migration files);
   - **no** `release.rollback.migration_undo_failed` audit row; `restore_operations` count **unchanged**; no `pg_restore` process/log; release not `failed_safe`;
   - migration history == the Phase 1 end state exactly (ids and names);
   - new restart observed (PID change), health + smoke (with the injected path removed) OK;
   - business snapshot equal to the post-Phase-1 snapshot;
   - `GET …/releases/:id/rollback-reason` shows the injected failure.
4. Revert the injected smoke endpoint; restart; confirm health.

**Phase 3 — operator rollback drill of a committed release (`rollbackReleaseStaged`)**
1. `POST …/releases/<N+1 id>/rollback` with `{"drill":"h3-rb1"}` (N+1 must be the LKG current).
2. Assert as Phase 2 (undo from failedPath, no restore, history back to **N**, LKG popped, restart + health OK, business data intact). Rollback-reason sidecar = `drill:h3-rb1`.
3. Re-deploy N+1 afterwards only if the environment is to be left at N+1 (record the choice).

**Phase 4 — failure-mode spot checks** (each must fail **closed and report**, never silently):
(a) Preflight BLOCKED when the manifest ships a migration file absent from the candidate; (b) migration that throws ⇒ batch rolled back, `release_migration_runs.success=false`, ACTIVE untouched; (c) rollback when the failed slot is unavailable ⇒ backup-restore fallback or `failed_safe`, never a silent partial state. (a)/(b) have isolated real-PG proofs; run on staging only if the operator wants host confirmation — **never** by weakening production gates.

## 7. Stop conditions (abort, do not continue, report)
D3 present in an artifact without CTO decision · restart not observed · preflight BLOCKED for any unexpected reason · any migration outside the delta executed · any `failed_safe` state ("DO NOT deploy again until resolved") · restore activity during a rollback that should not need it · staging DB found to be production/`daii_dev` · any row loss in the business snapshot. After a FAILED-SAFE: do not retry; capture `<manifestsPath>/../logs/<releaseId>/FAILED-SAFE` and the audit trail.

## 8. Evidence table to complete

| Gate | Result | Environment | Evidence |
|---|---|---|---|
| D3 decision (§0) | | | |
| Artifact N / N+1 (§4) | | | sha256, MANIFEST, per-tag counts |
| Preflight READY, delta only | | | audit row |
| Phase 1 deploy | | | snapshots before/after |
| Phase 2 auto staged rollback | | | audit sequence, slots, restore count |
| Phase 3 operator drill | | | audit sequence, history == N |
| Business data intact | | | hashes/counts |
| `:5433` impact | NOT EVIDENCED | :5433 | classifier blocked the read; no workaround attempted; needs an approved read-only path |

**Closure:** `H3 CLOSED` only when Phase 1–3 pass with the assertions above. If staging cannot safely execute this, the status is `H3 OPEN — hosting verification unavailable`. Isolated-test results (23 suites / 205 tests; 21/21 registry+RB-1 spec) are **not** a substitute.

## 9. Separate findings (documented, no implementation scope opened)
1. Missing-directory preflight gap (entitled tag whose directory is absent from the artifact, delta shipping no file for it → preflight READY).
2. Silent unknown module code in a signed manifest (`tagsForModules` → core only).
3. Untracked `backend/tools/build/` (`.gitignore` rule `build/`) — relevant to this runbook: a fresh checkout cannot build the release; confirm the build host has the script and record its sha.
4. `database.module.ts` hand-lists 7 tags for the boot DataSource (inert today).
5. D3 has no hold mechanism in build or engine (§0).
