# Release Engine — Company fan-out (capability) and the daii_dev production-path upgrade (rehearsal)

**Date:** 2026-10-09 · **Branch:** `release-company-fanout` (local, **not pushed**) · **Commits:** `6c50459` (capability + harness), `3527b7b` (1.1.3), `1cd6d37` (guard per-column fix + F2/F3 statement split), `3f41d6b` (1.1.4), on top of the cherry-picked H3 engine fixes (`d5f6c3d` registry/RB-1, `83a9162` build script tracked, `6c5fb6a` LF, `c5825cb`).
**Scope split (CTO 2026-10-08):** **A** = upgrade `daii_dev` only, through the real engine. **B** = give the engine the capability to upgrade existing Company databases in a future production deployment. The two were kept separate; **no Company database (Alpha/Beta/Gamma/Delta) was touched by either.**

| | Status |
|---|---|
| **B — Company fan-out capability** | **IMPLEMENTED · VERIFIED** (tests + 7/7 mutations killed). Disabled by default; never run against a current Company database. |
| **A — `daii_dev` upgraded through the engine** | **VERIFIED.** First attempt (1.1.3) was stopped by a **false positive in the engine's expand/contract guard** (proved below; `daii_dev` untouched). After the CTO chose "split statements", release **1.1.4** deployed through the real engine: `succeeded`, 285 migrations (252 + 33), no manual SQL, Company databases untouched in substance (see Addendum 2). |

---
## B — What the engine can now do

`deployReleaseStaged` gained one pre-swap step, controlled by `RELEASE_COMPANY_MIGRATIONS`:

```
plan (read-only)  →  restore-point gate (BEFORE any database is migrated)  →  Platform migrations
  →  per-Company migrations (READY→MIGRATING→READY, sequential, stop at first failure)  →  verification  →  swap
```
- **`off` (default):** no Company database is read or written; the deploy audits that fact (`release.deploy.company_fanout`, `mode:"off"`). **`dry-run`:** plan only (reads). **`on`:** full.
- **Discovery:** `ACTIVE` registry rows whose Company is `READY`; others are reported *skipped*. A READY Company that cannot be evaluated is a **blocker** (never silently skipped).
- **Which migrations (D2):** the tags a Company *already has* (derived from its own `migrations` table) plus `core`, inside the release's entitlement scope. A tag it never received is never applied — enabling a module is a Plans operation, not a deploy side effect. Proven for every real migration (>250) that the file-name→migration-name mapping used equals TypeORM's.
- **Restore point (D4):** `create` (engine takes + verifies a `pre_update` backup of that Company) or `require-recent` (verified backup newer than N hours must exist). Missing ⇒ abort **before the Platform is migrated**.
- **Lifecycle (D5):** `READY→MIGRATING→READY`. A failure whose database is *provably unchanged* (pending set identical) reopens the Company; anything else leaves it `MIGRATING` (closed) — the state machine has no `MIGRATING→FAILED` edge, and a Company in doubt must stay closed.
- **Partial failure (D1) / rollback (D3):** stop at the first failure; Companies already migrated stay migrated (**forward-only**, safe because migrations are expand-only, I-8); the report names *migrated / failed / not attempted*. Post-swap rollback undoes the Platform only (unchanged behaviour).
- **Evidence:** per-Company audit records (`release.deploy.company_migration_started|succeeded|failed|noop`), plan, backups, summary and verification events; never credentials.
- **Guards:** requires staged activation (refused before anything is touched otherwise); a configured mode with no service wired fails loudly instead of degrading to `off`.

**Verification:** `company-fanout.real-pg.spec.ts` 11/11 (real Postgres, isolated instance), `company-fanout.unit.spec.ts` 5/5, `release-execution-company-fanout.spec.ts` 10/10 (ordering + every pre-swap abort). Release regression **26/26 suites, 231/231 tests** (the 2 `release-migrations-endpoint` tests need the repo's ambient test DB — provisioned with the repo's own tool; environment, not regression). **Mutation checks 7/7 killed:** discovery ignores status · MIGRATING step removed · sweep continues after failure · tags invented · restore-point gate removed · failed Company ignored by the engine · failed Company always reopened.

**Deliberately not done / residuals:** (1) a Company that is not `READY` during a deploy is skipped and **nothing upgrades it later** when it is reactivated — a catch-up on activation is a follow-up (the service already accepts a plan per Company set). (2) The capability only acts when the *installed* engine already contains it; the deployment that installs it (this one) is performed by the previous engine — an inherent bootstrap step. (3) Company fan-out has not been exercised through a full end-to-end engine deploy against real Companies — by instruction.

---
## A — The daii_dev upgrade through the real engine

**Setup (all outside the repo, `D:\DAII-LOCAL-DEPLOY`):** the *installed* build is commit `5011691` (the only commit whose migration set contains every migration applied on `daii_dev`, none unknown) at version 1.1.2, with a real `node_modules`. The release is `Daii-Release-v1.1.3-2026-10-08.zip` (SHA-256 `29b35e8cd23b85b827a1484125e130a5f9e7c1c45c519254e8a1d7556a72edc5`, built by `tools/build/build-release.sh` from `3527b7b`, `VERIFY: PASSED`). `tools/release-sim/local-deploy-harness.js` hosts the installed build's *real* engine services (no application start, so no Company sweeps) and drives the official sequence.

**Sequence run against `daii_dev` (all through the engine):**
1. Independent safety net: fresh `pg_dump` `D:\DAII-BACKUPS\upgrade-sim-20261008\daii_dev.dump` (sha256 `5cec6417…ef9c6`, 176 tables) — the newest pre-existing dump (10-06) predates F1–F6 and the Manufacturing rollout.
2. Fingerprints of `daii_dev` + 4 Companies (`pg_stat` DML counters + per-table row-count/md5) before and after; no drift between baseline and pre-run.
3. Engine backup `c0cbf484…` → **verified**. 4. Upload → **validated** (release `5e409842…`). 5. Link backup → **backup_verified**; gate **allowed**.
6. `deploy` →

| Engine gate | Result |
|---|---|
| host preflight · candidate build · candidate verification (every `dist` file `node --check`, deps resolve) | pass |
| artifact integrity (candidate bytes = manifest) | pass |
| **migration preflight** (33 pending incl. 22 older than the head, history compatible) | **READY_TO_ACTIVATE** |
| **expand/contract scan** | **DENIED** — `core/1790003000000-MembershipLifecycleAndInvitations` and `core/1790005000000-RoleMetadataAndRolesManageNode`: "ADD COLUMN NOT NULL without DEFAULT" |
| migrations · swap · restart · health · LKG | **not reached** (pre-swap abort, I-2) |

**State after the stop (proved, not assumed):** Platform migrations 252→252, tables 176→176; the only changed rows are engine bookkeeping (`audit_records` +11, `backup_runs`/`backup_artifacts`/`backup_operations` +1, `releases` +1). **All four Company databases: zero row changes, identical DML counters.** ACTIVE slot still 1.1.2, no candidate left behind.

### Root cause: the denial is a false positive of the guard
Every `NOT NULL` column in both migrations has a `DEFAULT` (`status … NOT NULL DEFAULT 'active'`, `authzVersion … NOT NULL DEFAULT 1`, `roles.type … NOT NULL DEFAULT 'custom'`, …). `expand-contract-guard.ts` rule `/\bADD\s+(?:COLUMN\s+)?(?!.*\bDEFAULT\b)[^;()]*\bNOT\s+NULL\b/` checks for `DEFAULT` only on the **same line** as the `ADD` that starts the match, but the match can continue across lines into the *next* column's `NOT NULL`. Demonstrated with the guard's own function (no database): the F2 statement as written → **flagged**; the **same columns and defaults with the `NULL` columns moved last → passes**; two genuinely unsafe statements (single- and multi-line) → still **flagged**. The guard is identical in the installed baseline and in the candidate, and it is the *installed* engine's guard that evaluates a release — so a fixed guard shipped inside this very release cannot help this deployment.

**Consequence for production:** the current version cannot be deployed through the production engine until this is resolved — which is precisely what the simulation was for.

### Options (decision required; nothing below was applied)
1. **Reorder the columns in the two migrations** (NULL columns last). Semantics identical (provable by comparing the resulting schema on a scratch DB), the old guard then passes, and both migrations are applied nowhere in production yet. Plus ship a **per-column guard fix with negative controls** in the same release for future deployments. Touches two committed migration files.
2. **Bootstrap hotfix of the guard file** on the installed engine (the one-time pattern of `DEPLOYMENT_PROCEDURE.md` §2), then deploy unchanged migrations. Touches the installed engine out-of-band.
3. Do nothing and keep `daii_dev` as is.
Retry is simple: the failed release is re-registerable (`failed` ∈ `REPLACEABLE_ON_REUPLOAD`); a new backup link is required.

## Environment adaptations (Windows, not engine behaviour)
Symlinks need a privilege this account lacks, and `fs.cp` cannot recreate a junction → the installed tree has a **real** `node_modules`. A directory cannot be renamed while it is a process's working directory → the harness runs from `host/` (whose `package.json` mirrors the installed version, because the engine reads `process.cwd()/package.json`).

---
## Addendum — rehearsal on disposable clones (2026-10-09; nothing here touched `daii_dev` or any Company)
Purpose: strengthen the evidence behind the options, without applying any. Two throwaway databases (`daii_test_clone_orig`, `daii_test_clone_split`) were restored from the fresh `daii_dev` dump on the **isolated** instance (252 migrations each = `daii_dev`'s exact schema). The release package was unpacked twice under `D:\DAII-LOCAL-DEPLOY\ct\` — `orig` as shipped, and `split` where only the two flagged statements were split into consecutive `ALTER TABLE` statements **in the same column order** (a scratch edit of the compiled files; the repository is unchanged).

| Check | `orig` (as shipped) | `split` |
|---|---|---|
| Guard over the **33 pending migrations** (the engine's scan scope) | **2 violations** (F2 `1790003…`, F3 `1790005…`) | **none** |
| All 33 pending migrations applied to the clone with the engine's own primitive (`runMigrationsForDatabase`), incl. the 22 older than the head | SUCCESS, 33 executed, 1.2 s | SUCCESS, 33 executed, 1.1 s |
| `pg_dump --schema-only` of the two results | identical — the **only** diff is pg_dump 18's random per-run `\restrict` token | |
| `migrations` (285 names), `roles` (29 rows), `user_company_memberships` (8 rows) fingerprints | identical | identical |

Conclusions: (1) the denial is limited to exactly those two migrations; (2) every pending migration is applicable to `daii_dev`'s real schema; (3) an **order-preserving split** (not a reorder) changes nothing in the resulting schema — not even physical column order — so Option 1 is safe in that form. Note the rows of the 6 other old (2025/early-Oct) migrations the guard also matches when scanning the *whole* tree are already applied history and outside the engine's scan scope.

---
## Addendum 2 — the upgrade of `daii_dev` through the engine (release 1.1.4)
**Decision (CTO, 2026-10-09):** "split statements". Applied: (1) the two flagged migrations split into consecutive `ALTER TABLE` statements in the **same column order**; (2) the guard's `ADD COLUMN NOT NULL without DEFAULT` rule is now judged **per column definition** (each `ADD` to the next `ADD`/first `;`), with 8 new specs incl. the original F2/F3 statements and negative controls (13/13). Verdicts on all 570 migration files (ts+js) are otherwise unchanged; on the originals: old guard 1 violation each / new guard 0, on the split files both 0. Version bumped to **1.1.4** (the project's own rule: never reuse a version that went through a verification attempt).
**Package:** `Daii-Release-v1.1.4-2026-10-09.zip`, SHA-256 `f28348d55d6d2502903fd0c094994fc205e2d070b79403dec57fe54812fcd84b`, from `3f41d6b`, `VERIFY: PASSED`.

**Engine run (all gates, in order):** host preflight · candidate build + verification · artifact integrity · migration preflight · expand/contract scan (**passed**) · **33 migrations** (33/33 recorded successful in `release_migration_runs`) · atomic swap · restart trigger · health · LKG commit → `release.status = succeeded` (audit trail seq 2315–2324).

**Verification**
| Check | Result |
|---|---|
| Migration state | 252 → **285**, head `AddWarehouseOrgUnit1790011000000`; F2/F3 columns 7/7 present |
| Slots | ACTIVE = 1.1.4; `app.prev-…` = 1.1.2 (rollback source); LKG = 1.1.4, "health ok" |
| Schema vs an independent clone migrated with the migration primitive | identical in substance — the only differences are 51 `CHECK … ANY(ARRAY…)` lines on old tables rendered in two equivalent textual forms (identical after normalising casts/parentheses); verified with a working filter and a control that detects a single altered line |
| Smoke on `daii_dev` with the upgraded app (clean run, tracked PID, 12.9 s) | **8/8**: `/api/health`, `/health/db`, `/health/deep` (database healthy), frontend index + bundle, `auth/me` 401, bad login 401, release API 401 |
| Companies (Alpha/Beta/Gamma/Delta) through the engine deploy | migrations, tables, every table's content and DML counters **unchanged** |
| Companies through the app boot | content unchanged; each Company's insert counter rose by exactly **27** — fully explained and reproduced on isolated copies: TypeORM's per-connection `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` fails (the repo's own `UuidGenerateV4Compatibility` already defines `uuid_generate_v4()`) and rolls back, leaving 27 **dead** catalog tuples (`pg_depend` 17, `pg_proc` 8, `pg_description` 1, `pg_extension` 1) and no extension. Pre-existing behaviour of every build on every connection; no persisted change. A clean 12.9 s run moved no Company counter at all |
| Platform side effects of the app's own boot seeding | `roles` 29→45, `role_permissions` 175→317, `integration_providers` 0→1, `audit_records` (matrix-rule / registry-sync entries): the new build seeding its role templates and catalogs |

**Incident disclosed:** my first smoke attempt left a backend running for ~2 minutes (Git-Bash PID ≠ Windows PID, so `taskkill` missed it). It was found by an anomalous "up after 0.1 s", killed by its real PID, and its effect on the Companies was measured and explained as above. The process handling was corrected (PowerShell `Start-Process -PassThru` + `Stop-Process`).

**Regression (full backend suite, isolated instance, `3f41d6b`):** 173 suites / 1222 tests → 169 suites pass; 4 not "passed", **all classified, none a regression**: `closing-snapshot-key-rotation`, `fiscal-period-closing-workflow`, `closing-snapshot-recovery` — TEST/ENVIRONMENT ISSUE (the worktree has no `.env`, so no `CLOSING_SNAPSHOT_SIGNING_*`; the service fails closed; with the key loaded all three pass, 11/11); `t0-clean-company-baseline` — skipped by design (1 skipped, 0 failures). Effective result: **0 failures**.

**Environment adaptations / limits of this rehearsal:** the HTTP controller + auth layer were not exercised (the installed build's real engine *services* were driven directly, no credentials involved); the deployment was performed by the *previous* engine (build 1.1.2, which has no fan-out), so it upgraded the Platform only, exactly as production does today; the fan-out capability itself remains disabled by default and was proven only on disposable databases.
