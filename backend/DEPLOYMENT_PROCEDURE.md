# Deployment Procedure — Post Bootstrap-Discovery (2026-09-21)

**Status: DOCUMENTATION ONLY. Nothing in this document has been
executed.** No deployment, no code change, no Hosting data change, no
force-activation, no verification bypass, no assumed Hosting path.
Every step below is either (a) a real, already-implemented mechanism in
this codebase, cited by exact file/endpoint, or (b) explicitly marked
**[OPERATOR MUST CONFIRM]** where this session has no way to know the
real value (a Hosting-side path, an env var's actual configured value,
a live file's current hash). Nothing marked that way is guessed.

This procedure exists because of the 2026-09-21 finding: `StagedActivationService.
buildCandidate()` silently inherited the ACTIVE release's own
`package.json`/`package-lock.json` instead of the uploaded candidate's own —
fixed in commit `a2f8001`, but that fix cannot self-activate through the
normal upload flow (the bug it fixes is in the very code that would verify
it). A one-time manual Bootstrap Hotfix is required first; the normal
Release Engine flow resumes immediately after.

---

## A. Exact New Deployment Flow (overview)

```
1. Pre-Deployment verification (local, this repo)
2. Bootstrap Hotfix (operator, out-of-band, ONE file)
3. Bootstrap Verification (re-run the ALREADY-BUILT v1.1.1 candidate
   through the normal upload flow — do not build a new version just to
   test the bootstrap)
4. Normal Release Deployment (build a NEW version — v1.1.2 — through the
   now-fixed engine, normally, no shortcuts)
5. Post-Deployment Verification
6. (Rollback, only if any gate in 1-5 fails)
```

Nothing in step 4 may begin before step 3's evidence is captured and
accepted. This document does not authorize starting step 2.

---

## 1. Pre-Deployment

### What must be verified locally, before anything touches Hosting

| Check | Exact command | Must show |
|---|---|---|
| Full backend regression | `cd backend && npx jest --runInBand` | `Test Suites: N passed, N total` / `Tests: M passed, M total`, exit code `0` |
| Backend build | `cd backend && npm run build` | `nest build` completes with no error; `tools/validation/check-dist-integrity.js` (run automatically by `build-release.sh`) reports `PASS` |
| Frontend typecheck | `cd frontend && npx tsc --noEmit -p tsconfig.json` | exit code `0`, no output |
| Frontend build | `cd frontend && npm run build` | `vite build` completes; `dist/` produced |
| Migration state (dev DB) | `cd backend && npm run migration:run` | `X migrations are already loaded... Y migrations were found... 0 migrations are new migrations must be executed` (or the new ones apply cleanly) |
| Extension-dependency guard | part of the full regression above | `src/database/migrations/extension-dependencies.spec.ts` — PASS |
| Dependency-classification guard | part of the full regression above | `src/foundation/release/dependency-classification.spec.ts` — PASS |
| Release Engine candidate-build guard | part of the full regression above | `src/foundation/release/staged-activation.service.spec.ts` — PASS |
| `dependencies_resolve`, direct | `node -e "require('./dist/foundation/release/dependency-check.js').checkDependenciesResolve(process.cwd(), process.execPath).then(r=>console.log(JSON.stringify(r,null,2)))"` (run from `backend/`) | `{"ok": true, "missing": [], ...}` |

### Final commit / version

- Source commit as of this document: **`e19f190`** (bootstrap hotfix
  package docs). The Release Engine fix itself is **`a2f8001`**.
- The **application** version to build for the normal release (step 4)
  is the next patch after `1.1.1`, i.e. **`1.1.2`**, per this project's
  own versioning rule (never reuse a version number that has already
  been through any candidate-verification attempt — `1.1.0` and `1.1.1`
  both were). `1.1.2`'s only source change versus `1.1.1` is the
  Release Engine fix itself (`a2f8001`) — no application/business logic
  changes are pending as of this document.
- Do not bump the version number until Bootstrap Verification (§3) has
  passed with captured evidence.

### Files that go into the package

Exactly what `tools/build/build-release.sh`'s `assemble_staged()`
already produces — nothing manual, nothing added by hand:
```
MANIFEST.json   (generated, see below)
dist/           (compiled backend — no *.spec.ts/*.test.ts, no *.tsbuildinfo)
src/            (TypeScript source — the compiled migration-datasource loader reads this)
public/         (compiled frontend)
package.json
package-lock.json
```
No `.env`, no `.htaccess`, no `node_modules/` — enforced by the build
script's own hygiene step and re-checked by its own `--verify` step
(`no backslash paths, no .env, no node_modules in the archive`).

### SHA-256 manifests required

1. **Package-level**: `<zip>.sha256` — a single SHA-256 of the whole
   `.zip`, written by `build-release.sh` itself (`sha256_of()`).
2. **Per-file**: `MANIFEST.json`'s own `files[]` array — one SHA-256
   entry per file under `dist/`, `src/`, `public/` (NOT `package.json`/
   `package-lock.json` — those are outside `generate_manifest()`'s scan
   scope; this is exactly the gap the bootstrap hotfix fixes at the
   candidate-BUILD level, not at the manifest-generation level — the
   manifest still won't list them, but the candidate will now correctly
   contain the uploaded ones).
3. Verify both independently before upload:
   ```bash
   bash tools/build/build-release.sh --verify _release-output/Daii-Release-v<VERSION>-<DATE>.zip
   ```
   Must print `VERIFY: PASSED`.

---

## 2. Bootstrap Hotfix

**Full detail already delivered separately**: `_release-output/bootstrap-hotfix-a2f8001/BOOTSTRAP_HOTFIX_INSTRUCTIONS.md`
(committed at `e19f190`). This section restates the answers to your
specific questions; the linked document is the executable procedure.

- **Exact file to be replaced**: `staged-activation.service.js` (compiled
  from `backend/src/foundation/release/staged-activation.service.ts`,
  commit `a2f8001`). Nothing else.
- **How the operator finds the real path on Hosting without guessing**:
  **[OPERATOR MUST CONFIRM]**. This session does not have and has never
  claimed to know the live Application Root. Derivation procedure (no
  assumption, a real lookup):
  1. Identify the Application Root from the Hosting control panel's own
     "Setup Node.js App" entry for this application (the same place
     `PRODUCTION_DEPLOYMENT_GUIDE.md` documents as already configured —
     "Application Root" field, "Application Startup File:
     `backend/dist/main.js`").
  2. The target file is at `<that Application Root>/backend/dist/foundation/release/staged-activation.service.js`
     — i.e., the same relative path this repository uses under
     `backend/`, resolved against whatever the panel shows as the real
     Application Root. Confirm the file exists at that exact path
     (`ls -l` or panel file manager) before proceeding — if it does not
     exist there, STOP (see §9) rather than guess an alternate path.
- **Before-hash command**:
  ```bash
  sha256sum <ApplicationRoot>/backend/dist/foundation/release/staged-activation.service.js
  ```
  Record the output verbatim in the audit record (§8 / the linked
  instructions document's own template).
- **Replacement method**: copy the single file
  `staged-activation.service.js` (and, optionally, its `.js.map`) from
  the delivered bootstrap package over the one at the path identified
  above. No other file touched. No archive extraction, no directory
  sync — a single-file copy.
- **After-hash verification**:
  ```bash
  sha256sum <ApplicationRoot>/backend/dist/foundation/release/staged-activation.service.js
  ```
  Must equal `7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373`
  (the value in `SHA256SUMS.txt`, delivered with the hotfix package).
  Any other value → STOP, do not restart, restore from backup (§7).
- **Restart required**: **Yes.** Node.js does not hot-reload a replaced
  `.js` file already `require()`-d into a running process. Use the
  existing supported restart mechanism only — per
  `PRODUCTION_DEPLOYMENT_GUIDE.md`: cPanel → Setup Node.js App → the
  app → **Restart**. Never a manual `kill`/`pkill` of the Passenger-
  managed process (this is the exact class of action that caused the
  2026-08-27 incident that document itself documents).
- **Proof the Release Engine is running the fixed code**: this is
  exactly what §3 (Bootstrap Verification) below produces — do not
  consider the hotfix "done" until that evidence exists.

---

## 3. Bootstrap Verification

- **Test candidate to upload**: the **already-built** `Daii-Release-v1.1.1-2026-09-21.zip`
  (SHA-256 `355f8d1a1cfb29e3153999acede70b08604e1d4e4c2ea6dddf285571261d6975`,
  committed at `9a02bbf`). Reuse it — do not build a new version just to
  test whether the bootstrap worked; that would burn a version number
  before the fix is even confirmed live.
- **How to prove `package.json`/`package-lock.json` are now read from
  the staged candidate, not ACTIVE**: upload this exact zip through the
  normal Release Center flow (`POST /api/releases` to register +
  `POST /api/releases/:id/upload` for the file, or whatever single
  "رفع إصدار جديد" action the UI wraps them in) and inspect the
  resulting `dependencies_resolve` check result, surfaced via
  `GET /api/releases/:id/deployment-gate` or the Release Center's own
  candidate-verification detail view (the same "الخطأ" panel the
  screenshots already showed).
  - **FAIL signature (bootstrap did NOT take effect)**: the probe array
    is missing `decimal.js` and contains `@types/yauzl` — the exact
    array from both prior failed attempts.
  - **PASS signature (bootstrap DID take effect)**: `dependencies_resolve`
    reports `ok: true`, and if the raw probe array is visible in the
    detail/log output, it has exactly 19 entries, includes `decimal.js`,
    and does not include `@types/yauzl`.
- **Evidence required to accept the bootstrap as successful** (all of
  the following, captured verbatim, not summarized):
  1. The `dependencies_resolve` check's own `detail` string from this
     upload attempt.
  2. If accessible, the candidate's own staged `package.json` content
     (`cat` or panel file view of the candidate slot's
     `package.json` — path is
     `<deployRoot>/<activeDirname>.next-<releaseId>/package.json`,
     **[OPERATOR MUST CONFIRM]** `deployRoot`/`activeDirname`'s real
     configured values — `RELEASE_DEPLOY_ROOT`/`RELEASE_ACTIVE_DIRNAME`
     env vars on that server), confirming it matches the uploaded zip's
     own `package.json`, not the currently-active release's.
  3. The full `checks[]` array from `verifyCandidate()` (surfaced by the
     same deployment-gate/verification view) — every check should read
     `pass`, matching what `build-release.sh --verify` already showed
     locally for this exact package.
  4. Timestamp and release id of this verification attempt.

**Do not click any "deploy"/"activate" action on this v1.1.1 candidate
after verification passes**, unless it is deliberately intended as the
real deployment (it is a functionally valid, already-fully-tested
package — but per your instruction, the plan below issues a fresh
`1.1.2` for the actual deployment, keeping the bootstrap test and the
real release cleanly separated). If `1.1.1` is activated at this step
instead of `1.1.2` being built fresh, say so explicitly and this
procedure adapts — do not silently deploy it.

---

## 4. Normal Release Deployment (after Bootstrap Verification passes)

1. Bump `backend/package.json` and `frontend/package.json` versions to
   `1.1.2`. No dependency or application-logic change accompanies this
   bump — only the Release Engine fix (`a2f8001`), already committed.
2. `cd backend && npm install --package-lock-only && cd ../frontend && npm install --package-lock-only`
   (syncs both lockfiles' `version` field only).
3. Build the package:
   ```bash
   cd backend && bash tools/build/build-release.sh --skip-install --out ../_release-output
   ```
   Produces `_release-output/Daii-Release-v1.1.2-<date>.zip` +
   `.zip.sha256`. The script's own final step already runs `--verify`
   on the package it just built — must print `VERIFY: PASSED` before
   proceeding.
4. **Final ZIP name**: `Daii-Release-v1.1.2-<YYYY-MM-DD>.zip` (the exact
   pattern `build-release.sh` already generates — `PKG_NAME="Daii-Release-v${VERSION}-${STAMP}"`).
5. **Where it is uploaded**: through the same Release Center "Upload
   Engine" screen already used for `1.1.0`/`1.1.1` (the one shown in
   the screenshots — "رفع إصدار جديد" / Choose File / "نوع الحزمة:
   كاملة"). Backing endpoints, confirmed by direct source reading:
   `POST /api/releases` (register the release + manifest) and
   `POST /api/releases/upload` (the file itself) — exact request
   sequencing is whatever the Release Center's own frontend already
   does; this document does not invent a different flow.
6. **Manifest/SHA/dependency verification**: automatic, already built
   into `POST /api/releases/:id/deploy`'s own pipeline (confirmed by
   direct reading, `release-execution.service.ts`):
   - `buildCandidate()` — now correctly includes the candidate's OWN
     `package.json`/`package-lock.json` (the fix).
   - `verifyCandidate()` — structure, `dist` JS syntax, frontend-bundle
     consistency, `node_modules` symlink resolution, **and
     `dependencies_resolve`** (Package Validator's own secret/zip-safety
     scan already ran at upload time, via `package-validator.service.ts`).
   - Entitlement manifest signature check (pre-swap).
   - **Migration Preflight** — a hard gate: `READY_TO_ACTIVATE` or
     `BLOCKED`, never a third state (`migration-preflight.ts`).
   - Expand/contract migration safety scan (`scanDeltaMigrations`) —
     blocks a contracting (destructive) migration unless
     `RELEASE_EXPAND_CONTRACT_ENFORCE` is explicitly `false`.
7. **Staging → verification → activation**, exact real order (confirmed
   by direct reading, not assumed):
   ```
   a. buildCandidate()            — candidate built, ACTIVE untouched
   b. verifyCandidate()           — must be ok:true, or abort here (ACTIVE untouched)
   c. entitlement manifest apply  — pre-swap, signature-checked
   d. Migration Preflight         — READY_TO_ACTIVATE required, or abort (ACTIVE untouched)
   e. expand/contract scan        — must pass, or abort (ACTIVE untouched)
   f. migrations RUN              — against the live DB, LATE, immediately before the swap
   g. ATOMIC SWAP                 — two renames: ACTIVE -> PREVIOUS, CANDIDATE -> ACTIVE
   h. Passenger restart triggered
   i. post-swap health check      — GET /api/health/deep-equivalent; failure -> AUTOMATIC ROLLBACK (I-3)
   j. post-swap smoke GET checks  — configured endpoints; failure -> AUTOMATIC ROLLBACK (I-3)
   k. entitlement modules enabled — post-swap; failure -> AUTOMATIC ROLLBACK (I-3)
   l. LKG (Last-Known-Good) committed, old slots pruned
   m. release.status = 'succeeded'
   ```
   Steps a-e are entirely pre-swap: **if any of them fails, ACTIVE is
   bit-for-bit untouched — nothing to roll back.** Steps i-k are
   post-swap and already trigger an **automatic** rollback (§7) on
   failure — this is not a manual operator decision, it is the Release
   Engine's own already-implemented behavior (`rollbackAfterSwap`).

---

## 5. Database / Data Delta

- **Is there a Data Delta separate from the application release?** No.
  Confirmed directly: `build-release.sh`'s `assemble_staged()` packages
  `dist/`, `src/`, `public/`, `package.json`, `package-lock.json` only —
  no database dump, ever, for any package type. `MIGRATION_REPORT.md`
  (this release's own) states this explicitly for `1.1.x`; it is true
  of every release this engine has ever built.
- **Order of code vs. migrations** (from §4 step 7 above): migrations
  run at step **f**, AFTER the candidate is fully built and verified
  (steps a-e) but BEFORE the atomic file swap (step g). This means: the
  OLD code is still what's running (ACTIVE not yet swapped) at the
  moment new migrations execute against the live database — the
  migrations must therefore be safe to run against a database the OLD
  code is still actively querying, until the swap completes a few
  seconds later. This is exactly why expand/contract-only migrations
  are enforced (step e) — a migration in this release may only ADD
  (new tables/columns/constraints the OLD code simply doesn't reference
  yet), never REMOVE or rename something the still-running OLD code
  depends on.
- **How overwriting Hosting's current data is prevented**: structurally,
  not procedurally — the package contains no data at all to write. The
  8 migrations this release carries (`MIGRATION_REPORT.md`) are
  additive schema changes only (new tables, one widened CHECK
  constraint) — none of them `UPDATE`/`DELETE` any existing row in any
  existing table. Independently verified this session: every
  migration's `down()` exists and only removes what that same
  migration's `up()` created.
- **What must be explicitly excluded from the package** (already
  enforced by the build script, restated for the audit record):
  `.env`, `.htaccess`, `node_modules/`, any `*.spec.ts`/`*.test.ts`,
  any `*.tsbuildinfo`, and — never applicable to begin with, since
  nothing in this pipeline ever produces one — any database dump or
  export of production/recovered ERP data.

---

## 6. Post-Deployment Verification

Some of these are **already automatic** (part of §4 step 7, i-k) —
listed here so the operator knows what to additionally confirm
manually, not because they're unautomated.

| Area | Automatic? | What to check | How |
|---|---|---|---|
| Health checks | Yes (step i) | `GET /api/health`, `/api/health/db`, `/api/health/deep` | Also confirm manually post-deploy: `curl -I` for `200`, `/health/deep` body has no `false`/`error` component |
| Release Engine self-verification | Yes (steps a-k) | `release.status === 'succeeded'`, no `failed`/rollback event in the release's own audit trail | `GET /api/releases/:id` |
| Migration verification | Yes (step d/f) + manual spot-check | `GET /api/releases/:id/migrations`; confirm the 8 new migration names from `MIGRATION_REPORT.md` all appear applied | Release Center UI "عرض الترحيلات" or the endpoint directly |
| Data integrity checks | Manual | Row counts for unrelated tables (e.g. `sales_orders`, `accounting_gl_accounts`) unchanged from immediately pre-deploy snapshot | Direct read-only query, before vs. after |
| Authentication | Manual | Login flow succeeds for a real account | Browser/UI |
| Sales Orders | Manual | List loads without the `"No process instance for..."` error class this session found and fixed in the shared DEV database (unrelated to this release's own code, but worth confirming Hosting has no equivalent stale rows) | UI: أوامر البيع page |
| Inventory | Manual | Warehouse/inventory screens load, no 404/500 | UI + network tab |
| Accounting | Manual | GL/Journal screens load; Closing Exception screen shows the new `TRANSIENT_DATABASE_ERROR` category correctly if any exception has it | UI |
| HR/Attendance | Manual | Employee list, Attendance screens load | UI |
| Payroll/Commission (in this release) | Manual | Payroll Periods/Runs, Commission Policies/Results/Batches, Targets screens all load and are reachable from nav | UI |
| Regression/smoke | Automatic (step j) + this session's own suite | `RELEASE_SMOKE_GET_ENDPOINTS` **[OPERATOR MUST CONFIRM actual configured value]**; separately, this repo's own 215/215 local suite is not re-run against Hosting (no test suite runs against a live production/Hosting database from this session or any prior one) | Config + local regression already captured in §1 |

---

## 7. Rollback

### Release Candidate rollback (after a full deploy attempt)

**Automatic** for a post-swap failure (steps i-k above) — the Release
Engine's own `rollbackAfterSwap()` already:
1. Reverse-renames PREVIOUS back to ACTIVE (undoes the atomic swap).
2. Undoes this release's own migrations (or restores from backup if
   undo itself fails).
3. Restores the pre-release entitlement manifest if one was written.
4. If the rollback ITSELF fails at any point → **FAILED-SAFE** (I-4):
   the release is marked in a state requiring manual operator
   intervention, never a silent partial state.

**Manual**, for rolling back an already-`succeeded` release later:
`POST /api/releases/:id/rollback` (confirmed real endpoint,
`release.controller.ts`) — or the Release Center's own "التراجع عن
الإصدار" button shown in the screenshots.

### Bootstrap Hotfix rollback (if it failed)

Single-file restore: copy the pre-hotfix `staged-activation.service.js`
(and `.js.map`) from the backup taken in Bootstrap step 1 back to the
same path, restart the same way (cPanel → Restart), confirm
`sha256sum` matches the recorded before-hash.

### Backups/files required BEFORE any execution

- Before the Bootstrap Hotfix: full application-directory backup (or
  this Hosting environment's own documented backup/snapshot mechanism)
  + the before-hash of `staged-activation.service.js` specifically.
- Before the Normal Release deploy: the Release Engine already requires
  a linked, verified backup artifact for a release to be deployable at
  all (`POST /api/releases/:id/link-backup`, `backups/artifacts/:id/verify`)
  — confirm a recent, verified backup is linked to the `1.1.2` release
  before triggering `POST /api/releases/:id/deploy`.

### Forbidden during rollback

- No forced migration state changes outside `undoReleaseMigrations`'s
  own logic.
- No manual data deletion "to clean things up."
- No skipping the backup-restore verification step.
- No re-attempting deploy immediately after a FAILED-SAFE state without
  first resolving whatever caused the rollback-of-rollback to fail.

---

## 8. Operator Checklist

Literal, ordered. Each step: Action / Exact path / Exact command or UI
action / Expected result / Evidence to capture / PASS-FAIL gate.

### Phase I — Bootstrap Hotfix

**STEP 01 — Confirm Application Root**
- Action: Identify the real Application Root via the Hosting control
  panel's "Setup Node.js App" entry.
- Exact path: **[OPERATOR MUST CONFIRM]** — no default assumed.
- Exact command/UI action: cPanel → Setup Node.js App → view app config.
- Expected result: an absolute path, e.g. `/home/<user>/daii.xnexustech.com`.
- Evidence to capture: screenshot or copied path string.
- Gate: PASS if a real path is found and the app's Startup File reads
  `backend/dist/main.js` under it; otherwise STOP (§9).

**STEP 02 — Backup**
- Action: full backup of the Application Root (or the documented
  backup mechanism for this environment).
- Exact path: `<ApplicationRoot>` (all of it).
- Exact command/UI action: **[OPERATOR MUST CONFIRM]** the environment's
  own backup tooling; alternatively the Release Center's own
  `POST /api/backups` if this application-level backup is what that
  endpoint covers — confirm before relying on it for this purpose.
- Expected result: a restorable backup artifact exists.
- Evidence to capture: backup id/location/timestamp.
- Gate: PASS only with a confirmed, verified backup. No backup → STOP.

**STEP 03 — Record before-hash**
- Action: hash the file about to be replaced.
- Exact path: `<ApplicationRoot>/backend/dist/foundation/release/staged-activation.service.js`
- Exact command: `sha256sum <path above>`
- Expected result: a 64-hex-char SHA-256 string.
- Evidence to capture: the exact string, verbatim.
- Gate: PASS once captured. (No correct/incorrect value expected here —
  this is a record, not yet a check.)

**STEP 04 — Apply the hotfix file**
- Action: copy the corrected file over the one at the path above.
- Exact path: source = `staged-activation.service.js` from the delivered
  bootstrap package; destination = the path in STEP 03.
- Exact command: **[OPERATOR MUST CONFIRM]** transfer method for this
  environment (`scp`, panel file upload, etc.) — copy this ONE file
  only.
- Expected result: the destination file's byte content now matches the
  source file's.
- Evidence to capture: transfer confirmation/log.
- Gate: proceed to STEP 05 regardless (verification happens there).

**STEP 05 — Verify after-hash**
- Action: hash the replaced file.
- Exact command: `sha256sum <path from STEP 03>`
- Expected result: `7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373`
- Evidence to capture: the command output.
- Gate: **PASS only on an exact match.** Any other value → STOP, restore
  from STEP 02's backup, do not restart.

**STEP 06 — Restart**
- Action: restart the application process.
- Exact command/UI action: cPanel → Setup Node.js App → this app →
  **Restart**. Never a manual `kill`.
- Expected result: the app comes back up (process running, port bound).
- Evidence to capture: cPanel's own restart confirmation / process
  status.
- Gate: PASS if the app is reachable at all afterward (a basic
  `curl -I` / browser load — full health check is STEP 08).

### Phase II — Bootstrap Verification

**STEP 07 — Upload the already-built v1.1.1 candidate**
- Action: upload `Daii-Release-v1.1.1-2026-09-21.zip` through the
  Release Center's normal upload UI.
- Exact path/UI action: Release Center → "رفع إصدار جديد" → Choose File
  → select the zip → package type "كاملة" (full) → submit.
- Expected result: a new release row appears with status initially
  pending/verifying.
- Evidence to capture: the release id assigned.
- Gate: proceed to STEP 08 regardless of outcome — this step just
  submits.

**STEP 08 — Read the candidate verification result**
- Action: inspect `dependencies_resolve`'s own result for this upload.
- Exact path/UI action: Release Center → this release row →
  `GET /api/releases/:id/deployment-gate` or the same error-detail panel
  the earlier screenshots showed.
- Expected result: `dependencies_resolve` status **PASS**, detail string
  mentions **19** dependencies resolving, **no** mention of
  `@types/yauzl`.
- Evidence to capture: the full `checks[]` output, verbatim (copy/paste
  or screenshot).
- Gate: **PASS required to proceed to Phase III.** FAIL here (same
  signature as before — missing `decimal.js`, containing `@types/yauzl`)
  → the hotfix did not take effect → STOP, re-examine STEP 04-06,
  do not proceed to Phase III, do not attempt v1.1.2.

### Phase III — Normal Release Deployment (v1.1.2)

**STEP 09 — Bump versions and rebuild locally**
- Action: `package.json` version → `1.1.2` (backend + frontend), sync
  lockfiles, `npm run build` both, full regression.
- Exact commands: as in §1/§4 above.
- Expected result: build clean, `215+/215+` tests pass (exact count may
  grow if anything else lands first — never accept fewer than the
  baseline this document's §1 table recorded).
- Evidence to capture: full test-run output, build output.
- Gate: PASS required to proceed.

**STEP 10 — Build and self-verify the package**
- Exact command: `bash tools/build/build-release.sh --skip-install --out ../_release-output`
- Expected result: `VERIFY: PASSED` printed at the end; a
  `Daii-Release-v1.1.2-<date>.zip` + `.sha256` produced.
- Evidence to capture: the full script output, the SHA-256 value.
- Gate: PASS required to proceed.

**STEP 11 — Link a verified backup to the release**
- Exact path/UI action: `POST /api/releases/:id/link-backup` (or Release
  Center equivalent), confirm `verified` status.
- Expected result: release shows a linked, verified backup.
- Evidence to capture: backup artifact id + verification timestamp.
- Gate: PASS required — no deploy without a verified backup linked.

**STEP 12 — Upload and deploy v1.1.2**
- Exact path/UI action: Release Center upload (as STEP 07) with the
  `1.1.2` zip, then trigger `POST /api/releases/:id/deploy`.
- Expected result: `release.status` progresses
  `verifying → migrating → (swap) → health_checking → succeeded`, with
  **no** `failed` in between.
- Evidence to capture: the full audit trail for this release id
  (`release.deploy.candidate_verified`, `.migration_preflight`,
  `.swapped`, `.entitlement_applied` if applicable, `.succeeded`).
- Gate: **PASS = `succeeded` with zero failed audit events.** Any
  `failed`/rollback event → automatic rollback already ran (§7) → go to
  §9 Stop Conditions, do not retry blindly.

### Phase IV — Post-Deployment Verification

**STEP 13 — Health + Release Engine + migrations**
- As the "Automatic?" = Yes rows in §6's table, re-confirmed manually.
- Evidence to capture: `/health/deep` response body,
  `GET /api/releases/:id/migrations` output listing all 8 new
  migrations as applied.
- Gate: PASS required.

**STEP 14 — Functional area walkthrough**
- The full list in §6's table (Authentication, Sales Orders, Inventory,
  Accounting, HR/Attendance, Payroll/Commission).
- Evidence to capture: one screenshot or network-200 confirmation per
  area.
- Gate: PASS on every area. Any failure → do not mark the release
  complete; assess against §9.

---

## 9. Stop Conditions

Stop — do not proceed, do not force, do not work around — on any of:

1. **SHA mismatch** — package-level, per-file (`MANIFEST.json`), or the
   bootstrap file's before/after hash not matching the expected value
   at any checkpoint above.
2. **`dependencies_resolve` failure** — at Bootstrap Verification
   (STEP 08) or at the normal release's own candidate verification.
3. **Migration failure** — Migration Preflight returns `BLOCKED`, or any
   migration's `up()` throws during STEP 12's own migration phase.
4. **Data integrity mismatch** — any unrelated table's row count changed
   unexpectedly between the pre-deploy and post-deploy snapshot (§6).
5. **Activation failure** — the atomic swap itself fails (I-2/I-3/I-4
   territory) — this is expected to self-resolve via the Release
   Engine's own automatic rollback; a **FAILED-SAFE** state specifically
   is not self-resolving and requires manual operator intervention
   before anything else proceeds.
6. **Health check failure** — any of `/health`, `/health/db`,
   `/health/deep` returning a non-200 or a `false`/error component
   post-swap (expected to trigger automatic rollback; confirm it did).
7. **Any discrepancy between the observed Hosting state and this
   document's expected baseline** — including but not limited to: the
   Application Root not matching what was assumed, a file that should
   exist not existing, a configured env var
   (`RELEASE_DEPLOY_ROOT`/`RELEASE_ACTIVE_DIRNAME`/`RELEASE_HEALTH_BASE_URL`/
   `RELEASE_SMOKE_GET_ENDPOINTS`) reading something this document did not
   anticipate.

On any of the above: capture the exact evidence (error text, hash
values, status), do not retry the same action a second time hoping for
a different result, and report back before any further action.

---

## B. Bootstrap Flow (see §2, §3, Phase I-II of §8)

## C. Normal Release Flow (see §4, Phase III of §8)

## D. Rollback Flow (see §7)

## E. Operator Checklist (see §8, STEP 01 through STEP 14)

## F. Required Evidence (consolidated)

- Local: full regression output (`215/215`+), build output x2,
  `dependencies_resolve` direct-check JSON, `--verify` output for every
  package built.
- Bootstrap: before-hash, after-hash, restart confirmation, STEP 08's
  full `checks[]` output.
- Release: STEP 10's build/verify output, STEP 11's backup-link
  confirmation, STEP 12's full audit trail, STEP 13/14's health and
  functional-area evidence.
- All of the above, plus the operator identity and UTC timestamps,
  belong in the audit record — kept separate for the Bootstrap Hotfix
  (`_release-output/bootstrap-hotfix-a2f8001/BOOTSTRAP_HOTFIX_INSTRUCTIONS.md`'s
  own template) versus the Normal Release (this document's §8 evidence
  columns), per your explicit instruction to keep the two clearly apart.
