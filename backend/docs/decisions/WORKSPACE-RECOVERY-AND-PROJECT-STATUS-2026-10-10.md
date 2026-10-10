# DAII ERP — workspace recovery audit and project status (2026-10-10)

Primary project: `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\1-hosting\daii.xnexustech.com\release-new` (repository root). Work branch of this audit: `recovery/unreleased-work` (worktree `daii.xnexustech.com\merge-116`), created from the deployed head. **Nothing was deleted, moved or deployed; no key was changed; no production data was touched.**
Legend: **VERIFIED** = proven by a test or by host evidence · **PENDING** = decided, not done · **UNVERIFIED** = not proven.

## 1. State of the deployed system (host, VERIFIED by host evidence)
- Deployed release **1.1.8** (releases 1.1.8 and 1.1.7 `succeeded`, 1.1.6 closed `failed` automatically, 1.1.5/1.1.4 `succeeded`). One-time engine hotfix applied to the installed v1.1.5 engine (file SHA `99c8f1e5…`, backup on host).
- **Company creation works in `COMPANY_DB_MODE=pool`** (cPanel): Company `Test2` READY, registry `xnexdrgr_daii_c01` ACTIVE, Company database 181 tables / 42 roles / 1 admin grant / 288 migrations. Two empty pool databases remain (`c02`, `c03`). Application mode = Production.
- Company users, invitations, roles, scopes and support access are part of 1.1.8 (verified inside the package bundle); the operator confirmed the page works after granting roles.
- Host env additions made: `COMPANY_DB_MODE`, `COMPANY_DB_POOL`, `RELEASE_READINESS_URL`.

## 2. Work that was NOT in 1.1.8 — found and recovered (VERIFIED by tests)
All three states were first preserved in `1-hosting\_recovery-snapshots\2026-10-10\` (patches + untracked files), then compared with the deployed content (they apply cleanly, share no file with each other or with the other pending work) and committed on `recovery/unreleased-work`:
| # | Work | Origin | Commit here | Evidence |
|---|---|---|---|---|
| 1 | PR/PO/SO create rejects an unknown `warehouseId` (404 before any mutation) | commit `2cf5e03`, branch `claude/clever-torvalds-b3dfff` | `92426fe` (cherry-pick) | `warehouse-reference.company-isolation.spec` + 6 updated isolation specs |
| 2 | One UTC business-date rule for subledger/reconciliation (fixes the 00:00–03:00 Cairo `grni` false drift) | uncommitted in worktree `great-jackson-49718d` (10 services + `business-date.ts` + 2 specs) | `3ef67f4` | pinned-clock regression spec (2026-10-06T23:57:33Z) + unit spec; `grni-posting` passes |
| 3 | WIP control account `1150` in the `ifrs-sme` template (new Companies only) + isolated-DB tool fix | uncommitted in worktree `inspiring-carson-b57184` | `352f0df` | `wip-control-account.company-isolation.spec` (real PG) |

**Full regression of the branch (isolated PostgreSQL, SERIAL `--runInBand`): 193 suites passed, 0 failed, 1 skipped (194) · 1341 tests passed, 0 failed, 1 skipped (1342).** Skipped by design: `t0-clean-company-baseline`.
Not yet done: running `grni-posting` inside the real 00:00–03:00 Cairo window (the pinned-clock spec covers it deterministically).

## 3. Work deliberately NOT recovered (decision: HOLD / separate review)
- **LA-1 Layer 2** (Company lifecycle: preliminary-hold-expiry scheduler, approval-expiry scheduler, `company-lifecycle-admission`, installation-audit controller change, record + closure-package edits) — still **uncommitted in the main checkout** (3 new + 7 modified files, preserved in the snapshot folder). HOLD pending an independent approval; it overlaps nothing on the recovery branch.
- **D3/H3 test and docs commits** (`757b2f4`, `cb1738d`, `26631aa` on `claude/amazing-lamarr-145ad6`): tests/docs only; to be reviewed and merged separately. (The engine fixes of that branch are already in the deployed code by content.)

## 4. Large-folder audit (read-only) — findings
Scan: ~25 000 directories / 150 000 files / ~101 GB (without `node_modules`, `.git`, `dist`). Reports: `_recovery-snapshots\2026-10-10\large-folder-scan\`.
- `D:\PROG` (77 GB): **unrelated to DAII** (Windows/Office ISOs, drivers, printer images, personal archives) — outside the consolidation, untouched.
- `D:\CLAUDE-CODE - Copy` (19.5 GB), `XNEXUS-WORKSPACE\archive` (17 GB), `XNEXUS-WORKSPACE\old` (2.3 GB): historical copies of the DAII and XNEXUS projects. Four DAII git repositories (all HEAD `a0eb827`, 2026-08-27, 35 commits; one pair clean, the other pair has one uncommitted change each) plus release snapshots of 25–31 Aug 2026 (Final_Release, P2-Engine-Impl, Server-Full-Snapshot, v1.0.2/1.0.3).
- **Unique work check:** `backend/src` of six historical trees compared with the current source (name-matched, because migrations moved from a flat folder into per-tag folders): **no production source file exists only in the old trees** (single exception: an `observability.zip` archive in one 25-Aug release). Their commit history (35 commits, Aug 2026) exists only there; the current repository starts 2026-09-18 → keep as archive.
- Largest files are almost all in `PROG` (ISOs, ghost images) and four copies of a 1 GB old website zip.
- Older `backend` trees next to `release-new` (`daii.xnexustech.com\backend` v1.0.3, `4-daii-erp\backend` v0.1.0): older than the deployed code, nothing newer.

## 5. Workspace consolidation — proposed, NOT executed
Facts that block an unattended move (STOP conditions of the directive):
1. The main checkout `release-new` is on `master` (package version 1.1.2) with **uncommitted LA-1 work**; the approved source for 1.1.8 lives on `release-1.1.6` / `recovery/unreleased-work`. Master is an ancestor of the recovery branch and shares no file with the uncommitted LA-1 files → a `git merge --ff-only` is possible **after approval** (the LA-1 files are already preserved in the snapshot).
2. `D:\DAII-ISOLATED-PG` is a **running** test database (and holds a password file); moving it breaks the regression environment. Keep in place; document.
3. `D:\DAII-LOCAL-DEPLOY` (release packages 1.1.3–1.1.8 + sha files, simulation, scripts, bench, hotfix) is referenced by absolute path in notes/scripts; moving it needs a path update pass.
4. Leftover temporary worktree `daii.xnexustech.com\base-f6` (30 files, no junction inside).
Proposed layout under `1-hosting` (to approve): `release-new\` (source of truth, branch `master` after ff) · `_release-artifacts\` (packages + sha256, scripts used for deploy/hotfix) · `_recovery-snapshots\` (already created) · `_archive-readonly\` (the historical copies, only after approval) · worktrees only under `release-new\.claude\worktrees`.
Candidate cleanup (nothing deleted; each needs the explicit approval the directive requires): worktree leftovers `base-f6`; superseded packages built before fixes (`4e465c26…` was overwritten; keep 1.1.3–1.1.8 final ones); the `merge-116` worktree after the recovery branch is merged; duplicated historical archives (4× 1 GB website zip, three identical copies of the DAII repo) after one verified copy is kept.

## 6. Pending / open (with owner)
**Needs host evidence or a decision from the operator:**
1. Production audit-chain break at `seq 1` — cause unknown (3 read-only queries in `COMPANY-DATABASE-ALLOCATION-AND-1.1.6-READINESS-2026-10-09.md` §2).
2. Secrets rotation — plan only; `JWT_REFRESH_SECRET` equals `INTEGRATION_ENCRYPTION_KEY`; `database_credentials` now holds ≥1 row (`Test2`), so `DATABASE_CREDENTIAL_ENCRYPTION_KEY` needs a re-encryption tool (or abandoning `Test2`); `integration_credentials` count still needed.
3. Four bare `PROVISIONING` Companies (no database, hidden from lists) — not to be touched without an approved plan.
4. More pool databases before the two remaining are used.
**Engineering:**
5. Release **1.1.9 candidate** = recovery branch (items 1–2, and 3 if accepted). Not built, not deployed, awaiting approval (see §7).
6. Staging lifecycle / retention task (`release-staging` 260 MB, `upload-*` leftovers, `RELEASE_STAGING_PATH` off-tree, exclude staging from the candidate copy) and async deploy.
7. Test isolation: `wip-reconciliation` / `closing-snapshot-key-rotation` are flaky when run in parallel on the shared ambient DB — run the regression with `--runInBand`.
8. SQL statements per request: unmeasured after the final changes.
9. Pool mode automation (create databases through the hosting provider's API) — deferred.
10. LA-1 Layer 2 — HOLD.

## 7. Recommendation on 1.1.9
Justified: item 1 is a data-integrity guard and item 2 removes a time-dependent false-drift defect, both proven by tests; item 3 only affects NEW Companies. Proposed content: items 1–2 (+3 if accepted); excluded: LA-1. Pre-conditions still to do: approval, package build, SHA-256, deploy once from the DAII panel, check readiness, one acceptance action. **No package was built.**

---
# Addendum — execution results (2026-10-10, unified source and cleanup)

## A. Source of truth
`release-new` branch **`master` = `334db31`** (fast-forward of `recovery/unreleased-work`; deployed 1.1.8 + the three recovered fixes + this report). Uncommitted LA-1 Layer 2 work (3 new + 7 modified files) is intact in the working tree and preserved in `1-hosting\_recovery-snapshots\2026-10-10\main-checkout-LA1`. Branches kept: `master`, `recovery/unreleased-work`, `release-1.1.6`, `release-company-fanout`, `claude/*` (no commit lost). Only worktree left: `release-new` (plus the session scratch worktree outside the project).
Verification after unification (isolated PostgreSQL 5544, SERIAL): **194 suites passed, 0 failed, 1 skipped (195) · 1358 tests passed, 0 failed, 1 skipped (1359)**; `nest build` OK; frontend typecheck clean. `tsc -p tsconfig.json` still reports one error inside the tracked junk folder `backend/_deploy/staging/bootstrap-v1.0.3/...` (pre-existing; the build config excludes it).

## B. Deleted, archived, kept (full list with sizes: `_recovery-snapshots\2026-10-10\DELETION-MANIFEST.tsv`)
| Item | Action | Proof / reason |
|---|---|---|
| `D:\CLAUDE-CODE - Copy` (355 736 files, 18.2 GiB) | **deleted** | 70 737 files byte-identical (SHA-256) to files under `D:\CLAUDE-CODE`; 284 867 regenerable (`node_modules`/`dist`); **28 unique files (620 KB) archived** to `_archive-readonly\copy-unique-2026-10-10` and SHA-256 verified; 0 junctions inside |
| `XNEXUS-WORKSPACE\old` (81 481 files, 2.1 GiB) | **deleted** | 10 913 files identical to `archive`; 70 389 regenerable; **173 unique files (338 MB: XNEXUS-QR standalone release zip, release zips, consolidation reports) archived** to `_archive-readonly\workspace-old-unique-2026-10-10`, SHA-256 verified |
| `XNEXUS-WORKSPACE\archive` (17 GB: historical server snapshots 25–31 Aug 2026, quarantine) | **moved** (not deleted) | now `1-hosting\_archive-readonly\workspace-archive`; the only copy of the historical server/release evidence; the only document referencing the old path was this report |
| 6 temporary git worktrees (`.claude/worktrees/*`) and `merge-116` | removed (`merge-116` partly, see D) | their content verified identical to what is committed on `master` (only line endings differ); node_modules junctions removed FIRST (link only; the real `node_modules` re-checked after each: 582 / 32 entries) |
| `daii.xnexustech.com\base-f6` (temp worktree leftover) | deleted | 0 reparse points |
| `release-new\backend`: `node_modules.incident-backup-2026-09-15` (119 MB), `stderr.log*`, `_restart2–6 *.log` | deleted | untracked; no references (git grep) |
| `D:\PROG` (77 GB), `D:\DAII-ISOLATED-PG`, `D:\DAII-LOCAL-DEPLOY`, `daii.xnexustech.com\{backend,frontend,_deploy,_la1,_wp41,_execution-baselines,…}`, `1-hosting\{1-xnexus-website,2-xnexus-platform,3-xnexus-qr-mobile,4-daii-erp,…}` | **untouched** | out of scope / running / referenced evidence (pinned baseline `EB-WP04-20261005-155534` lives in `_execution-baselines`) |
**Space:** file-size sum removed ≈ 20.8 GiB (Copy 18.2 + old 2.1 + junk 0.1 + base-f6); measured free space on `D:` rose from 149.8 GiB to 164.1 GiB (+14.3 GiB net; other writes — builds, test databases, archive copies, scans — ran during the work).
**Two mistakes made and corrected during the work (both recorded in the manifest):** (1) the first delete of `Copy` stopped on a read-only file but a "deleted" line was written; corrected, then completed after clearing read-only attributes. (2) `backend\public.pre-v1.0.3` (5 files, 568 KB) was deleted although it is TRACKED in git (my pre-check output was truncated); restored with `git checkout`, nothing lost.
Earlier in the session a `git worktree remove` followed a junction and emptied the main `node_modules`; restored with `npm ci` (907 packages, lock unchanged) — recorded in memory as a rule.

## C. Remaining problems only
1. `daii.xnexustech.com\merge-116` (68 MB leftover, deregistered worktree) is **locked by the desktop app's preview servers** (backend on :3500 and Vite on :5173, started 04:44 with that folder as working directory). Not mine to stop; remove after they are restarted from `release-new`.
2. Tracked junk in the repository itself (host mirror): `backend.prev-b73290c0…`, `_frontend-backup-2026-09-17…`, `_release-output`, `backend/_deploy/…`, `backend/public.pre-v1.0.3` — a history-changing cleanup, needs an explicit decision.
3. Old DAII repositories inside `_archive-readonly` carry dev credentials in their git history (`LOCAL_DEV_CREDENTIALS.md`, 97 lines, deleted only in the working copy) — keep them read-only and out of any package.
4. Open items unchanged from §6 (host evidence for audit chain `seq 1`; secrets rotation; four bare `PROVISIONING` Companies; LA-1 Layer 2 HOLD; staging lifecycle; async deploy; test isolation).

## D. Release 1.1.9 recommendation
**Ready to build on request, not built.** Content: `92426fe` (unknown warehouse → 404), `3ef67f4` (UTC business date), and `352f0df` (WIP account 1150, new Companies only; exclude if not wanted). Evidence: 193/194 suites green on the branch, 194/195 on the unified tree (serial), pinned-clock spec for the Cairo window. Excluded: LA-1. Before deploy: build with `tools/build/build-release.sh`, verify SHA-256, deploy once from the DAII panel, check readiness, create one acceptance action. The deploy path on the host is now the fixed engine (1.1.8) with `RELEASE_READINESS_URL` set.
