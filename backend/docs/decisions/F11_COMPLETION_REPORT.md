# F11 completion report — CR-2026-10-15 (PO/PR eligibility, trial-balance totals, movement dates)

> **Status: IMPLEMENTED; FOCUSED AND FULL VERIFICATION PASSED; FINAL RELEASE ACCEPTANCE PENDING** (host time-zone check F11-TZ; F11-D7 approved by the owner on 2026-10-16). Nothing is committed, pushed or deployed to Production. F11 itself has no database schema or data change.
> **Base:** `5e41647` (product source `4a42dc3`, frozen 2026-10-14). All changes are uncommitted in the working tree.
> **Companion:** `DAII-CR-2026-10-15-PRE-IMPLEMENTATION-REVIEW.md` holds the full findings, including items still out of scope (SKU visibility, movement screen, TB redesign, barcode).
> **Evidence:** `evidence-2026-10-15-cr-review/`, with SHA-256 hashes in `SHA256.txt`.
> **Real-Postgres runs:** all used `node tools/testing/biz-run.js` on the approved dedicated cluster `127.0.0.1:5546` (disposable databases, DB guard on). The final full runs (§5) ran from an isolated git worktree, `.claude/worktrees/f11-verify` = `5e41647` + the F11 changes only (patch SHA-256 `f17baeeb…09a0`), with its own `npm ci` and build. That was needed because a parallel session's unrelated work (item-details screen and migration `1790014000000`) had entered the shared checkout.

---

## 1. Changed files

| File | Change |
|---|---|
| `backend/src/domains/procurement/application/product-lifecycle-gate.service.ts` | New `assertEligible(ids, allowed, context, manager)`. One `ConflictException` (409) lists every ineligible line. The **draft wording is the original D7 text** ("is a draft item whose New Item Request has not been approved"). `assertAllActive` and `assertNoneDraft` are unchanged. |
| `backend/src/domains/procurement/application/purchase-order.service.ts` | `create`: `assertEligible([...], ['active'])` before any mutation, replacing `assertNoneDraft`. `transition('approve')`: the same check on the PO's lines before the state change. |
| `backend/src/domains/procurement/application/purchase-request.service.ts` | `create`: `assertEligible([...], ['active','draft'])`. |
| `backend/src/domains/accounting/application/ledger.service.ts` | `getTrialBalance` output is unchanged; its WHERE builder was extracted, with identical conditions. New `getTrialBalanceReport` adds `balanceTotalDebitBase` / `balanceTotalCreditBase`. Both total sets are documented on the interfaces (§3). |
| `backend/src/domains/accounting/interface/general-ledger.controller.ts` | `GET /accounting/trial-balance` → `getTrialBalanceReport`, a superset of the previous payload. |
| `backend/src/domains/inventory-warehouse/application/inventory.service.ts` | `listMovements`: a date-only `dateTo` covers the whole day (`createdAt < date + 1`). A full timestamp keeps `<=`. The ledger-date policy is noted in a comment. |
| `frontend/src/pages/accounting/TrialBalance.tsx` | The footer shows `balanceTotal*`. |
| `backend/src/domains/procurement/interface/procurement-item-eligibility.company-isolation.spec.ts` | **new** spec (6 tests) |
| `backend/src/domains/accounting/interface/trial-balance-footer.company-isolation.spec.ts` | **new** spec (7 tests) |
| `backend/src/domains/inventory-warehouse/interface/inventory-movement-dates.company-isolation.spec.ts` | **new** spec (5 tests) |
| `backend/tools/testing/regression-specs-all.txt` | the 3 new specs added (CRLF kept) |

- Diff of the tracked files: `evidence/source.diff`. The list of changed files: `evidence/changed-files.txt`.
- **No existing test was edited or weakened.** In particular, `general-ledger.company-isolation.spec.ts` (gross 240.0000 after a reversal) and `new-item-request.company-isolation.spec.ts` (`/draft item/`) are untouched and pass.

**Database changes: none.** No migration, no schema change, no change to production or development data.

---

## 2. PO/PR eligibility

| Path | Rule | Proven by |
|---|---|---|
| PO create (direct, and RFQ award via the same method) | every item exists and is `active` | eligibility spec tests 1–3 |
| PO approve | every line's item is still `active`, checked before the transition | test 4: the item is discontinued after submit → 409, the state stays `submitted`; once reactivated, the PO approves |
| PO reject / cancel | not gated | test 5 |
| PR create | missing or `discontinued` → 409; `draft` allowed (New Item flow) | test 6 |
| PR approve, RFQ creation | unchanged (`assertAllActive`) | test 6 and `new-item-request` |
| Goods Receipt | unchanged (`assertNoneDraft`; an approved in-flight PO stays receivable) | `goods-receipt` spec |
| PO/PR update | **no update or line-edit path exists**; lines are written once at create, so none was invented | endpoint inventory, review §1 |

- **Controlled errors.**
  - Before the fix, a missing id produced a raw `QueryFailedError` on `purchase_order_lines_productId_fkey` / `purchase_request_lines_productId_fkey` (HTTP 500; `probe-results.json`).
  - It is now a `ConflictException` (409) naming each bad line (`item <id> does not exist`, `"SKU — name" is discontinued`).
  - Each refusal adds 0 rows to the documents and lines, and consumes no document number: the next valid PO takes the next number.
- **Draft wording.** In the first focused run, `new-item-request` tests 4 and 7 failed on the wording, not on behaviour. The gate was corrected to keep the original sentence, and the spec was not edited.

---

## 3. Trial balance: two total sets (evidence kept separate)

| Field | Meaning | Status |
|---|---|---|
| `totalDebitBase` / `totalCreditBase` | **Gross** posted activity: Σ of every posted line's debit / credit | **Locked contract, unchanged.** Signed into closing snapshots; asserted by `general-ledger` spec line 290 (240.0000) |
| `balanceTotalDebitBase` / `balanceTotalCreditBase` | Σ of the **displayed rows**: Σ over accounts of GREATEST(±net, 0) | new; screen footer only |
| `balanced` | unchanged | — |

**Why the old footer showed 190 for rows that summed to 100** (`probe-results.json`, pre-fix):
- Entries: Dr Cash / Cr Revenue 100 · Dr Expense / Cr Cash 40 · Dr Suspense / Cr Cash 25 · Dr Cash / Cr Suspense 25.
- Rows (net): Cash 60 Dr, Revenue 100 Cr, Expense 40 Dr; Suspense nets to 0 and is omitted. **Rows sum to 100 / 100.**
- Footer (gross): 100 + 40 + 25 + 25 = **190 / 190**.
- The difference of 90 is the activity that nets out inside accounts with both debit and credit lines: Cash 65 and Suspense 25.

`trial-balance-footer.company-isolation.spec.ts`, 7/7 PASS:
- **Rows, as displayed:** Cash 80 Dr, Payable 20 Cr (a credit-normal account after mixed activity), Revenue 100 Cr, Expense 40 Dr. Suspense (zero) is omitted, and an unposted draft (999) is excluded.
- **Totals:** footer 120 / 120 = row sums. Gross 230 / 230, unchanged meaning.
- **`getTrialBalance`** still has exactly its 4 original fields and the same gross values, which is the closing-snapshot path.
- **Date window from 1 Feb:** footer 40 / 40, gross 130 / 130.
- **One-sided activity (Company B):** all four totals are 250; nothing leaks from Company A.
- **Independent check:** 40 seeded-random mixed postings across 6 accounts. Expected nets, the footer and the gross totals are recomputed in JavaScript with exact integer arithmetic, outside SQL, and all match.
- **Empty window:** all totals 0.

---

## 4. Movement dates (two behaviours, evidence kept separate)

### M-1: today's movements omitted. REPORT DEFECT, FIXED
- **Cause.** The screen sends `dateTo` as `YYYY-MM-DD` from `<input type="date">`. `createdAt <= 'YYYY-MM-DD'` is midnight at the **start** of that day.
  - Pre-fix (`probe2-results.json`): `dateTo` = today returned 0 of today's 4 movements, and `dateFrom = dateTo = today` returned 0.
  - The Excel export shares `listMovements`, so it had the same defect and is fixed by the same change.
- **Fix.** A date-only `dateTo` uses `createdAt < (date + 1)`, the same session-time-zone midnight that `dateFrom` already used. A full timestamp keeps its exact `<=`.
- **Tests** (`inventory-movement-dates` spec):
  - Today is included in all three filter forms.
  - Boundaries around one day D: 23:59:59.999 on D−1 is out, 00:00:00 on D is in, 23:59:59.999 on D is in, 00:00:00 on D+1 is out.
  - A full-timestamp `dateTo` keeps its inclusive meaning.
  - "Up to yesterday" plus "today" partition the ledger with nothing lost or double-counted.
- **Red check.** With only this condition reverted, the spec **fails 4 of 5** (`movement-dates-red-without-fix.log`). The source was restored byte-for-byte and verified with `cmp`.

### M-2: backdated document date not on the ledger. LEDGER-DATE POLICY, NOT CHANGED
- **Classification.**
  - `warehouse_transactions.movementDate` is documented in the entity as the document's business date and as a "non-blocking hook" for a future period check.
  - `stock_movements` has only `createdAt`, the posting time, by design (ADR-007 movement ledger). On-hand is the sum of all movements regardless of date.
  - So no posting step loses the date: the ledger was never designed to carry it.
  - The report correctly filters what the ledger holds, but nothing tells the user that the filter means posting time.
  - **This is a policy gap (decision D-CR7), not a posting defect and not a filter bug.**
- **Pinned behaviour** (spec test 3): a document dated 10 Jan and posted today has ledger date today; a January filter returns 0 rows, and today returns it.
  - Any change of policy will break this test, so it can only happen deliberately.
- **Options for D-CR7 (not implemented):**
  - (a) Label the report column and filter as "posting date". UI only.
  - (b) Carry the business date onto `stock_movements`. Needs a migration, a backfill plan and a decision on non-warehouse-document movements (GRN, sales dispatch, manufacturing).

### Running balance
- Read oldest-first per warehouse from the report, the balance equals on-hand after every movement: Raw 100 → 70 → 65 (on-hand 65); Prod 30 (on-hand 30).
- The transfer conserves the total.
- This passes with and without the M-1 fix, as expected.
- Known limitation: the report orders by `createdAt DESC` with no tie-breaker. Per-warehouse order is unaffected; cross-warehouse order is not deterministic for the two transfer legs. Not changed.

---

## 5. Verification results (final code)

| Gate | Result | Evidence |
|---|---|---|
| **Full isolation regression** (98 specs = 95 baseline + 3 new), F11-only worktree | **97/98 runner PASS · jest 646 passed / 21 failed / 1 skipped.**<br>The single FAIL is `release-migration-registry`, which accounts for all 21 failing tests. It is already **BLOCKED in the baseline** because it needs an approved staging host.<br>The 1 skip is `t0-clean-company-baseline`, skipped in the baseline too.<br>Baseline at `5e41647`: 94 PASS + 1 BLOCKED, jest 628/21/1. The +18 passing tests are the three new specs (6 + 7 + 5).<br>**No regression.** | `isolation-full-98-worktree.log` |
| **Business suite T-00…T-31**, same worktree | exit 0 · **309 PASS · 5 FAIL-DEFECT · 2 BLOCKED**, counted at case level from each step's `result.json`. This is **identical to the baseline**; T-30 19/19, T-31 10/10.<br>The FAIL-DEFECT and BLOCKED cases are the known characterizations: `T-06x-INFO`, `T-18` ×3, `T-22 F-AUD-003-X` and two `H5` placeholders. | `business-suite/` (29 step folders + `biz-run-full.log`) |
| Focused real-PG regression (32 specs) | 32/32 PASS · jest 205 passed / 0 failed / 1 skipped | `final-focused-regression.log` |
| New specs | Eligibility 6/6 · trial-balance footer 7/7 · movement dates 5/5.<br>Red check: with the `dateTo` fix reverted, movement dates fails 4/5. | `new-specs-final-code.log`, `movement-dates-red-without-fix.log` |
| Browser: trial balance (real app, disposable DB) | Footer 120/120 equals the displayed rows; gross 230/230 unchanged.<br>`/accounting/ledger` keeps its 4 original fields; date window 40/40; no console errors. | `browser/` |
| CI gate `tools/ci/ci.sh` | Overall PASS. Install, build, lint (0 errors / 5 warnings, equal to baseline), structure, doc-links, unit 60 suites / 436 tests, db-guard 50/50. | `ci-summary-final.md` |
| Backend `tsc --noEmit`; frontend build / lint | PASS; PASS / 0 errors (warnings pre-existing, none new) | `frontend-build.log`, `frontend-lint.log` |
| `verify:repo` | **Not run: the script does not exist** in this repository. The checks actually executed are the rows above. | — |

## 6. daii_dev (experimental environment), upgraded by the owner's decision of 2026-10-15

**Decision.** `daii_dev` and its company databases are experimental test environments. Apply all approved migrations; no backup is required. Work in progress (item-details) is excluded.

**Applied** from the F11-only build:
- Platform, 3 migrations: `DatabaseRegistryUniqueDatabaseName`, `CompanyAdminOrganizationNode`, `ReclassifyOrganizationAdministration`.
- Companies: Alpha 36, Beta 36, Gamma 35, Delta 34. Each received `core` plus the tags it already had, following the release engine's own fan-out rule.
- A second dry run shows **0 pending** everywhere. Evidence: `daii-dev-upgrade/`.

**Smoke test after the upgrade.** The owner signed in; Alpha and Beta are this account's companies. 109 company GET endpoints were called:
- Alpha: 105 × 200.
- Beta: 63 × 200, plus 44 × 404 for modules outside its package (expected).
- Controlled non-200 responses: `ap/statement` 409 (no AP control account configured) and `delivery/*` 404 without a shipment id.
- One pre-existing defect: `GET /accounting/reports/cash-flow` called **without dates** returns 500. The screen always sends dates and gets 200. Handed to a separate session; not part of F11.

**Running preview.** `localhost:5173` / `:3500` runs from worktree `.claude/worktrees/dev-preview`: `5e41647` + F11 + the Products warehouse column (§9).

## 7. Cleanup and baseline restoration

- Probes are kept only as `.ts.txt` in the evidence folder; `run-probe.sh` re-runs them. `src` contains only the intended files.
- One isolation run was contaminated: the fork's migration was loaded from about spec #20 onward. That run was **stopped and discarded**, its 3 leftover databases were dropped, and the run was repeated in the isolated worktree (§5).
- After all F11 runs, test cluster 5546 holds only `postgres` in `pg_database`. It is left **running** on purpose for the two queued sessions (cash-flow fix, master-data), which were notified in order.
- My temporary browser databases `daii_test_biz_t97_ui_*` were dropped, and the temporary `.claude/launch.json` entries for them were reverted.

## 8. Owner decisions and residual risks

| ID | Item | Status |
|---|---|---|
| F11-D7 | Sign-off: a new PO, a PO approval and a new PR refuse missing or discontinued items. A PR may still carry a draft item; approved POs stay receivable. | **APPROVED by the owner, 2026-10-16** |
| F11-DCR7 | Stock ledger date = posting time (`createdAt`). The document's `movementDate` is not carried to the ledger. | **RECORDED: kept for this release** |
| F11-TZ | Target host DB session time zone (`SHOW timezone;`). Local and test clusters are `Africa/Cairo`; the app sets none of its own. | **PENDING: no host access** |
| F11-RFQ | RFQ award for an item discontinued after PR approval: the outbox retries, then marks the event `failed`; the RFQ stays `sent` with no PO. Same mechanism as for draft items. | **RECORDED: residual risk, not rebuilt** |
| — | The PO-create check runs before the transaction, without a row lock. Approval catches a late change. | residual, low |
| — | `GET /accounting/trial-balance` gains two fields (a superset). The Accounting cover KPI still shows the gross debit total. | residual, informational |

## 9. Separate change made on the owner's request (NOT part of F11)

**Products screen: item warehouse column** (owner request 2026-10-16).
- **What it does:** a "المستودع" column lists each item's default/origin warehouses (`warehouse_items` markers). The value is editable together with the item, one checkbox per warehouse. Changes add or remove markers through the existing endpoints. The editor appears only for users with `inventory.warehouse.edit`.
- **Backend:** new read endpoint `GET /api/inventory/warehouse-items`, filtered to the caller's visible warehouses (F6). No migration.
- **Verification:**
  - Spec `warehouse-item-assignment` 8/8 PASS (test 8 is new).
  - Browser-verified on `daii_dev` with item 1003: add a warehouse → the change persists after reload → remove it → item restored.
- **Files:** `inventory.service.ts`, `inventory.controller.ts`, `warehouse-item-assignment.company-isolation.spec.ts`, `frontend/src/pages/Products.tsx`.
- **Evidence:** `warehouse-column/`, `warehouse-column-spec.log`.
- It must be committed separately from F11.

## 10. Release-readiness recommendation

**F11 code: ready for release acceptance.** Every required automated gate passed, with results equal to the baseline plus the new F11 tests. Browser behaviour was verified, and no regression was found.

**Still blocking before Production:**
1. ~~Owner sign-off on **F11-D7**~~: approved by the owner on 2026-10-16.
2. The host time-zone check **F11-TZ**, or an explicit acceptance of the session-zone behaviour.
3. Commit F11 as its own change, separately from the item-details work and the §9 warehouse column. Then build the release from that commit and go through the normal release approval.

**No Production deployment has been made or is requested by this report.**
