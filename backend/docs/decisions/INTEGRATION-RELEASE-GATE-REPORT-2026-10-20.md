# Integration release gate - consolidated report (2026-10-19/20)

Branch `integration/local-2026-10-16`; merge commits c87d896 (inventory lifecycle + Release Center), 193bbc8 (item-name-guard), 1c704b7 (PO picker). `package.json` stays **1.1.10**. Nothing was deployed or published; no production / hosting change; no flag change; the main checkout (`:5173` / `:3500`) was **not** switched.

## 1. Merge
All ten commits (18159cd, ee41a58, b0b4f22, 925c9ca, 8ef37ae, 62610b3, 476f9ab, eef92a1, 7b42c88, 46dbfad) are ancestors of the integration tip. Merges: **0 conflicts**. Branch owners were told.

## 2. Gate results (counted separately)
| Check | PASS | FAIL | BLOCKED | MISSING | TIMED-OUT |
|---|---|---|---|---|---|
| Backend tsc / build / lint (0 errors, 5 baseline warnings) | yes | - | - | - | - |
| Backend unit tests | 448/448 | 0 | - | - | - |
| Frontend tsc -b + build + lint (0 errors, 55 warnings; baseline 56) | yes | - | - | - | - |
| Cumulative regression (116 specs ran; the list file has 118 lines including comments) | 113 | 3 (below) | 0 | 0 | 0 |
| Business suite T-00..T-31 (29 steps incl. T-18 schema drift) | 29 | 0 | - | - | - |

The 3 regression FAILs (original logs preserved in `regression-116-specs.log.txt`):
- `release-migration-registry.real-pg.spec.ts` - **BLOCKED / baseline**: refuses to run unless the isolated instance is on port 5544. Not run.
- `database-provisioning.service.spec.ts` - 4/4 tests passed; the suite failed in teardown with `permission denied to terminate process` (known intermittent environment error). **Re-run alone: PASS 4/4.**
- `company-fanout.real-pg.spec.ts` - same teardown error, then cascading `database already exists`. **Re-run alone: PASS 11/11** (`retry-of-2-teardown-failures.log.txt`).
The two are recorded as FAIL (intermittent) with a passing retry; they are not counted as first-run passes.

C1 controlled-scenario spec: present in the list and **PASS** in this run.

## 3. Behaviour checks (not just page loads)
- **Duplicate-item guard** - `product-name-uniqueness.company-isolation.spec.ts` 9/9 PASS: a duplicate name under another code is refused with the existing code and zero writes; spacing / case / Arabic-letter variants are the same item; a different name is still accepted; New Item Request and Excel import covered (other rows still import); rename rules; a pre-existing duplicate does not block unrelated edits; Company B independent; concurrent registrations - exactly one wins. The products, product-master-data and new-item-request specs ran in the same regression and passed.
- **PO picker** (integration frontend against the shared database, in the browser): warehouse "1" lists 6 items, warehouse 1001 lists none; adding an item to the draft removes only that item from the list (a same-name sibling stays selectable); the code column is present. No order was created.
- **Inventory filter**: warehouse 1 + all items = 25 rows; typing a fragment reduces it to 4 matching rows.
- **BOM picker** (Item Details > BOM > new recipe): the component search filters as typed. Nothing was saved.
- **Release Center**: real `GET /release/preflight` on :3500 = pg_dump / pg_restore pass, overall ok; 12 unit + 3 HTTP upload specs pass (size cap including chunked, corrupted ZIP, checksum / manifest, traversal); duplicate-version and upgrade-resolver suites pass. **Upgrade path**: 1.1.10 is valid as a direct install over the installed 1.1.9; 1.1.4 and 1.1.3 are correctly refused as downgrades.
- **Migrations**: dry-run of the integration build against `daii_dev` and the four Company databases: **0 pending** on all five (307 applied on each; evidence `dryrun-integration-dist.json`).
- **Company isolation / permissions / reversal / valuation**: covered by the isolation specs in the regression (reversal, C1-C6, Stage A/B, opening batch, F6 scope) - all PASS.

## 4. Shared database
`:5173` (Vite, main checkout) -> `/api` proxy -> `:3500` (main/backend) -> `daii_dev` at localhost:5433 + Alpha / Beta / Delta / Gamma databases. The same database as :3500. Details and the session registry: `SHARED-DEV-DATABASE-AND-SESSION-REGISTRY-2026-10-19.md`.

## 5. Not covered / remaining risks
- `release-migration-registry` BLOCKED (port 5544). No real pg_dump / pg_restore run; no real package uploaded to the live Release Center (isolated tests only).
- Write-path refusals that depend on flags (enforce / approval-required) are proven by isolated specs, not live (flags unchanged).
- Browser checks used the admin user in Alpha only; Beta was not browsed.
- The C1 spec run rewrote one tracked evidence file (`controlled-scenario-results.json`); left uncommitted.
- C: drive space was very low during the long runs (no ENOSPC occurred).
- The main checkout runs the 1.1.9-line code plus lifecycle and Release Center; integration additionally carries the 1.1.10 release candidate (customer / supplier profiles, item master + barcode pickers, item details), the PO picker and the duplicate guard.

## 6. Release version recommendation
The 1.1.10 package row (id 5b3c69d8, status `backup_verified`) validates as a direct upgrade over 1.1.9. The branch now contains changes made after that package was built (lifecycle C2-C6, Stage A/B, Release Center settings, PO picker, duplicate guard), so that package no longer represents the branch. Recommendation: do not reuse it; if these changes ship, issue a new version (proposed **1.1.11**) with a freshly built package and migration list after your approval. `package.json` was not changed.

## 7. Safe switch plan for :5173 / :3500 (NOT executed - needs your confirmation)
Principle: do not modify the main checkout at all; run the integration build from its own worktree and keep the main processes restartable for instant code rollback.
1. Record the main checkout state again (`git status` + diff to evidence): 135 entries today (C1 patch, lifecycle merge, Release Center, others).
2. Preservation check (done): 85 of 95 uncommitted source files in main are byte-identical (ignoring line endings) to integration. Ten differ; one-sided line counts (integration-only / main-only): `inventory.service.ts` 22/0, `inventory.controller.ts` 18/1, `App.tsx` 2/0, `ui.css` 28/0, `general-ledger.controller.ts` 1/1, `purchase-order.service.ts` 4/2, `warehouse-item-assignment...spec.ts` 4/1, `PurchaseOrders.tsx` 3/6 (the peer's earlier hotfix variant, superseded by the committed picker), `ItemDetails.tsx` 73/92 (main has an earlier uncommitted variant), `regression-specs-all.txt`. The main-only lines will be diffed line by line before switching; main's files stay untouched regardless.
3. Runtime config: copy `backend/.env` into `integration/backend` (same `daii_dev` / :5433, same Company registry, PG_* absolute paths, no new database) and compare effective settings; the Vite proxy default stays `/api -> :3500`.
4. Migrations: none pending (section 3); nothing to run.
5. Switch: stop Vite (pid 17000) and the :3500 backend; start `node dist/main.js` from `integration/backend` and Vite from `integration/frontend` on the same ports. **Rollback**: stop them and restart the two main-checkout processes exactly as before (their files are unchanged).
6. Smoke on :5173 / :3500: login, Alpha / Beta, the read-only checks used earlier, permissions and company isolation spot-checks, valuation / reconciliation endpoints, Release Center preflight.
7. Flags and accounting policy unchanged; no data written.
