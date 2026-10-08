# Release Engine — Company fan-out (capability) and the daii_dev production-path upgrade (rehearsal)

**Date:** 2026-10-09 · **Branch:** `release-company-fanout` (local, **not pushed**) · **Commits:** `6c50459` (capability + harness), `3527b7b` (version 1.1.3), on top of the cherry-picked H3 engine fixes (`d5f6c3d` registry/RB-1, `83a9162` build script tracked, `6c5fb6a` LF, `c5825cb`).
**Scope split (CTO 2026-10-08):** **A** = upgrade `daii_dev` only, through the real engine. **B** = give the engine the capability to upgrade existing Company databases in a future production deployment. The two were kept separate; **no Company database (Alpha/Beta/Gamma/Delta) was touched by either.**

| | Status |
|---|---|
| **B — Company fan-out capability** | **IMPLEMENTED · VERIFIED** (tests + 7/7 mutations killed). Disabled by default; never run against a current Company database. |
| **A — `daii_dev` upgraded through the engine** | **BLOCKED** at the engine's own expand/contract gate — a **false positive in the gate** (proved below). Nothing was changed on `daii_dev` apart from the engine's bookkeeping rows. |

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
