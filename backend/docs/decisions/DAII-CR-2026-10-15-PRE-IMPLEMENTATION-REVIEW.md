# CR-2026-10-15 — Evidence report and minimal implementation (purchasing, trial balance, inventory movements, barcode)

> **Superseded for closure by `F11_COMPLETION_REPORT.md` (final code, final runs).** This document keeps the original findings and the pre-fix evidence.

> **Status:** evidence complete. Minimal fixes are implemented in the working tree and **not committed**: PO/PR item eligibility (§1) and the trial-balance footer (§3).
> **Not done:** no other item was implemented, nothing was deployed, and no database schema changed.
> **Base:** frozen product source `4a42dc3` (HEAD `5e41647`). Development has been frozen since 2026-10-14; this work was directed by the review instruction of 2026-10-15 and still needs the normal release approval.
> **Evidence folder:** `evidence-2026-10-15-cr-review/`
> - `probe-spec.ts.txt` + `probe-results.json`: probe 1, the pre-fix behaviour.
> - `probe2-movement-dates.spec.ts.txt` + `probe2-results.json` + `probe2-run.log`: probe 2, movement dates.
> - `new-specs-first-run.log`: first run of the two new specs.
> - `run-probe.sh`: re-runs either probe; probes are kept outside `src` as `.ts.txt`.
> - `focused-regression.log`, `ci-summary.md`, `SHA256.txt`, `SOURCE_COMMIT.txt`.
>
> All real-Postgres runs used `node tools/testing/biz-run.js --regression` on the approved dedicated cluster `127.0.0.1:5546` (disposable `daii_test_biz_t90_*` databases, DB guard on). Nothing ran against `daii_dev` or any host.

---

## 1. Purchase orders: item validation (FIXED)

### Findings (probe 1, pre-fix, real PG)
- **No update path.** PO and PR have no update or line-edit endpoint. The endpoints are `POST /procurement/purchase-orders`, `POST /procurement/purchase-requests`, `POST …/:id/{submit,approve,reject,cancel}`, `POST …/purchase-requests/:id/create-rfq` and `POST /procurement/rfqs/:id/award`.
  - Lines are written once, at create. Validation therefore belongs on create and on approval. No update workflow was invented.
- `PurchaseOrderService.create` called `assertNoneDraft` (D7):
  - **A discontinued item was accepted** (PO-…000002 was issued).
  - **A missing item id surfaced as `QueryFailedError` on `purchase_order_lines_productId_fkey`**, an unhandled error that returns HTTP 500. The FK rolled the transaction back, so no PO row and no number were consumed.
- `PurchaseRequestService.create` validated nothing: discontinued and draft items were accepted, and a missing id gave the same raw FK error (500).
- **PO approval had no item check.** An item discontinued after the PO was raised was still submitted and approved.
- The API accepts any valid UUID (`IsUUID` only), so all of the above was reachable directly through the API.

### Fix (no migration)
| File | Change |
|---|---|
| `procurement/application/product-lifecycle-gate.service.ts` | New `assertEligible(ids, allowed, context, manager)`. A missing item or a status outside `allowed` raises **one `ConflictException` (409)** listing **every** bad line (`"SKU — name" is discontinued`, `item <id> does not exist`; draft lines keep the D7 wording `is a draft item whose New Item Request has not been approved`). |
| `procurement/application/purchase-order.service.ts` | `create`: `assertEligible([...], ['active'])` replaces `assertNoneDraft`, still before any mutation. `transition('approve')`: loads the lines and calls `assertEligible([...], ['active'])` **before** the state change. Reject and cancel are not gated, so a PO with a discontinued item can still be closed out. |
| `procurement/application/purchase-request.service.ts` | `create`: `assertEligible([...], ['active','draft'])`. Missing and discontinued items are refused; draft stays allowed for the New Item Request flow. Approval keeps the existing `assertAllActive`. |

**Unchanged:**
- Goods Receipt keeps `assertNoneDraft`. An already **approved** PO whose item is discontinued later can still be received (D7 in-flight rule).
- The RFQ award goes through `PurchaseOrderService.create`, so it now refuses discontinued items as well.

### Regression tests
`procurement-item-eligibility.company-isolation.spec.ts`, 6 tests, PASS:
- PO create:
  - Active is accepted.
  - Discontinued, draft, missing, and a product that exists only in Company B each get a 409 with the line named, and **0 rows** are added to `purchase_orders` and `purchase_order_lines`.
  - A mixed order lists every bad line, and the next valid PO takes the **next number** (none was consumed).
- PO approve:
  - An item discontinued after submit gives a 409 and the state stays `submitted`. Once the item is reactivated, the PO approves.
  - Reject and cancel still work.
- PR create:
  - Missing, discontinued, and active+missing each get a 409, and 0 rows are added.
  - Draft is accepted, and PR approval still refuses it.

---

## 2. Error handling (FIXED, as part of §1)
- Missing items no longer reach the database. Every refusal is a Nest `ConflictException`, which the existing error contract maps to HTTP 409 with the message.
- No raw `QueryFailedError` remains on these paths: probe 1 showed it before the fix, and the new spec asserts `ConflictException` after it.
- Remaining raw-FK paths: no other procurement create path takes free product ids from the client. RFQ quotation lines come from PR lines.

---

## 3. Trial balance: reconciliation defect (FIXED)

### Why the footer said 190 when the rows said 100 (probe 1, pre-fix)
Test entries, all POSTED in one company:

| # | Debit | Credit | Amount |
|---|---|---|---|
| J1 | 1000 Cash | 4000 Revenue | 100 |
| J2 | 5000 Expense | 1000 Cash | 40 |
| J3 | 1999 Suspense | 1000 Cash | 25 |
| J4 | 1000 Cash | 1999 Suspense | 25 |

- **Rows** (`LedgerService.getTrialBalance`): the per-account **net** `Σdebit − Σcredit`, shown as `GREATEST(net,0)` in debit or `GREATEST(−net,0)` in credit, with zero-net accounts omitted.
  - Cash = 100 + 25 − 40 − 25 = **60 Dr**. Revenue = **100 Cr**. Expense = **40 Dr**. Suspense = 0, so it is omitted.
  - **Row sums = 100 Dr / 100 Cr.**
- **Footer** (`totalDebitBase` / `totalCreditBase`): **gross** `Σ` over every posted line = 100 + 40 + 25 + 25 = **190** each side.
- The difference, 90 per side, is exactly the activity that nets out inside accounts with both debit and credit lines: Cash 65 and Suspense 25. With one-sided activity the two figures coincide, which is why the existing specs never showed the gap.

### Fix (keeps the accounting meaning; no migration)
- `totalDebitBase` / `totalCreditBase` are a **deliberate gross contract**, which is why they were not repurposed:
  - `general-ledger.company-isolation.spec.ts:290` asserts `240.0000` gross after a reversal.
  - `ClosingSnapshotService.assembleBody` embeds `getTrialBalance()` in **signed closing snapshots**.
- Changes:

| File | Change |
|---|---|
| `accounting/application/ledger.service.ts` | `getTrialBalance` is unchanged in output; its WHERE builder was extracted to `trialBalanceWhere`, with identical conditions. New `getTrialBalanceReport` returns the same payload **plus `balanceTotalDebitBase` / `balanceTotalCreditBase`** = `SUM(GREATEST(±net,0))` over the same per-account aggregate. It is computed SQL-side in NUMERIC, following ADR-035 D4. |
| `accounting/interface/general-ledger.controller.ts` | `GET /accounting/trial-balance` returns `getTrialBalanceReport`, a superset of the old payload. `GET /accounting/ledger` and the closing snapshot still use `getTrialBalance`. |
| `frontend/src/pages/accounting/TrialBalance.tsx` | The footer shows `balanceTotal*`, so it equals the columns by construction. |

- `balanced` is unchanged. It is mathematically equivalent either way, because Σnet = Σgross Dr − Σgross Cr.

### Regression tests
`trial-balance-footer.company-isolation.spec.ts`, 6 tests, PASS. It covers a debit balance, a credit balance, a credit-normal account (Payable) after mixed activity, a zero-net account, an unposted draft, a date window, one-sided activity in Company B, and an empty window:
- Rows: Cash 80 Dr, Payable 20 Cr, Revenue 100 Cr, Expense 40 Dr. Suspense is omitted and the draft (999) is excluded.
- **Footer 120 / 120 = row sums. Gross unchanged at 230 / 230.**
- `from` = 1 Feb: rows Cash 20 Cr, Payable 20 Cr, Expense 40 Dr. Footer 40 / 40, gross 130 / 130.
- Company B (one-sided): 250 in all four totals.
- `getTrialBalance` still has exactly its four original fields.

### Remaining (not changed)
- With `from`, the rows are period movement without the opening balance (pre-existing). The opening / period / closing redesign is still pending (decision D-CR6).
- The Accounting cover KPI "Debit" still shows the gross `totalDebitBase`.

---

## 4. Inventory movements and transfers (VERIFIED; no posting change)

### Transfer ledger (probe 1, confirmed)
- A partial transfer of 30 out of 100, Raw → Production:
  - draft and submitted: no stock moves.
  - `approve` auto-chains to `posted`: Raw 70 / Prod 30 in both the stock report and the per-warehouse grid.
  - A repeated `post` writes no duplicate (exactly 2 movement rows).
- **Transfer posting was not changed.** The reported "item shows in one warehouse" did not reproduce. The likely causes are still a transfer awaiting approval, or the GL trial balance being read as a stock report. This needs the reporter's document number and screen.

### Movement dates, report filters, running balance (probe 2, confirmed)

| Check | Result |
|---|---|
| Ledger date source | `stock_movements` has only `createdAt`, the **posting time**. The document's `movementDate` lives on `warehouse_transactions`. |
| Backdated document | A receipt dated 10 Jan, posted 15 Oct, shows ledger `createdAt` 15 Oct. A report filtered 1–31 Jan returns **0** rows. The document date never reaches the ledger or the report. |
| `dateFrom` = today | 4 of 4 of today's movements are returned. Correct. |
| **`dateTo` = today** | **0 of 4.** **Defect M-1:** the filter is `createdAt <= 'YYYY-MM-DD'`, which is midnight at the *start* of the day (session time zone `Africa/Cairo`). The UI sends a date-only value from `<input type="date">`, so the selected end day is always excluded. This also affects the Excel export, which uses the same `listMovements`. |
| `dateFrom` = `dateTo` = today | **0.** Same cause. |
| Running balance per warehouse | Raw: +100 → 100, −30 → 70, −5 → 65. **Closing 65 = on-hand 65.** Prod: +30 → 30 = on-hand 30. |
| Ordering | The report has `ORDER BY "createdAt" DESC` with no tie-breaker, and both transfer legs share the same `createdAt`. Per-warehouse order is unaffected; unfiltered cross-warehouse order is not deterministic. |

### Proposed minimal fixes (NOT implemented; awaiting review)
- **M-1:** make `dateTo` an exclusive next-day bound: `createdAt < ($dateTo::date + 1)`.
  - Files: `InventoryService.listMovements` (`inventory.service.ts:487`); the export reuses it.
  - Add a real-PG spec covering a same-day movement and a day-boundary case (23:59 and 00:01 Cairo).
  - No migration.
- **Date basis (D-CR7):** the movement screen and opening balances use posting time, consistent with on-hand. If document dates are required, copy `movementDate` onto `stock_movements`, which **does** need a migration and a backfill plan.
- **Ordering:** `ORDER BY "createdAt" DESC, id DESC`. No migration.
- Item-movement screen (running balance, opening before `dateFrom`, row click from the grid): as described in the previous review, no migration.

---

## 5. Evidence hygiene (VERIFIED)
- **Probes are outside `src`.** Both are stored as `.ts.txt` in the evidence folder. `git status` on `src` lists only the intended source files and the two new specs (below). `run-probe.sh` copies a probe in for one run and removes it on exit.
- **Test cluster:** started only for these runs, and stopped at the end (port 5546 not listening). A read-only `pg_database` listing showed only `postgres` both before the new runs and after the last run (T-07), so the harness had dropped every disposable database.
- **No unrelated data was touched:**
  - Every write went to fresh `daii_test_biz_t90_*` databases created and dropped by the harness under the DB guard.
  - Port 5433 (`daii_dev`) was never addressed, and is hard-denied by the guard.
  - The only in-database edits were the probe's own seeded rows (status toggle and backdating of its own journal) inside those disposable databases.

---

## 6. Closure

### Changed files
| File | Kind |
|---|---|
| `backend/src/domains/procurement/application/product-lifecycle-gate.service.ts` | source |
| `backend/src/domains/procurement/application/purchase-order.service.ts` | source |
| `backend/src/domains/procurement/application/purchase-request.service.ts` | source |
| `backend/src/domains/accounting/application/ledger.service.ts` | source |
| `backend/src/domains/accounting/interface/general-ledger.controller.ts` | source |
| `frontend/src/pages/accounting/TrialBalance.tsx` | source |
| `backend/src/domains/procurement/interface/procurement-item-eligibility.company-isolation.spec.ts` | new spec |
| `backend/src/domains/accounting/interface/trial-balance-footer.company-isolation.spec.ts` | new spec |
| `backend/tools/testing/regression-specs-all.txt` | the two new specs added |
| `backend/docs/decisions/DAII-CR-2026-10-15-PRE-IMPLEMENTATION-REVIEW.md`, `evidence-2026-10-15-cr-review/`, `evidence-2026-10-10-biz/T-07/T-07-20261015T134520Z-2d9710/` | docs and evidence |

**Database changes: none.** No migration, no schema change, no data change outside disposable test databases.

### Verification
| Gate | Result |
|---|---|
| Backend `tsc --noEmit` | PASS |
| New specs (2 × 6 tests, real PG) | PASS |
| Focused real-PG regression: every regression-list spec that touches PO/PR, the ledger or the trial balance, plus goods-receipt, inventory and warehouse-transactions (30 specs; list in `focused-regression-list.txt`) | First run **29/30**: jest 195 passed / 2 failed / 1 skipped (`t0-clean-company-baseline`, skipped as in the baseline). The 2 failures were in `new-item-request` tests 4 and 7: the draft refusal still happened, but the message no longer contained the established D7 wording "draft item". **Fixed in the gate** (draft lines keep "is a draft item whose New Item Request has not been approved"); the existing spec was not edited. Re-run of the 7 gate-dependent procurement specs: **7/7 PASS** (`focused-rerun-after-message-fix.log`). The other 23 specs do not depend on the gate message. |
| Business suite T-07 (returns, uses the ledger) | PASS (`t07.log`; runner evidence in `evidence-2026-10-10-biz/T-07/T-07-20261015T134520Z-2d9710/`) |
| CI script `tools/ci/ci.sh` (install, build, lint, structure, doc-links, unit, db-guard) | **Overall PASS**, 7/7 steps; unit 60 suites / 436 tests (`ci-summary.md`) |
| Frontend `npm run build` / `npm run lint` | PASS / PASS (0 errors; pre-existing warnings in other files only) |
| `verify:repo` | **Does not exist** in this repository; `tools/ci/ci.sh` is the repository gate. |
| Full isolation regression (94 specs) and business suite T-00..T-31 | **Not run** in this pass. Required before release approval. |
| Browser check of the TB footer | **Not done.** No isolated browser environment was started; the API contract is covered by the real-PG spec. |

### Outstanding risks and gaps
1. **RFQ award and discontinued items.**
   - If an award is approved for an item discontinued after PR approval, `onAwardApproved` → `PurchaseOrderService.create` now throws.
   - The approval event retries and is then marked `failed` in the outbox. The RFQ stays `sent` with no PO.
   - This is the same mechanism that already applied to draft items under D7, not a new failure type. It needs a visible exception for the buyer (a follow-up).
2. **Race window.** The PO create check still runs before the transaction, with no row lock. An item discontinued in the same instant can slip through create, but approval now catches it.
3. **API compatibility.** `GET /accounting/trial-balance` gains two fields; existing fields are unchanged. External consumers parsing strictly would see new keys.
4. **Behaviour change for users.** A buyer can no longer raise or approve a PO for a discontinued item, and a PR can no longer reference one. This amends D7 (D-CR1) and needs owner sign-off in the release notes.
5. **Not implemented, awaiting review:**
   - M-1 `dateTo` defect, date basis D-CR7, report tie-break.
   - Item-movement screen.
   - SKU visibility in PR/PO/RFQ tables: frontend-only, ready to implement.
   - Trial-balance redesign (D-CR6).
   - Barcode model (D-CR2..D-CR4, needs a migration).
   - Transfer case pending reporter data.
6. **Release.** Nothing is committed or deployed. The full isolation regression and the business suite must run before any release approval.
