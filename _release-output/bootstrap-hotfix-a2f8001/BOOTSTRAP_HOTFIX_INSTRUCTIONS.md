# Release Engine Bootstrap Hotfix — commit `a2f8001`

**This is a one-time, manual, out-of-band Release Engine hotfix — separate
from and never to be confused with a normal application release.** It does
not go through the Release Center's own upload/candidate-verification
flow, by necessity: it is the fix for a bug IN that flow, so it cannot be
delivered through it (the currently-active, pre-fix code is exactly what
would reject it). Performed only by an authorized Hosting operator with
direct server access. Claude Code has no server/SSH access and cannot
execute any step below — this document exists so a human operator can.

## What this fixes

`StagedActivationService.buildCandidate()` built every release candidate
by copying the **currently-active** release's own `package.json`/
`package-lock.json` first, then only overlaying files explicitly listed
in the manifest's `files[]` array — which never includes `package.json`/
`package-lock.json` for any package type (`generate_manifest()` in
`build-release.sh` only ever scans `src/`, `dist/`, `public/`). The
result: no uploaded candidate's own dependency declarations could ever
actually reach the `dependencies_resolve` verification check — it always
re-checked whatever the *active* release's `package.json` already had,
which is why `v1.1.0` and `v1.1.1` failed with the byte-identical error
despite the uploaded packages themselves being correct (independently
re-verified — see the session's own report).

The fix (source: `backend/src/foundation/release/staged-activation.service.ts`,
commit `a2f8001`): `buildCandidate()` now copies `package.json` and
`package-lock.json` from the upload's own staging directory into the
candidate, unconditionally, before the candidate is ever verified. This
package contains the ONE compiled file that changed.

## Package contents

```
staged-activation.service.js       the corrected compiled file — REQUIRED
staged-activation.service.js.map   its source map — OPTIONAL, for stack-trace fidelity only
SHA256SUMS.txt                     checksums of the two files above
BOOTSTRAP_HOTFIX_INSTRUCTIONS.md   this document
```

`SHA256SUMS.txt`:
```
7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373  staged-activation.service.js
6414695e038b546dd6ba0d725f72f53078bbc1d61702d7a725b9b2993ab90735  staged-activation.service.js.map
```
Verify after transfer: `sha256sum -c SHA256SUMS.txt` (must report both `OK`).

Rebuilt from a clean `dist/` (`rm -rf dist tsconfig.build.tsbuildinfo && npm run build`)
against the exact committed source at `a2f8001` — the hash is
deterministic and independently reproducible from that commit.

## Operator procedure (per the CTO's own numbered steps)

1. **Backup.** Take a complete backup/snapshot of the currently-active
   application directory (the Application Root's own backup/restore
   mechanism, or a plain file-level copy — whatever this deployment's
   documented backup procedure already is; `PRODUCTION_DEPLOYMENT_GUIDE.md`'s
   own conventions apply here, this is not a new mechanism).
2. **Record before-hashes.** Before touching anything, compute and record
   the SHA-256 of the file you are about to replace:
   ```bash
   sha256sum <ApplicationRoot>/backend/dist/foundation/release/staged-activation.service.js
   ```
   (Path per `PRODUCTION_DEPLOYMENT_GUIDE.md`'s documented layout —
   `Application Startup File: backend/dist/main.js`, so this file sits at
   `backend/dist/foundation/release/staged-activation.service.js` under
   the same Application Root. **Confirm the exact real path on your own
   server before proceeding** — this session cannot see it.)
3. **Identify the exact deployed artifact.** Confirm the file at that path
   is in fact the currently-running compiled `StagedActivationService`
   (e.g. `grep -c "FU-1: stamped" backend/dist/foundation/release/staged-activation.service.js`
   should find the old log line still present, confirming it's the
   pre-fix version — the fix keeps that log line too, so this alone
   isn't sufficient; cross-check the file's own current hash differs from
   `SHA256SUMS.txt`'s value, which it should, since this IS the fix).
4. **Apply ONLY this file(s).** Replace:
   ```
   <ApplicationRoot>/backend/dist/foundation/release/staged-activation.service.js
   ```
   with the `staged-activation.service.js` in this package (and its
   `.js.map`, optional). Do not touch any other file. Do not touch
   `package.json`, `node_modules`, migrations, or any business-domain
   file — this hotfix is scoped to exactly one Release Engine source
   file's compiled output.
5. **No business modules, no production data.** Confirmed scope above —
   nothing else in this package touches either.
6. **No `activity-log.json`.** Not touched by this hotfix.
7. **No recovered ERP data.** Not touched by this hotfix.
8. **Restart.** Restart/reload the application via the existing supported
   procedure (`PRODUCTION_DEPLOYMENT_GUIDE.md`: cPanel → Setup Node.js
   App → Restart, or this environment's equivalent). Never a manual
   `kill`/direct process signal.
9. **Verify the fix is live**, per the CTO's own stated check — build a
   throwaway candidate (or re-attempt the already-built `v1.1.1`
   candidate) and confirm its own `dependencies_resolve` check now reads
   from the **staged candidate's own** `package.json`/`package-lock.json`,
   not the active release's. Concretely: the probe array in any
   `dependencies_resolve` result should now match the candidate's own
   `package.json` `dependencies` keys exactly (19 entries, `decimal.js`
   present, `@types/yauzl` absent) — not the stale active-release array
   this incident's own error showed (missing `decimal.js`, containing
   `@types/yauzl`).

## Do NOT (explicit, per the CTO's own directive)

- Do not bypass Candidate Verification.
- Do not force-activate a failed candidate.
- Do not manually alter the ACTIVE application's `package.json` as a
  workaround — the fix is in the Release Engine's own candidate-build
  logic, not in any package.json content.
- Do not issue another application version before this hotfix is
  confirmed live and verified per step 9 — a new version would just
  repeat the same failed verification against the same unfixed code.

## Rollback procedure

If anything goes wrong: restore the pre-hotfix
`staged-activation.service.js` (and `.js.map`) from the backup taken in
step 1, restart the application the same way as step 8, and confirm
`sha256sum` matches the recorded before-hash. This hotfix touches exactly
one file, so rollback is a single-file restore, not a release rollback.

## Audit record — to be completed by the operator during execution

```
BOOTSTRAP HOTFIX — a2f8001

Previous active version:        ____________________
Files changed:                  backend/dist/foundation/release/staged-activation.service.js
                                 (backend/dist/foundation/release/staged-activation.service.js.map, optional)
Before SHA-256 (.js):            ____________________
After SHA-256 (.js):             7fb1e3d86fc33a7e2f2408c2ef35a762c85fef97c1313ef065bf2aec23f2c373  (must match after applying)
Operator:                        ____________________
Timestamp (UTC):                 ____________________
Backup location / reference:     ____________________
Rollback procedure followed:     [ ] not needed  [ ] executed — reason: ____________________
Verification result (step 9):    ____________________
```

Keep this audit record clearly separate from any ERP application release
record — this is a Release Engine infrastructure hotfix, not an
application deployment.

## After the bootstrap succeeds

Report back that step 9's verification passed. This session will then
rebuild the application Release Candidate from the corrected source,
issue the next version per the project's versioning rules, and run the
full sequence (dependency verification → migration verification → build
→ tests → manifest/SHA verification → candidate verification) before any
Hosting-test deployment — exactly as directed, with no verification
bypass at any step.
