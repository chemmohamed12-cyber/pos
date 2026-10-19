# Local service switch to the integration build - report (2026-10-20)

Authorization: CTO conditional approval (local development services only). No production / hosting change, no deployment or publication, no flag change, no version change (`package.json` 1.1.10), no schema / seed / business-data change, no destructive Git operation.

## 1. State recorded before the switch
- Integration HEAD at the switch: **513496f** (report commit); worktree clean of source changes - only test evidence (untracked `evidence-2026-10-10-biz/T-*` folders, `controlled-scenario-results.json` re-written by the C1 spec) and this evidence folder.
- Main checkout: master **5e41647**, 135 status entries; `main-status-before.txt`, `main-uncommitted-before.diff`, `main-head.txt` saved here. Status hash and `git diff` hash are **identical before and after** the switch (81d13438... / f2082f40...), so no Main checkout file was touched.
- Ten-file review: `TEN-FILE-DIFFERENCE-REVIEW.md` - 7 files class A, 2 class C (import order, list order), **0 class B**; the 92 main-only lines of `ItemDetails.tsx` are the earlier read-only Item Details, replaced by the committed editable panels; the 6 main-only lines of `PurchaseOrders.tsx` are the superseded first hotfix variant.

## 2. Environment and database
- The integration backend has no `.env` of its own. It is started by a launcher (kept outside the repository, in the session scratchpad) that reads the Main checkout's existing `backend/.env` into the process environment (no secret printed or copied) and points the runtime storage directories (media, release staging, backups) at the Main checkout's `backend/storage` so the Release Center sees the same data. cwd = `integration/backend`.
- Database in use: `daii_dev` at localhost:5433 and the four registered Company databases (unchanged); no database created, no migration run (dry-run showed 0 pending before the switch).
- One local environment prerequisite was missing in the new worktree: the empty, git-ignored `integration/backend/tmp` directory that the Release Center preflight requires (`path.passenger_restart_parent`). It was created (empty) and the preflight then passed. This is the only deviation.

## 3. Processes
| Port | Before (stopped) | After (started) |
|---|---|---|
| 5173 | pid 17000, Vite from `release-new/frontend` (Main checkout) | pid 10524, `node node_modules/vite/bin/vite.js --port 5173 --strictPort`, cwd `release-new/.claude/worktrees/integration/frontend` |
| 3500 | pid 1696, `node dist/main.js` from `release-new/backend` (Main checkout) | pid 26352, launcher -> `dist/main.js`, cwd `release-new/.claude/worktrees/integration/backend` |
Nothing else was stopped.

## 4. Smoke results (all on :5173 / :3500)
- Frontend loads on :5173 (200); backend health 200; startup log has no errors (matches were only module / route names containing "error" / "exceptions").
- API smoke 14/14 (login, select Alpha / Beta, stock, warehouses, opening batches, transactions, valuation report, trial balance, reconciliation preview 409 = missing inventory control account in the demo Alpha chart, unauthenticated = 401, unknown id = 404).
- Release Center preflight: overall **ok = true** (pg_dump / pg_restore pass; `bin.npm` warning is pre-existing and non-critical). Installed version now reports **1.1.10** (it is the running build's `package.json`): the 1.1.10 package row therefore answers "already the installed version" and older ones "downgrade" - expected for a running 1.1.10 build, not a defect.
- Browser on :5173 (Alpha): PO picker - warehouse "1" lists 6 items (two share a name); after adding one to the draft, the picker offers the remaining sibling and the other items (id-based hiding); Inventory filter - 25 rows -> 4 for a typed fragment (server search request 200); BOM component picker lists 4 matching items for a typed fragment. API calls all 200 except `GET /api/manufacturing/boms/<id>` = 404 for an item with no recipe (expected "none defined"); console messages were only `ERR_NETWORK_IO_SUSPENDED` (the embedded browser pane suspending requests) and those expected 404s.
- No writes: no order was created, nothing saved; the temporary login helper page was deleted afterwards.

## 5. Rollback (not needed; verified recipe)
Stop pids 10524 and 26352, then restart the Main checkout services exactly as before: `cd release-new/backend && node dist/main.js` and `cd release-new/frontend && node node_modules/vite/bin/vite.js`. Main checkout files are unchanged, so no Git operation is involved.

## 6. Remaining notes
`release-migration-registry` stays BLOCKED (needs its isolated instance on port 5544). No real backup / restore was executed. Browser checks were performed in Alpha only.
