# Repository hygiene — inventory and proposal (2026-10-11)

Status: **inventory + one safe fix done; no tracked file was removed.** Removal of tracked trees changes what a clone contains and what other people may rely on, so it is proposed here with evidence and left for approval. Source of counts: `git ls-files` at commit `1829794` (VERIFIED).

| Tree (tracked) | Files | What it is | Referenced by (VERIFIED by grep) | Proposal | Risk if removed |
|---|---|---|---|---|---|
| `backend.prev-b73290c0-…/` | 1,529 | A full snapshot of an earlier `backend/` (source, tools, `_deploy`, public) added in **one** commit | only `docs/decisions/WORKSPACE-RECOVERY-AND-PROJECT-STATUS-2026-10-10.md` (describes it as the recovery rollback copy) | Keep until the recovery record is closed, then `git rm -r` it on the main branch (full history stays retrievable by tag); tag the last commit that contains it | Loss of the quick rollback copy — mitigated by the tag |
| `backend/_deploy/staging/bootstrap-v1.0.3/` | 410 | Staged copy of a v1.0.3 bootstrap release (source + tools) | none from code; `tools/build/build-release.sh` writes **`_deploy/build`** (output dir), not `staging` | Move to the release-artifact store; ignore `_deploy/build|incoming|logs|manifests|previous|staging` via `.gitignore` | A reviewer cannot inspect the historic bootstrap package from the repo |
| `backend/_deploy/previous/src/` (+ `package*.json`) | 376 | Previous-release source copy used by the release engine's rollback | release engine design (runtime artifact), not a build input | Treat as runtime/artifact data, not source; ignore | None for builds; confirm the release engine recreates it |
| `backend/_deploy/incoming/*.zip` | 2 | Uploaded release zips | none | Artifact store | — |
| `_frontend-backup-2026-09-17-before-recovery-swap/` | 103 | Frontend source + public bundle backup before a recovery swap | none | Keep until the recovery record is closed, then remove (tag first) | As above |
| `_release-output/*.zip` (history; current ones untracked) | several | Built release packages (up to 3.9 MB each) | release procedure | Artifact store; keep out of Git going forward (`.gitignore`) | — |
| `backend/public.pre-v1.0.3/`, `backend/archive/` | 5 / 2 | Old frontend bundle / archive notes | excluded from the build (`tsconfig.build.json`) | Same as above | — |
Total of the above: ~2,900 of 5,087 tracked files (57 %), none of them product source.

## Done now (safe, reversible)
- `backend/tsconfig.json` now has an `exclude` list (`node_modules`, `dist`, `_deploy`, `archive`, `storage`, `tmp`, `public.pre-v1.0.3`), so `npx tsc --noEmit -p tsconfig.json` is clean (before: one error inside the staged copy `_deploy/staging/…/RepairNonCompliantUuids.ts`; finding B-03). The production build was already unaffected (`tsconfig.build.json`); `npm run build` re-run: OK.

## Proposed order (needs approval; each step is one reviewable commit)
1. Tag the current head (`pre-hygiene-2026-10-11`) so every removed tree stays reachable.
2. Add `.gitignore` entries for `_deploy/{build,incoming,logs,manifests,previous,staging}`, `_release-output/*.zip` and the two backup folders' successors.
3. `git rm -r --cached` the duplicate trees (files stay on disk) → verify `git archive HEAD` size, a clean build and the unit suite from the archive (the clean-build recipe of TEST-03 §7).
4. Close the recovery record, then delete from disk only after a second confirmation (never while a worktree/junction may point into them — see the memory note about `node_modules` junctions).
Acceptance: repository tracked files < 2,300; clean clone builds and passes unit/guard; no document links broken (`npm run docs:check`).

## Not done on purpose
- No deletion, no history rewrite, no `.gitignore` change affecting tracked trees, no change to `_deploy` runtime behaviour.
- The uncommitted work of other tracks (7 modified tracked files, LA-1 files) is untouched; committing or parking it is the owners' action (finding P-03).
