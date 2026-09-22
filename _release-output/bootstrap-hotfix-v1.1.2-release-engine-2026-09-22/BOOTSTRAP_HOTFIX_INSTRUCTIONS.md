# Release Engine Bootstrap Hotfix — v1.1.2 preparation (COMPLETE, 5 files)

> **PRODUCTION STATUS: HOLD.** This package is a **bootstrap prerequisite
> only** — it prepares the currently-running Production Release Engine to
> be *able* to correctly accept v1.1.2 later. Applying this package:
> - does **NOT** deploy v1.1.2,
> - does **NOT** run any migration,
> - does **NOT** modify the Production database in any way,
> - does **NOT** grant permissions or touch any application data,
> - **only** replaces five compiled Release Engine runtime `.js` files
>   (plus their `.map` sidecars) under `dist/foundation/release/`.
>
> Deploying v1.1.2 (Phase 7 below) is a **separate, explicitly-approved**
> action that happens only after this bootstrap is verified live — never
> automatically, never as part of applying this package.

**One-time, manual, out-of-band Release Engine hotfix — not an
application release.** Performed only by an authorized Hosting operator
with direct server access. Claude Code has no server/SSH access and
cannot execute any step below.

## Why this package replaces the earlier 3-file one

An earlier version of this bootstrap shipped only 3 files
(`staged-activation.service.js`, `release-execution.service.js`,
`expand-contract-guard.js`). **That version is incomplete and must not
be applied** — the current `release-execution.service.js` also
`require()`s a brand-new file, `artifact-integrity.js`, that file never
existed on Production in any form before. Applying the 3-file package
alone would make the application crash at boot with `MODULE_NOT_FOUND`.

This package was built by tracing every `.ts` file actually modified in
`backend/src/foundation/release/` this session (`git log --name-only`,
cross-checked against the full transitive `require()` graph of
`release-execution.service.js`) — five files, no more, no less:

| # | File | What changed | Source commit |
|---|------|---------------|----------------|
| 1 | `staged-activation.service.js` | `buildCandidate()` copies the candidate's OWN `package.json`/`package-lock.json` instead of silently keeping ACTIVE's | `a2f8001` |
| 2 | `release-execution.service.js` | (a) expand/contract violation always aborts, no config escape hatch; (b) `verifyMigrationsComplete()` — migration phase reporting success is independently re-verified before swap; (c) `verifyArtifactIntegrity()` — candidate bytes vs. manifest checksums, checked before migrations run | `1876ede`, `35d2181` |
| 3 | `expand-contract-guard.js` | `DROP CONSTRAINT "X"` is no longer flagged if the same migration re-adds `ADD CONSTRAINT "X"` under the identical name (the safe CHECK-widening idiom) | `55a321c` |
| 4 | `artifact-integrity.js` | **NEW FILE.** Candidate-vs-manifest checksum verification, `require()`d by #2 | `35d2181` |
| 5 | `release.controller.js` | `GET /releases/:id/migrations` now returns only the LATEST migration attempt (`MAX(startedAt)`), not every historical attempt ever recorded for a reused release id | `506de24` |

All five were rebuilt from a clean `dist/` (`rm -rf dist
tsconfig.build.tsbuildinfo && npm run build`) against current `HEAD`.
`staged-activation.service.js`'s hash is byte-identical to the original
`a2f8001` bootstrap's own hash — independent confirmation this build is
deterministic and that file hasn't drifted.

## Package contents

```
staged-activation.service.js         REQUIRED
staged-activation.service.js.map     optional (stack-trace fidelity)
release-execution.service.js         REQUIRED
release-execution.service.js.map     optional
expand-contract-guard.js             REQUIRED
expand-contract-guard.js.map         optional
artifact-integrity.js                REQUIRED — new file, release-execution.service.js will fail to load without it
artifact-integrity.js.map            optional
release.controller.js                REQUIRED
release.controller.js.map            optional
SHA256SUMS.txt                       checksums of the ten files above
BOOTSTRAP_HOTFIX_INSTRUCTIONS.md     this document
```

`SHA256SUMS.txt`:
```
7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373  staged-activation.service.js
6414695e038b546dd6ba0d725f72f53078bbc1d61702d7a725b9b2993ab90735  staged-activation.service.js.map
c15508334f324688219f9eee11fe2dfb24e9966fe369e55d1482a5ba0a27b826  release-execution.service.js
693e14a6a6b07edf3b26f5ffa4a8bc39149cb3570ec2a7511dddaff033afa90e  release-execution.service.js.map
b824fb230d41bae3da04aa19ee8776a7915a3d8337c67232b0f328ab074dec26  expand-contract-guard.js
7b940e167c1d29e29369f422b9fdbd7a4621d68eca6c86e1e81a8e00725d5338  expand-contract-guard.js.map
24ce2efe3136afd10b155de52311e4a3278c507bcee76a2cb7c80566d6dd4854  artifact-integrity.js
31cd5fda844c6374b013d779746713a3066c6f480584c1aa4f147e6a29c9492e  artifact-integrity.js.map
029bf74c2e1c820db8b7762b26af7b33b8231610c8887342c7c8c7ae3117ebc2  release.controller.js
d95db59618da4d2df06bea5d3745c2630c691846acccfdc05583c127ebde3035  release.controller.js.map
```
Verify after transfer: `sha256sum -c SHA256SUMS.txt` (must report all ten `OK`).

## Target paths — one row per file, exact destination on the server

Claude Code has no server/SSH access and cannot confirm these against
the real filesystem. Application Root, per the CTO's own directive,
consistent with this repository's layout:

```
/home/xnexdrgr/daii.xnexustech.com/release-new/backend
```

| Package file | Exact destination path |
|---|---|
| `staged-activation.service.js` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js` |
| `staged-activation.service.js.map` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js.map` |
| `release-execution.service.js` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js` |
| `release-execution.service.js.map` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js.map` |
| `expand-contract-guard.js` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js` |
| `expand-contract-guard.js.map` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js.map` |
| `artifact-integrity.js` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/artifact-integrity.js` |
| `artifact-integrity.js.map` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/artifact-integrity.js.map` |
| `release.controller.js` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release.controller.js` |
| `release.controller.js.map` | `/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release.controller.js.map` |

All ten files land in the **same directory** — only the filenames
differ. `artifact-integrity.js`/`.js.map` do not currently exist at that
path at all (this is a genuinely new file); the other four pairs
**replace** files that already exist there.

**Phase 1 below exists precisely because none of this can be confirmed
remotely — the operator confirms it for real, on the real server, before
anything is touched.**

---

## PHASE 1 — PRE-CHECK (read-only; do not modify anything yet)

1. Confirm the Application Root is real:
   ```bash
   ls -ld /home/xnexdrgr/daii.xnexustech.com/release-new/backend
   ```
2. Confirm the target directory exists and list its current state:
   ```bash
   ls -l /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/
   ```
3. Record the CURRENT (before-hotfix) SHA-256 of the four files being
   **replaced** (skip `artifact-integrity.js*` — it shouldn't exist yet):
   ```bash
   sha256sum \
     /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js \
     /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js \
     /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js \
     /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release.controller.js
   ```
4. Check whether `artifact-integrity.js` already exists (it should NOT):
   ```bash
   ls -l /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/artifact-integrity.js 2>&1
   ```
   Expected: "No such file or directory". If it DOES exist, stop and
   report back — that means a different/later state than assumed here.
5. Confirm the Node process / application identity (cPanel → Setup
   Node.js App, or `ps aux | grep node`), and the currently-active
   release/version the app reports (`GET /api/releases/version` or
   equivalent).
6. **STOP condition**: if the Application Root does not exist, if the
   target directory looks structurally different from what's described
   here, or if `artifact-integrity.js` already exists — **do not
   proceed**. Report back with what was actually found.

## PHASE 2 — BACKUP

1. Create a timestamped backup directory **outside** the path being
   replaced:
   ```bash
   BACKUP_DIR="/home/xnexdrgr/bootstrap-hotfix-backups/$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$BACKUP_DIR"
   ```
2. Copy the four EXISTING target files into it (there is nothing to back
   up for `artifact-integrity.js*`, since it doesn't exist yet):
   ```bash
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/staged-activation.service.js "$BACKUP_DIR/"
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release-execution.service.js "$BACKUP_DIR/"
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/expand-contract-guard.js "$BACKUP_DIR/"
   cp /home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release/release.controller.js "$BACKUP_DIR/"
   ```
3. Record, for the audit log at the bottom of this document: the four
   original SHA-256 values (from Phase 1 step 3), `$BACKUP_DIR`, and the
   UTC timestamp.

## PHASE 3 — REPLACEMENT (only these ten files, nothing else)

1. Transfer this bootstrap package's ten files to the server.
2. Verify the transferred copies match `SHA256SUMS.txt` **before**
   touching anything on the server:
   ```bash
   sha256sum -c SHA256SUMS.txt
   ```
   All ten lines must read `OK`. If not, stop — re-transfer, do not
   proceed with a mismatched file.
3. Replace, in place (using the exact destination paths from the table
   above):
   ```bash
   D=/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release
   cp staged-activation.service.js       "$D/staged-activation.service.js"
   cp staged-activation.service.js.map   "$D/staged-activation.service.js.map"
   cp release-execution.service.js       "$D/release-execution.service.js"
   cp release-execution.service.js.map   "$D/release-execution.service.js.map"
   cp expand-contract-guard.js           "$D/expand-contract-guard.js"
   cp expand-contract-guard.js.map       "$D/expand-contract-guard.js.map"
   cp artifact-integrity.js              "$D/artifact-integrity.js"
   cp artifact-integrity.js.map          "$D/artifact-integrity.js.map"
   cp release.controller.js              "$D/release.controller.js"
   cp release.controller.js.map          "$D/release.controller.js.map"
   ```
   Do **not**: edit any source `.ts` file on Production, run `npm
   install`, run `npm audit fix`, rebuild on Production, or touch
   `package.json`/`package-lock.json`. This hotfix is exactly these ten
   files, full stop.

## PHASE 4 — VERIFY (immediately after replacement)

```bash
D=/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release
sha256sum "$D"/staged-activation.service.js "$D"/release-execution.service.js "$D"/expand-contract-guard.js "$D"/artifact-integrity.js "$D"/release.controller.js
```
Compare against `SHA256SUMS.txt`. **If any hash does not match: STOP
immediately and follow the Rollback procedure below.**

## PHASE 5 — RESTART

Restart via the existing supported mechanism only (cPanel → Setup
Node.js App → Restart, or this environment's documented equivalent).
**Never** a manual `kill`/direct process signal. Do not change any
application configuration.

## PHASE 6 — POST-RESTART VERIFICATION

1. The Node process is running (cPanel status, or `ps aux | grep node`).
2. The application responds (a plain `GET /` returns a response, not a
   connection error).
3. Login / an authenticated health check works (e.g. `GET
   /api/releases/version` returns the expected version) — this also
   proves the app booted without a `MODULE_NOT_FOUND` or syntax error
   from any of the five replaced modules.
4. No startup errors in the application's own logs (`stderr.log` /
   equivalent) reference any of: `staged-activation.service.js`,
   `release-execution.service.js`, `expand-contract-guard.js`,
   `artifact-integrity.js`, `release.controller.js`.
5. Re-run the Phase 4 hash check once more — confirms nothing else
   touched these files during restart.

Only once all five pass is the Bootstrap Hotfix considered live.

## PHASE 7 — NORMAL RELEASE (only after Phase 6 passes in full)

1. Upload the already-built, already-verified `v1.1.2` package:
   `Daii-Release-v1.1.2-2026-09-22.zip`.
2. **Before** uploading, verify the ZIP's own SHA-256:
   ```bash
   sha256sum Daii-Release-v1.1.2-2026-09-22.zip
   ```
   Must read exactly:
   ```
   de7c92ee9e23764c18b2a66c1484de86ca78a5b7ec46b4a0bc361f32c7919c8b
   ```
   Do not alter the ZIP if it doesn't match — re-obtain it instead. Any
   ZIP with a different filename or an older date is superseded; do not
   use it.
3. Register/upload as normal.
4. Run/inspect Deploy Preflight.
5. Inspect Candidate Verification's result in full.
6. **STOP if Candidate Verification fails** — report the exact failure
   back. **Do NOT click Deploy** even if verification passes — that is a
   separate, explicitly-approved step, not automatic from here.

## ROLLBACK PROCEDURE

If anything goes wrong at any phase from 3 onward:

1. Stop/restart the application safely if it is currently in a bad
   state (same supported mechanism as Phase 5 — never a manual kill).
2. Restore the four ORIGINAL files from the Phase 2 backup, and DELETE
   `artifact-integrity.js`/`.js.map` (they never existed before this
   hotfix, so rollback means removing them, not restoring them):
   ```bash
   D=/home/xnexdrgr/daii.xnexustech.com/release-new/backend/dist/foundation/release
   cp "$BACKUP_DIR/staged-activation.service.js"  "$D/staged-activation.service.js"
   cp "$BACKUP_DIR/release-execution.service.js"  "$D/release-execution.service.js"
   cp "$BACKUP_DIR/expand-contract-guard.js"      "$D/expand-contract-guard.js"
   cp "$BACKUP_DIR/release.controller.js"         "$D/release.controller.js"
   rm -f "$D/artifact-integrity.js" "$D/artifact-integrity.js.map"
   ```
3. Verify the restored files' SHA-256 match the **original** (before-
   hotfix) hashes recorded in Phase 1 step 3 / Phase 2 step 3.
4. Restart via the same supported mechanism as Phase 5.
5. Repeat Phase 6's post-restart verification against the restored
   (original) state.

## SAFETY BOUNDARY — this hotfix does NOT touch data

This package contains **only** the five compiled Release Engine modules
above. It does not run migrations, does not grant permissions, does not
correct terminology data, and does not change any Production data.
Those are v1.1.2's normal controlled release content and happen only
through Phase 7 → an explicitly-approved deploy, never through this
hotfix.

## Audit record — to be completed by the operator during execution

```
BOOTSTRAP HOTFIX — v1.1.2-release-engine, COMPLETE (5 files)

Previous active version:                    ____________________
Files changed (all under backend/dist/foundation/release/):
  staged-activation.service.js (+ .map)
  release-execution.service.js (+ .map)
  expand-contract-guard.js (+ .map)
  artifact-integrity.js (+ .map)   [NEW — did not exist before]
  release.controller.js (+ .map)

Before SHA-256 (staged-activation.service.js):   ____________________
Before SHA-256 (release-execution.service.js):   ____________________
Before SHA-256 (expand-contract-guard.js):       ____________________
Before SHA-256 (release.controller.js):          ____________________

After SHA-256 (staged-activation.service.js):    7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373  (must match)
After SHA-256 (release-execution.service.js):    c15508334f324688219f9eee11fe2dfb24e9966fe369e55d1482a5ba0a27b826  (must match)
After SHA-256 (expand-contract-guard.js):        b824fb230d41bae3da04aa19ee8776a7915a3d8337c67232b0f328ab074dec26  (must match)
After SHA-256 (artifact-integrity.js):           24ce2efe3136afd10b155de52311e4a3278c507bcee76a2cb7c80566d6dd4854  (must match)
After SHA-256 (release.controller.js):           029bf74c2e1c820db8b7762b26af7b33b8231610c8887342c7c8c7ae3117ebc2  (must match)

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
