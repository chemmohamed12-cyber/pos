# Release Engine Bootstrap Hotfix — v1.1.2 preparation (3 files)

> **PRODUCTION STATUS: HOLD.** This package is a **bootstrap prerequisite
> only** — it prepares the currently-running Production Release Engine to
> be *able* to correctly accept v1.1.2 later. Applying this package:
> - does **NOT** deploy v1.1.2,
> - does **NOT** run any migration,
> - does **NOT** modify the Production database in any way,
> - does **NOT** grant permissions or touch any application data,
> - **only** replaces three compiled Release Engine runtime `.js` files
>   (plus their optional `.map` sidecars) under `dist/foundation/release/`.
>
> Deploying v1.1.2 (Phase 7 below) is a **separate, explicitly-approved**
> action that happens only after this bootstrap is verified live — never
> automatically, never as part of applying this package.

**One-time, manual, out-of-band Release Engine hotfix — not an application
release.** It does not go through the Release Center's own upload/
candidate-verification flow, by necessity: the flow it would go through is
itself the thing being fixed. Performed only by an authorized Hosting
operator with direct server access. Claude Code has no server/SSH access
and cannot execute any step below — this document exists so a human
operator can.

## Package identity

```
File: bootstrap-hotfix-v1.1.2-release-engine-2026-09-22.zip
```

This document is packaged inside the ZIP it describes, so its own text
cannot embed that ZIP's final hash without invalidating it the moment
it's written (editing this line changes the ZIP, which changes the
hash). **The authoritative SHA-256 for this exact package is the one
recorded in the delivery report that accompanied it** — verify the
transferred file against that value, not against any hash that might
appear elsewhere in this document. `SHA256SUMS.txt` (inside this
package) covers the six actual runtime/map files that get applied to
Production — verify those against `SHA256SUMS.txt` directly; that
file's own checks are self-consistent regardless of the outer ZIP's hash.

## Why this is needed now

Uploading the already-built v1.1.2 package (an earlier build,
`Daii-Release-v1.1.2-2026-09-21.zip`) to Production's Release Center
failed Candidate Verification with:

```
dependencies_resolve: missing from node_modules: @types/yauzl
```

Direct comparison proves this is production's `buildCandidate()` still
copying **ACTIVE's own stale `package.json`** instead of the candidate's
own — the exact pre-`a2f8001` bug. The 20-entry dependency list the
failed verification checked is byte-for-byte identical to
`backend/package.json`'s `dependencies` section as it existed **before**
commit `a8a277d` (which moved `@types/yauzl` to `devDependencies`,
months before this session). The locally-built package's own
`package.json` is correct (19 runtime deps, `@types/yauzl` correctly
under `devDependencies`) and its own compiled `staged-activation.service.js`
already contains the `a2f8001` fix — but that fix only takes effect
if it is the code actually *running* on the server at candidate-build
time. It evidently is not: the original `a2f8001` Bootstrap Hotfix's
effect is not present on production's currently-running Release Engine —
either it never fully took hold, or a later deploy overwrote it with an
older compiled file. This is a bootstrap deadlock, same shape as before:
the running Release Engine is too broken to correctly build/verify the
release that would fix it, so it must be corrected directly, out-of-band,
first.

A second, independent issue surfaced while testing the same package
against the (now-fixed) expand/contract gate: two of v1.1.2's own
migrations — which only ever *widen* a CHECK constraint's allowed values
(`DROP CONSTRAINT "X"` + `ADD CONSTRAINT "X"` under the identical name,
the only mechanism Postgres offers for this, since there is no `ALTER
CHECK CONSTRAINT`) — were incorrectly flagged as an unsafe contraction by
a per-statement scanner that couldn't see the same name gets redefined
right after the drop. Fixed in commit `55a321c`
(`expand-contract-guard.ts`), which is why this hotfix now ships three
files, not two: the fixed scanner lives in its own compiled file,
separate from `release-execution.service.js`, which `require()`s it at
runtime.

## What this fixes (three files, three independent fixes)

### 1. `staged-activation.service.js` — restore the `a2f8001` fix

Source: `backend/src/foundation/release/staged-activation.service.ts`,
commit `a2f8001` (already merged, unchanged since). `buildCandidate()`
copies `package.json` and `package-lock.json` from the upload's own
staging directory into the candidate, unconditionally, before the
candidate is ever verified — instead of silently keeping whatever
ACTIVE's own copies of those two files already were.

### 2. `release-execution.service.js` — Release Engine gate integrity (NEW, commit `1876ede`)

Production Incident 2026-09-22 (release `395ca725-bc1f-4db2-8ebe-f54eecb7ebbd`):
audit trail showed `expand_contract_violation` recorded DENIED
immediately followed by `swapped SUCCESS` — a denied gate did not stop
the deploy, because `RELEASE_EXPAND_CONTRACT_ENFORCE=false` in
production's environment let the violation fall through to a warning
log instead of aborting. Separately, four `SeedAdminPermissionsFor*`
migrations shipped in `v1.1.1` were never recorded as executed
(confirmed via production's `migrations` and `release_migration_runs`
tables), yet that same deploy still reached `succeeded` — proving
`runReleaseMigrations()` not throwing had been (wrongly) trusted as
proof the release's own migrations actually ran. This file:

- Removes the `RELEASE_EXPAND_CONTRACT_ENFORCE` escape hatch entirely —
  a detected expand/contract violation now **always** throws
  (`PreSwapAbort`) before swap, regardless of any config value.
- Adds `verifyMigrationsComplete()`, called immediately after
  `runReleaseMigrations()` and before the atomic swap: it re-derives
  pending-migration state fresh (same `MigrationExecutor` source of
  truth, never a hand-rolled diff) and cross-checks it against every
  migration the release's own manifest ships. A non-empty result — the
  migration phase did not actually complete, or its state is uncertain —
  aborts pre-swap instead of proceeding on trust.
- Migration Preflight's existing `BLOCKED → abort` gate ([already
  unconditional, no config escape hatch]) is unchanged by this fix; it
  is included here only because this file is the one that calls it, and
  this hotfix ships the file as a whole.

### 3. `expand-contract-guard.js` — stop flagging same-name CHECK constraint redefinition (NEW, commit `55a321c`)

`DROP CONSTRAINT "X"` is no longer flagged if the same migration's `up()`
re-adds `ADD CONSTRAINT "X"` under that identical name anywhere later in
the body — the standard, safe Postgres idiom for widening an enum-like
CHECK constraint. A bare drop with no same-name recreation, or a drop
followed by an add under a *different* name (an effective rename), is
still blocked exactly as before. This directly unblocks v1.1.2's own
`1789760000000-AddTransientDatabaseErrorClosingExceptionCategory.ts` and
`1789730300000-AddBiometricDailySummaryImport.ts`, both of which only
ever widen a CHECK constraint.

Net effect for all three fixes together, matching invariant proofs in
`backend/src/foundation/release/release-execution-gates.spec.ts` and
`backend/src/foundation/release/expand-contract-guard.spec.ts`:
- expand/contract DENIED → NO SWAP, NO RESTART, NO SUCCEEDED (always,
  not conditionally)
- a genuine same-name CHECK-widening migration → NOT flagged (no longer
  a false positive)
- a genuine unstaged/renamed DROP CONSTRAINT → still flagged
- Migration Preflight BLOCKED → NO SWAP, NO RESTART, NO SUCCEEDED
- a migration this release ships, still pending after "successful"
  execution → NO SWAP, NO RESTART, NO SUCCEEDED

## Source commits this hotfix is built from

```
a2f8001  fix(release): buildCandidate() now copies the candidate's OWN
         package.json/package-lock.json, not just ACTIVE's stamped
         version string          (staged-activation.service.ts)
1876ede  fix(release): close expand/contract escape hatch, add
         post-migration completeness gate
                                  (release-execution.service.ts)
55a321c  fix(release): stop flagging same-name CHECK constraint
         redefinition as a contraction
                                  (expand-contract-guard.ts)
```

All three files were rebuilt from a clean `dist/` (`rm -rf dist
tsconfig.build.tsbuildinfo && npm run build`) against current
`HEAD` (`55a321c`), which contains all three commits above and nothing
else new. `staged-activation.service.js`'s hash below is
**byte-identical** to the original `a2f8001` bootstrap package's own
hash, and `release-execution.service.js`'s hash is byte-identical to
this hotfix's own first version — independent confirmation this build is
deterministic and neither file has drifted since.

## Package contents

```
staged-activation.service.js        restores the a2f8001 fix — REQUIRED
staged-activation.service.js.map    source map — OPTIONAL, stack-trace fidelity only
release-execution.service.js        gate-integrity fix (commit 1876ede) — REQUIRED
release-execution.service.js.map    source map — OPTIONAL, stack-trace fidelity only
expand-contract-guard.js            CHECK-constraint false-positive fix (commit 55a321c) — REQUIRED
expand-contract-guard.js.map        source map — OPTIONAL, stack-trace fidelity only
SHA256SUMS.txt                      checksums of the six files above
BOOTSTRAP_HOTFIX_INSTRUCTIONS.md    this document
```

`SHA256SUMS.txt`:
```
7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373  staged-activation.service.js
6414695e038b546dd6ba0d725f72f53078bbc1d61702d7a725b9b2993ab90735  staged-activation.service.js.map
76eeb7c363f27352c5c0b7a3d320ab3ad159bdd96c748bb45c613b343bc0bd19  release-execution.service.js
925fa64b69d678edab67e5d62e0b6eaf68aebbf900e99e56737ffa9307b2f60d  release-execution.service.js.map
b824fb230d41bae3da04aa19ee8776a7915a3d8337c67232b0f328ab074dec26  expand-contract-guard.js
7b940e167c1d29e29369f422b9fdbd7a4621d68eca6c86e1e81a8e00725d5338  expand-contract-guard.js.map
```
Verify after transfer: `sha256sum -c SHA256SUMS.txt` (must report all six `OK`).

This bootstrap folder, zipped, has its own package checksum — see
**Package identity** at the top of this document.

## Target paths — NOT independently verified against the live server

Claude Code has no server/SSH access and cannot confirm these paths
against the real filesystem. They are supplied by the CTO's own
directive and are internally consistent with this repository's own
directory layout (`backend/dist/foundation/release/...` under an
application root ending in `.../release-new/backend`), and with the
path shape used in the original `a2f8001` Bootstrap Hotfix
(`<ApplicationRoot>/backend/dist/foundation/release/...`). **Phase 1
below exists precisely because this cannot be confirmed remotely — the
operator confirms it for real, on the real server, before anything is
touched.**

```
Application Root:
  /home/xnexdrgr/daii.xnexustech.com/release-new/backend

Target file 1:
  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js

Target file 2:
  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js

Target file 3:
  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js
```

---

## PHASE 1 — PRE-CHECK (read-only; do not modify anything yet)

1. Confirm the Application Root is real and matches:
   ```bash
   ls -ld /home/xnexdrgr/daii.xnexustech.com/release-new/backend
   ```
2. Confirm all three target files exist at the exact paths above:
   ```bash
   ls -l /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js \
         /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js \
         /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js
   ```
3. Record the CURRENT (before-hotfix) SHA-256 of all three target files:
   ```bash
   sha256sum /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js \
             /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js \
             /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js
   ```
   Expect `staged-activation.service.js`'s current hash to differ from
   `7fb1e3d8...` above (if it already matches, the `a2f8001` fix is
   somehow already live there and this part of the hotfix is a no-op —
   proceed anyway for the other two files, and note the discrepancy in
   the audit record below).
4. Confirm the Node process / application identity (cPanel → Setup
   Node.js App, or `ps aux | grep node` — whichever this environment's
   documented procedure already is), and confirm the currently-active
   release/version the app reports (`GET /api/releases/version` or
   equivalent).
5. **STOP condition**: if the Application Root does not exist, if either
   target file is missing, or if the path structure looks meaningfully
   different from what's declared above (e.g. a different directory
   depth, a symlink pointing somewhere unexpected) — **do not proceed**.
   Report back with what you actually found instead.

## PHASE 2 — BACKUP

1. Create a timestamped backup directory **outside** the path being
   replaced, e.g.:
   ```bash
   BACKUP_DIR="/home/xnexdrgr/bootstrap-hotfix-backups/$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$BACKUP_DIR"
   ```
2. Copy all three target files into it, preserving names:
   ```bash
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js "$BACKUP_DIR/"
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js "$BACKUP_DIR/"
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js "$BACKUP_DIR/"
   ```
3. Record, for the audit log at the bottom of this document:
   - all three files' original SHA-256 (from Phase 1 step 3)
   - `$BACKUP_DIR` (the exact path)
   - the UTC timestamp

## PHASE 3 — REPLACEMENT (only the three files, nothing else)

1. Transfer this bootstrap package's six files to the server (any
   secure transfer method already in use for this environment).
2. Verify the transferred copies match `SHA256SUMS.txt` **before**
   touching anything on the server:
   ```bash
   sha256sum -c SHA256SUMS.txt
   ```
   All six lines must read `OK`. If not, stop — re-transfer, do not
   proceed with a mismatched file.
3. Replace, in place:
   ```bash
   cp staged-activation.service.js  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js
   cp staged-activation.service.js.map  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js.map
   cp release-execution.service.js  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js
   cp release-execution.service.js.map  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js.map
   cp expand-contract-guard.js  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js
   cp expand-contract-guard.js.map  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js.map
   ```
   Do **not**: edit any source `.ts` file on production, run `npm
   install`, run `npm audit fix`, rebuild on production, or touch
   `package.json`/`package-lock.json`. This hotfix is six files (three
   pairs), full stop.

## PHASE 4 — VERIFY (immediately after replacement)

```bash
sha256sum /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js \
          /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js \
          /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js
```
Compare against `SHA256SUMS.txt`. **If any hash does not match:
STOP immediately and follow the Rollback procedure below** — do not
restart the application with a partially-applied or corrupted hotfix.

## PHASE 5 — RESTART

Restart via the existing supported mechanism only (cPanel → Setup
Node.js App → Restart, or this environment's documented equivalent).
**Never** a manual `kill`/direct process signal. Do not change any
application configuration as part of this step.

## PHASE 6 — POST-RESTART VERIFICATION

Confirm, in order:
1. The Node process is running (cPanel status, or `ps aux | grep node`).
2. The application responds (a plain `GET /` or the app's own root
   health path returns a response, not a connection error).
3. Login / an authenticated health check works (e.g. an existing user
   can log in, or `GET /api/releases/version` returns the expected
   current version — confirms the app booted without a startup
   exception, which would also prove the Release Engine module loaded
   these two replaced files without a syntax/require error).
4. No startup errors reference `staged-activation.service.js`,
   `release-execution.service.js`, or `expand-contract-guard.js` in the
   application's own logs (`stderr.log` / equivalent).
5. Re-run the Phase 4 hash check once more — confirms nothing else
   touched these two files during restart.

Only once all five pass is the Bootstrap Hotfix considered live.

## PHASE 7 — NORMAL RELEASE (only after Phase 6 passes in full)

1. Upload the already-built, already-fixed `v1.1.2` package
   (`Daii-Release-v1.1.2-2026-09-22.zip` — the rebuild that contains the
   `expand-contract-guard.ts` fix; the earlier `...-2026-09-21.zip` is
   superseded, do not use it) through the Release Center's normal upload
   flow.
2. **Before** uploading, verify the ZIP's own SHA-256 has not changed:
   ```bash
   sha256sum Daii-Release-v1.1.2-2026-09-22.zip
   ```
   Must read exactly:
   ```
   b790572e160ac7c9c2817ff40e736ad9ce4c89dcd015c90b5b74867c7d7fa5f7
   ```
   Do not alter the ZIP in any way if it doesn't match — re-obtain it
   instead.
3. Register/upload as normal.
4. Run/inspect Deploy Preflight.
5. Inspect Candidate Verification's result in full.
6. **STOP if Candidate Verification fails** — report the exact failure
   back rather than retrying blindly. **Do NOT click Deploy** even if
   verification passes — that is a separate, explicitly-approved step,
   not automatic from here.

## ROLLBACK PROCEDURE

If anything goes wrong at any phase from 3 onward:

1. Stop/restart the application safely if it is currently in a bad
   state (same supported mechanism as Phase 5 — never a manual kill).
2. Restore **all three** original files from the Phase 2 backup:
   ```bash
   cp "$BACKUP_DIR/staged-activation.service.js"  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js
   cp "$BACKUP_DIR/release-execution.service.js"  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js
   cp "$BACKUP_DIR/expand-contract-guard.js"  /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js
   ```
3. Verify the restored files' SHA-256 match the **original** (before-
   hotfix) hashes recorded in Phase 1 step 3 / Phase 2 step 3.
4. Restart via the same supported mechanism as Phase 5.
5. Repeat Phase 6's post-restart verification against the restored
   (original) state.

This hotfix touches exactly three files (plus optional maps), so
rollback is always a three-file restore, never a full release rollback.

## SAFETY BOUNDARY — this hotfix does NOT touch data

This package contains **only** the three compiled Release Engine files
above. It does not run migrations, does not grant permissions, does not
correct terminology data, and does not change any Production data.
Those are v1.1.2's normal controlled release content and happen only
through Phase 7 → an explicitly-approved deploy, never through this
hotfix.

## Audit record — to be completed by the operator during execution

```
BOOTSTRAP HOTFIX — v1.1.2-release-engine (staged-activation.service.ts @ a2f8001, release-execution.service.ts @ 1876ede, expand-contract-guard.ts @ 55a321c)

Previous active version:                    ____________________
Files changed:
  backend/dist/foundation/release/staged-activation.service.js
  backend/dist/foundation/release/staged-activation.service.js.map (optional)
  backend/dist/foundation/release/release-execution.service.js
  backend/dist/foundation/release/release-execution.service.js.map (optional)
  backend/dist/foundation/release/expand-contract-guard.js
  backend/dist/foundation/release/expand-contract-guard.js.map (optional)

Before SHA-256 (staged-activation.service.js):   ____________________
Before SHA-256 (release-execution.service.js):   ____________________
Before SHA-256 (expand-contract-guard.js):       ____________________
After SHA-256 (staged-activation.service.js):    7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373  (must match)
After SHA-256 (release-execution.service.js):    76eeb7c363f27352c5c0b7a3d320ab3ad159bdd96c748bb45c613b343bc0bd19  (must match)
After SHA-256 (expand-contract-guard.js):        b824fb230d41bae3da04aa19ee8776a7915a3d8337c67232b0f328ab074dec26  (must match)

Operator:                                    ____________________
Timestamp (UTC):                             ____________________
Backup location ($BACKUP_DIR):               ____________________
Rollback procedure followed:                 [ ] not needed  [ ] executed — reason: ____________________
Post-restart verification result (Phase 6):  ____________________
Phase 7 Candidate Verification result:       ____________________
```

Keep this audit record clearly separate from any ERP application
release record — this is a Release Engine infrastructure hotfix, not an
application deployment.
