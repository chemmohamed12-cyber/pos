# Vehicle Driver Workspace / Expense Float — final report, gate verdicts and merge plan — 2026-10-26

**Recommendation: NOT YET "READY FOR MERGE".** Every technical gate is PASS on the candidate commit, but the merge is **BLOCKED on business / accounting approvals and on two integration decisions** (§6). Nothing was merged, packaged for release, or deployed. The release engine was not modified. Port 5173/3500 services untouched.

## 1. Candidate identity (exact, matchable)
| Item | Value |
|---|---|
| Branch | `feature/vehicle-driver-workspace` (base `release/1.1.11` = `c85479e`; **not** `main`, see §5) |
| **Candidate code commit** | **`c7a3f6f`** — every later commit on the branch is documentation/evidence only (verified: `git diff c7a3f6f HEAD -- backend/src frontend/src` is empty) |
| Commits entering a merge | 18, `f32a57d … c7a3f6f` (list in §4) |
| Source checksum (SHA-256 of `git ls-tree -r c7a3f6f -- backend/src frontend/src`) | `b3a59db3f4b17fec5b92b3a3b3974b010b17d7c3952a3710feeed4eec6e7961a` |
| Rehearsal package | `Daii-Release-v1.1.11-2026-10-26.zip`, SHA-256 `9cc7d19699e5ddbe8ed57c031c8ddb6e97600902ec92ba100ad8919f4b03c4e0` (built by the unchanged `build-release.sh` from `git archive c7a3f6f`; 4,368 manifest files, 0 problems, VERIFY PASSED; 325 migrations) |
| Package ↔ commit proof | package `src/` (1,093 non-spec files) is **byte-identical** to `git archive c7a3f6f backend/src` minus `*.spec.ts` (per-file SHA-256 diff empty); the package's `MANIFEST.json` lists exactly the five new migrations `1790040000000…1790040400000` |
| Regression/test commit | the same `c7a3f6f` (Phase 4 run, below) |
| Version note | the package carries `package.json` version 1.1.11 because no version change was authorised; **the real release number is for the release owner** (Procurement owns 1.1.12/1.1.13) |
An earlier rehearsal build from `8a36b05` **failed the official frontend `tsc -b`**; that package was discarded (`build-failed-8a36b05.log`) and the defect fixed in `c7a3f6f`. All results below are from `c7a3f6f`, except where marked.

## 2. Gate verdicts
| # | Gate | Verdict | Evidence (folder `evidence-2026-10-26-vehicle-workspace-stage-c/`) |
|---|---|---|---|
| G1 | Reference state (branch, commits, clean tree, dependencies) | **PASS** | §1, §5; `git status` clean apart from these docs |
| G2 | Real-PG regression after the last code change | **PASS — 22/22 specs, 189 tests, 0 failed** (cluster 5546, ns `biz_t99_`) | `regression-phase4-22of22.log` (spec list `tools/testing/regression-specs-vw-p4.txt`: delivery ×8, shipment ×2, returns ×4, reports, treasury ×4, customer payment reversal, accounting policy config, release-migration-registry). The harness prints `REGRESSION DONE: 22/22 passed`; its exit code was not captured separately (run in a background group) — the per-spec `RESULT PASS` lines and `Tests: n passed, n total` for every spec are in the log |
| G3 | Unit / type / lint / build | **PASS** | backend unit 66 suites / 509 tests; backend `tsc --noEmit` clean; frontend `tsc -b` clean; frontend model tests 14/14; backend ESLint 0 errors (5 baseline warnings); official package build `VERIFY: PASSED` |
| G4 | Code and financial-control review | **PASS (6 defects found, fixed, re-tested)** | `VEHICLE-DRIVER-WORKSPACE-PHASE2-CODE-AND-MIGRATION-REVIEW-2026-10-26.md` §3, §5, §6 |
| G5 | Migration review (5 migrations) incl. "edited in place" | **PASS (technical)** | same doc §1–§2: not in any of 17 packages; 0 rows ≥ `1790040000000` in any readable DB of the main dev instance; only disposable DBs ever held the old version |
| G6 | Release Engine rehearsal — **unmodified v1.1.10 engine**, isolated DBs `daii_test_biz_t98_*` | **PASS** | `rehearsal/04-deploy.log` (status `succeeded`; events: registered → backup linked → preflight → started → candidate verified → artifact integrity → environment check → migration preflight → company fan-out plan/backups/migration/verified → swapped → restart; Company fan-out `mode:on`), `rehearsal/schema-signatures.json`: platform 299→**325**, Company 299→**325**; **upgrade schema == fresh-install schema** (`ac36b89c…`, `62151525…`); **26 × `down()` returns to the baseline schema byte-for-byte** (`b6a0900c…`, `4423d1fa…`) |
| G7 | Deployed-application smoke (the swapped slot over the upgraded DBs) | **PASS — 36/36** | `rehearsal/05-smoke-1111.log` (login/company, maker≠checker, customer collection document, payment reversal, supplier payment reversal, Treasury==GL, AP/AR==GL, journals balanced) |
| G8 | Stage C acceptance on the **deployed** build (direct HTTP, driver/other-driver/finance roles) | **PASS — 42/42** | `rehearsal/07-stage-c-acceptance-deployed.log` (first attempt hit the product's login throttle from my repeated test logins — a test-harness artefact, re-run after the window; both runs' failures were only 401s from that throttle). Same 42 checks also 42/42 on the dev preview (`vw-api-checks3.txt`) |
| G9 | Rollback: previous slot (1.1.10) on the upgraded schema | **PASS** | `rehearsal/07-rollback-smoke.log`: login 201, treasury/customers/vehicles/shipments/supplier-payments 200, new Stage C route 404 (absent) — application rollback with the schema kept works |
| G10 | Browser acceptance (mobile 375 px driver, desktop 1280 px admin; all four sections; item delivery, collections, float, fail-closed banners) | **PASS** (on the dev preview, build `aec56be`; `c7a3f6f` changed only a TypeScript generic and a spec, behaviour identical) | Phase 4 notes of the handover; the *deployed* rehearsal slot was exercised through HTTP (G7/G8), **not** re-driven in a browser → marked as such |
| G11 | Release rehearsal on the **current** engine (1.1.12/1.1.13 line, with the Company migration gate) | **NOT VERIFIED** | only the unmodified 1.1.10 engine was used (as the earlier 1.1.11 rehearsal). The merged line must be rehearsed on its own engine after the merge — §4 step 7 |
| G12 | Conflict-free integration with the release line | **PASS for `release/1.1.12`; BLOCKED for two feature branches** | §5 |
| G13 | Business / accounting approvals | **BLOCKED — not obtained** | §6 |

## 3. What was fixed during closure (all committed; affected tests re-run on the new commit)
`8a36b05` visibility consistency, float uniqueness (unique index + CHECK, edited into the unreleased migration `1790040400000`), funded-total calculation, remit-into-float guard; `c7a3f6f` release-build type error + lint. Before/after table: Phase 2 doc §6. No fix changed a posting rule.

## 4. Merge plan (to be executed only after the approvals in §6 — **not started**)
**Target:** the current release line `release/1.1.12` (`3a4c811`, includes the 1.1.13 patch `4ae21ba`). A trial `git merge-tree` of `c7a3f6f` into it reports **no conflicts**, and the merged tree passes backend `tsc` (production sources **and** specs). `main` (`505584d`, 2026-10-20) does **not** contain the Treasury/Procurement/Inventory integration this branch is built on — merging into `main` is a different, larger exercise and is not recommended before the release line itself reaches `main`.
**Commits entering (18, oldest first):** `f32a57d`, `71eb4c2`, `5ecdba9` (F-1), `a0682ed` (F-2), `e4d18e4` (F-3..5), `2c9a934`, `4ef30e5` (C1), `a43a7fd` (C2), `766e8af` (C3), `1e137a6` (C4), `8804d1b` (C5), `e34dcd4`, `8b9c01c` (float backend), `d864c05` (float UI), `aec56be`, `762a285`, `8a36b05`, `c7a3f6f` (+ the closure documentation commit(s)). Migrations: `1790040000000`…`1790040400000`, all `logistics`, after every existing timestamp on the release line (latest there `1790030400000`); no timestamp or name collision with any reviewed branch.
**Steps**
1. Re-read this report; obtain the §6 approvals; freeze the candidate (`c7a3f6f` + docs).
2. On an integration branch cut from `release/1.1.12`, merge the feature branch (merge commit, not squash, to keep the 18 commits and their evidence).
3. Re-run: `tsc` (backend + `tsc -b` frontend), unit suite, ESLint, then the 22-spec list **plus** the release line's own regression list (the Company-gate specs).
4. Build the package from `git archive` of the integration commit (never `npm ci` in a junction worktree); record source/package checksums.
5. Rehearse through the **engine of the target line (1.1.13)** on isolated DBs: upgrade == fresh, `down` == baseline, Company gate/catch-up behaviour with the five new migrations, smoke, Stage C acceptance, rollback. (G11)
6. Browser acceptance on the rehearsed build with real driver / cashier / finance-approver accounts.
7. Only then a separate release decision, version number (release owner) and host deployment (not authorised by anyone yet).
**Post-merge verification checklist:** `migrations` table has the 5 new rows exactly once per database; `vehicles.expenseFloatAccountId` + unique index + CHECK present; a driver cannot read another driver's vehicle (404); a collection cannot be remitted into a float; float funding by transfer document works; reconciliation difference `0.00` on seeded data.
**Rollback:** application rollback = re-activate the previous slot (proved in G9; the schema stays — the new objects are inert for the older build). Database rollback = the five `down()` in reverse order on a restored copy only (drops collections' confirmation history, custody records, line events, expense claims, handovers and the float column: **destroys accounting evidence** → forward-fix is preferred once in use).

## 5. Integration analysis against the other lines (no conflict resolved by choosing a side)
Files touched by both this branch and the other branch, and what a correct merge must preserve:
| Branch | Real conflicts (`git merge-tree`) touching this work | What must be preserved / decided |
|---|---|---|
| `release/1.1.12` | **none** (`frontend/package.json` version line merges automatically) | ready |
| `feature/direct-sale-shipping` (`b661124`; the checkout the working directory points at) | `delivery.service.ts` `recordOutcome` (1 hunk), plus overlaps in `shipment.service.ts`, `Shipments.tsx`, `App.tsx`; also conflicts that exist **without** this branch (inventory/accounting files, caused by that branch being based on `main`) | keep **both**: the direct-sale rule (`isDirectSale` → only "delivered", action `direct_handover`) *and* this branch's COD/collection and per-item guards (a direct-sale hand-over with cash must still pass the collection rule; direct-sale shipments have no per-item events so the C2 gate is inert). Needs a real merge by the owners of both, with specs from both |
| `feature/org-structure-gate0` (`2d4eb06`) | `shipment.controller.ts` (4 hunks), `release-migration-registry.real-pg.spec.ts`; overlaps in `vehicle.entity.ts`, `shipment.service.ts`, `shipment.module.ts`, `treasury.service.ts`, `finance.contract.ts` | vehicle visibility must be the **AND** of the branch scope (`OrgContextService`) and this branch's access rule (`VehicleAccessService`); org-structure adds `vehicles.orgUnitId` while this branch keeps `branch` free text (decision D-6) — **owner decision needed** on whether the free-text branch is retired; registry spec edits to be combined |
| `feature/manufacturing-engine-design`, `feature/customer-account-statement`, `preview/shared-dev-2026-10-24`, `feature/hr-payroll-gap-closure`, `hotfix/treasury-ledger-nav-on-integration` | conflicts exist but are dominated by their own divergence from the integration line (payments/treasury/financial-event files), not by this work; the files shared with this work are `delivery.service.ts`, `shipment.service.ts`, `treasury.service.ts`, `finance.contract.ts`, `Shipments.tsx`, `App.tsx` | resolve in those branches' own merge into the release line; the two contract additions here (`cashOutForCustodyExpense`, `reverseCustodyExpense`) are additive and must be kept by whoever merges `finance.contract.ts` / `treasury.service.ts` |
Migration ordering: manufacturing (`1790033000000–1790034600000`) and org-structure (`1790021000000–1790021600000`) have lower timestamps than the five here; the engine applies pending migrations in timestamp order and all are additive, so order-independent — still to be confirmed in step 5.
Files needing extra **architectural / accounting review** before the merge: `finance.contract.ts` / `treasury.service.ts` (shared Treasury contract), `delivery.service.ts` (remit guard, outcome guards), `shipment.service.ts` (float assignment; settlement-account setters), `vehicle-access.service.ts` (visibility rule).

## 6. Open items, risks and approvals (technical PASS is not a substitute for any of these)
**Business / accounting approvals required before merge (BLOCKED — owner/finance/CTO):**
1. Finance owner: the GL account(s) for the driver expense float and the `custody_*` expense categories → expense accounts, per target company (otherwise the feature fails closed by design).
2. Finance owner/CTO: who holds expense approval (`finance.cash_document.approve`), posting (`…execute`), reversal (`…reverse`), collection/handover confirmation (`logistics.collection.post`) and float assignment (`logistics.vehicle.edit`) — role templates were not changed.
3. Owner decision on **partial delivery**: today no stock/receivable effect is posted for "returned" units (they must go through the Returns flow); confirm this is acceptable or commission the effect.
4. CTO decision on the two integration conflicts in §5 (direct-sale + org-structure) and on the free-text branch.
5. Release owner: version number and sequencing (this work was never given a version; Procurement owns 1.1.12/1.1.13).
**Known limitations (unchanged):** no automatic float top-up / per-driver floats / float limits; float assignment list needs `finance.cash.view` else id entry; reconciliation is per vehicle over all time; browser acceptance of the **deployed** rehearsal slot was HTTP-only; rehearsal on the 1.1.13 engine not done (G11); the harness exit code of the 22-spec run is inferred from its summary line.
**Residual risks:** (a) partial-delivery inventory/AR effect is a policy gap, not a bug; (b) a vehicle whose float account is later deactivated fails closed at claim time (refused, nothing recorded); (c) the in-place edit of `1790040200000` is safe only because it never reached any environment (§1) — if the branch is merged after another team applied it, a forward migration is required; (d) the two overlapping branches in §5.

## 7. Evidence index (`evidence-2026-10-26-vehicle-workspace-stage-c/`)
`regression-phase4-22of22.log`, `regression-final-18of18.log` (pre-fix, superseded), `vw-api-checks3.txt` (dev preview 42/42), `rehearsal/` (engine deploy log, smoke 36/36, Stage C acceptance 42/42 on the deployed slot, rollback, schema signatures, down-test, source checksum), `MANIFEST-rehearsal-package.json`, `*.zip.sha256`, and the scripts used (`vw-prep-c.js`, `vw-api-checks3.js`, `vw-apply-c.js`, `vw-reset-expenses.js`). Companion documents: float design, Phase 2 review, handover (`VEHICLE-DRIVER-WORKSPACE-*`).


---

# ITERATION 2 — closure of integration conflicts, integrated-candidate verification (2026-10-26, later)

**Status: INTEGRATION VERIFIED TECHNICALLY — APPROVALS PENDING (7/7) — MERGE: HOLD — verdict: NOT READY FOR MERGE.**
Blocking items: **D-1 … D-7 all PENDING** (register `VEHICLE-DRIVER-WORKSPACE-DECISION-REGISTER-2026-10-26.md`; no decision text, approver, date or evidence reference has been recorded for any of them) **and the integrated candidate contains `feature/org-structure-gate0`, whose own report says NOT READY FOR MERGE** (§I2, §I6). Nothing was merged to `release/1.1.12`, released or deployed; the release engine was not modified; 5173/3500 untouched.

## I0. Corrections to what was reported earlier
1. The Stage C acceptance script has **41 checks, not 42** ("42" counted its final `ALL PASSED` line). All 41 PASS on the dev preview, on the 1.1.10-engine rehearsal slot and on the integrated 1.1.13-engine slot. Earlier mentions of "42/42" mean 41/41.
2. Harness exit codes **are** captured now: `biz-run.js --regression` returns 0 on success and 1 on failure (observed: 1 on the one real failure of the org spec, 0 on every clean run). The earlier 22-spec Phase 4 run (`c7a3f6f`) was started in a background group and its exit status was not recorded; the per-spec `RESULT PASS` lines and `REGRESSION DONE: 22/22` stand, and the integrated run below has `HARNESS-EXIT=0` recorded.

## I1. Integrated candidate (exact identity)
| Item | Value |
|---|---|
| Branch | `integration/vw-candidate-on-1.1.12` (a **trial / verification branch**, not the release line); base `release/1.1.12` = `3a4c811` (includes the 1.1.13 patch `4ae21ba`) |
| **Final commit** | **`9e56426`** (= code `02465cb` + a test-list file; clean tree) |
| Entering the candidate | the vehicle-workspace branch (merge `763658c`; code `c7a3f6f`, head `255465f`, 18 commits) · `feature/org-structure-gate0` (merge `c7196fb`; 15 non-merge commits not already in the release line, head `2cf8873`) · `feature/direct-sale-shipping` **only** commit `cd6e89e` (re-committed as `2348b5f`; its second commit `b661124` and the uncommitted work in the main checkout are **not** included) · integration tests `02465cb`, list `9e56426`. 39 commits over `release/1.1.12` (37 non-merge) |
| Version label | the scratch export's `package.json` was set to `1.1.14` **for the rehearsal only** (the committed tree says 1.1.13) so the 1.1.13 engine would accept an upgrade. **D-5 (release version) is PENDING — this label is not a decision.** |
| Source checksum (`git ls-tree -r 9e56426 -- backend/src frontend/src`, SHA-256) | `0f90007aaaa4430bf2c49a855ad8e337c4bdbe77131c5a5d0a33e30852e44529` |
| Package | `Daii-Release-v1.1.14-2026-10-26.zip`, SHA-256 `d95dbf148e755376eb7b74d791a107d32de27a1e00621d85ad5f9d44ae8a9f88`, type full, 4,453 manifest files / 0 problems / VERIFY PASSED, **333 migrations** (1.1.13 has 320; +13 = 5 vehicle workspace + 7 org engine + 1 direct-sale terminology) |
| Package ↔ commit | package `src/` (1,115 non-spec files) is byte-identical to `git archive 9e56426 backend/src` minus `*.spec.ts` (per-file SHA-256 diff empty); only the `package.json` version label differs from the commit |
A first build whose zip name said 1.1.13 but whose manifest said 1.1.14 was discarded and rebuilt (`--skip-install`) so name, manifest and label agree.

## I2. Integration conflicts — resolved, both sides' rules kept, proven by tests on the candidate
| Conflict | Resolution (commit) | Proof |
|---|---|---|
| **`feature/direct-sale-shipping` × `recordOutcome`** (`delivery.service.ts`) | order kept: (1) a direct sale accepts only `delivered`; (2) for `delivered`: the per-item gate, then the cash-on-delivery collection rule; (3) action = `direct_handover` for a direct sale, else the usual map. `unit-specs.txt`: union (`2348b5f`) | new real-PG spec **X1–X5**: non-delivered outcomes refused for a direct sale; a direct sale without cash is handed over created→delivered; **a direct sale with a cash amount is refused until a collection is recorded, then handed over**; a rejected collection does not satisfy the hand-over; a normal shipment is unchanged — 5/5 PASS (harness exit 0) |
| **`feature/org-structure-gate0` × `shipment.controller.ts`** | both rules compose with AND: org branch scope first (`filterVisible` / `assertVisible`), then the F-1 access rule (`visibleVehicles` / `assertCanReadVehicle`); the same AND is applied to the new endpoints (`/vehicle-workspace/:id`, `custody-reconciliation`, handover declaration) so they do not bypass the branch scope (`c7196fb`) | specs **I1–I4** added to `vehicle-access…spec`: a branch-restricted fleet reader sees only in-scope + legacy vehicles; an unrestricted driver still sees only his own; **an assigned driver outside his branch scope gets 404**; a user with neither right sees nothing. The org branch's own `vehicle-branch` spec was adapted (it now runs as an administrator, because the F-1 rule applies on top) and passes 10/10 |
| org × direct-sale in `getOrderSnapshot` (a conflict *between those two branches*, not with this work) | both optional fields kept (`branchOrgUnitId`, `shippingMethod`) | compiles; exercised by the specs above and the org suites |
| both branches independently fixed the **same fragile negative control** in `release-migration-registry.real-pg.spec.ts` | the org branch's version kept (cut-off tree → nothing half-undone, a stronger assertion); mine dropped | spec 21/21 PASS |
**Not changed (documented):** shipment-level branch scope for the *new* routes that take a `shipmentId` (collections, line events, expenses) — only the vehicle-level routes are scoped. `vehicles.branch` (free text) and `vehicles.orgUnitId` **both remain**; nothing was removed or backfilled.

## I3. Verification of the integrated candidate (`9e56426`) — evidence in `evidence-…/integrated-candidate/`
| Gate | Verdict | Evidence |
|---|---|---|
| Real-PG regression, 34 specs (vehicle workspace/float 22, direct-sale integration, org suites ×8, release-line company gate ×3) | **PASS 34/34, `HARNESS-EXIT=0`** | `regression-integrated-34of34.log` |
| Backend unit suite | **PASS 76 suites / 624 tests** | run output |
| backend `tsc --noEmit`, frontend `tsc -b`, frontend model tests 14/14, ESLint 0 errors (5 baseline warnings), official package build `VERIFY: PASSED` | **PASS** | `package-build.log` |
| Engine rehearsal on the **1.1.13 engine** (installed baseline = the 1.1.13 package `35192265…`, unmodified; isolated DBs `daii_test_biz_t97_*`; Company fan-out on) | **PASS** | `04-deploy.log`: `succeeded`; events incl. `release.deploy.company_gate`, company backups / fan-out / migration / verified, atomic swap; platform and Company DB 320 → **333** migrations |
| Upgrade schema == fresh-install schema | **PASS** (`dc688a33…`, `6d877cca…`) | `schema-signatures.json` |
| `down()` ×13 back to the 1.1.13 baseline schema | **FAIL — one constraint, org-owned** | table/column/index/constraint counts identical; the only difference: the `org_units` parent FK is `org_units_parentId_fkey … ON DELETE CASCADE` at baseline but `FK_org_units_parent … ON DELETE RESTRICT` after the org migration's `down()` (`OrgUnitLifecycle1790021000000`). **None of the five vehicle-workspace migrations or the direct-sale migration leaves a difference.** Classification: reversibility limit of the org branch's migration (owner: org-structure team); it does not affect upgrade, application rollback or this feature, but the candidate cannot claim byte-exact database rollback while it includes the org branch |
| Deployed smoke (swapped slot) | **PASS 36/36** | `05-smoke.log` |
| Stage C acceptance on the deployed integrated slot (41 checks incl. driver-vs-driver isolation) | **PASS 41/41** | `07-stage-c-acceptance-integrated.log` |
| **Browser acceptance on the deployed integrated slot** (the UI served by the package itself, `127.0.0.1:3690`) | **PASS** | mobile 375 px as the driver: all four sections, 0 overflow, 0 touch targets < 44 px; recorded a collection and an item delivery through the UI (Deliver stays disabled while items are outstanding); **claimed an expense through the UI**. Desktop 1280 px as admin: all sections 0 overflow; **approved (a different user) and posted that expense through the UI — float 1,000 → 955, difference 0.00**; the driver sees "you cannot approve your own expense" |
| Rollback to the previous slot (1.1.13) on the upgraded schema | **PASS** | `07-rollback-smoke.log`: login 201; treasury / customers / vehicles / shipments / supplier-payments 200; Stage C route 404 (absent) |
Differences between the rehearsal and the target environment: isolated cluster 5546, `NODE_ENV=development`, `ENTITLEMENT_MODE=unlicensed-full`, version label 1.1.14 added for the rehearsal, engine = the installed 1.1.13 package driven by the local harness (not the host's Release Center UI).

## I4. Decision register (7) — actual status
| # | Decision | Status | Blocks |
|---|---|---|---|
| D-1 float GL account per company | **PENDING** (no approver recorded) | configuration of any target company |
| D-2 `custody_*` categories → accounts | **PENDING** | same |
| D-3 roles: approve / post / reverse / assign float / confirm | **PENDING** | granting any role (no template changed) |
| D-4 partial-delivery stock / receivable effect | **PENDING** — behaviour unchanged | any change to partial delivery |
| D-5 release version / order | **PENDING** — the 1.1.14 label is rehearsal-only | packaging |
| D-6 keep `branch` + `orgUnitId` together | **PENDING** — both kept, visibility rules AND-composed | removing either |
| D-7 owner acceptance of limitations | **PENDING** | merge approval |
The register holds the facts each owner needs. A technical PASS above is **not** an approval of any of them.

## I5. Residual risks added by this iteration
(a) the org migration's `down()` changes one FK (§I3) — org-owned; (b) shipment-level branch scope on the new shipment-keyed routes is not applied (§I2); (c) the integrated candidate is a **trial** — the three branches have not been reviewed together by their owners; (d) `feature/direct-sale-shipping` has uncommitted work in the main checkout and a second commit (`b661124`) that are not included — the owner must confirm `cd6e89e` alone is the intended slice; (e) the rehearsal used a 1.1.14 label; the real number is undecided.

## I6. Merge options (no merge performed)
1. **Vehicle workspace alone onto `release/1.1.12`** — proven conflict-free (`git merge-tree`); regression and the rehearsal on the 1.1.10 engine passed at `c7a3f6f`. **The 1.1.13-engine rehearsal of this exact subset has not been run** (only the integrated candidate was); if the CTO prefers this path it must be repeated first. Still needs D-1…D-5 and D-7.
2. **Integrated candidate `9e56426`** — fully verified above, but it contains org-structure (NOT READY FOR MERGE by its own report; the `down()` FK difference) and a partial direct-sale slice; needs the org team's gate and the direct-sale owner's confirmation first.
3. **Sequence**: land direct-sale and org (each through its owner's gate) onto `release/1.1.12` first, then this work, using `2348b5f` / `c7196fb` / `02465cb` as the integration reference.
**Recommendation: NOT READY FOR MERGE.** Reasons, in order: (1) D-1…D-7 PENDING; (2) org-structure's own NOT READY status and the `down()` FK difference; (3) direct-sale slice confirmation; (4) the real version number (D-5).
