# Customer account & official statement — implementation and handover record (2026-10-24)

Branch `feature/customer-account-statement` (cut from `preview/shared-dev-2026-10-24`, `722fc73`). Not merged, not released, not deployed. The consolidation/release team owns integration. Design approved by the owner on 2026-10-24: D1–D6 (see `CUSTOMER_ACCOUNT_REVIEW_2026_10_24.md`).

## 1. Task status (what is implementation-complete / tested / integration-verified)
| Task | Dependency on earlier work | Status |
|---|---|---|
| D2 payment-integrity fix integrated (blocker) | **Depended on** the unmerged `feature/treasury-integrity` T1 + T2 | implementation complete · real-PG tests passed · **verified on the 5173-line data (`daii_dev`, Alpha)** |
| Repair of `TRS-IN-2026-000006` / `PAY-2026-000003` | needs the above | **done through the approved path, verified** (§4) |
| Statement engine: opening balance, whole last day, deterministic order, server running balance, reversal separation, reconciliation | independent (read side) | implementation complete · real-PG tests passed · live data verified |
| Business Arabic/English descriptions | independent | complete · unit + real-PG tests · live data verified |
| Indicators + aging bands (D5) | independent | complete · unit + real-PG (day-boundary) tests · live verified |
| Server-side PDF (D6) / Excel / CSV, AR + EN | independent (new library dependencies, §7) | complete · unit + real-PG render tests · real exports fetched over HTTP and rendered |
| Screens (official statement, slim dashboard, movement drawer) | independent | complete · type-checked · exercised in the browser on `daii_dev`; **no automated UI test** |
| `accounting.ar.view` on every new read route (D3) | independent | complete · metadata unit test · exercised with the admin role only |

## 2. Commits on the branch (oldest first)
`8e7c981` T1 posting guard (cherry-pick of `c60a115`) · `ff5a27e` T2 payment reversal through the owning document (cherry-pick of `548255a`; conflicts in `treasury.controller.ts` imports, `unit-specs.txt`, `TreasuryLedger.tsx` import line resolved by union) · `2c8ed33` spec constructor args · `fc1c5f6` repair path `completeOrphanedReversal` + R9/R10 · `81a1312` statement engine, exports, rules · `710d328` screens, specs · plus the follow-up commit(s) at the tip (credit-balance / over-applied indicators, lint fixes, this record, regression list, samples).

## 3. Screens and flow (D1)
- `/customers/:id/account` — slim dashboard: alerts (over limit, overdue, over-applied invoices), customer card, **«كشف الحساب الرسمي» button**, an **Actions** menu (write/navigation actions), indicator tiles, aging bands, tabs: Latest movements · Invoices & payments (write forms collapsed in a "Write actions" block) · Aging · Credit & collection (read-only) · Profile.
- `/customer-statement` — the official statement: customer · period (whole last day) · movement type · status; header (customer, tax no., address, generated reference, currency), opening / debit / credit / closing tiles, table (date, type, description, document link, due date, debit, credit, running balance, status), reversal rows dimmed, reconciliation line, warnings; **Print** (opens the server PDF), **PDF عربي / English**, **Excel**, **CSV** — all from the same payload, filters and permission.
- Movement drawer (from any row on both screens): description, recorded reason, source document link, invoice (+ due date), payment receipt, Treasury movement (+ status), creator, technical id, reversal/settlement chain; and, only when the cash/ledger mismatch exists, the **«إكمال العكس عبر المستند»** action (permission `finance.payment.reverse`).
- Reused unchanged: `/invoices`, `/payments`, `/ar-aging`. The old client-side print page was removed (it started the running balance at 0); its route now redirects to the statement.

## 4. D2 — the mismatch and its repair (evidence)
Before: Treasury `TRS-IN-2026-000006` (2.00, payment `PAY-2026-000003` on `INV-2026-000002`) was **reversed by a raw Treasury reversal** (offset `TRS-OUT-2026-000001`); its GL event `treasury.cash.recorded` had been **REJECTED** (so the GL booked nothing for the reversal); the customer ledger entry `CLE-2026-000007`, the payment and the invoice were untouched → customer balance −14.00 while cash supported −12.00; GL bank 1101 = 20.00 vs Treasury 18.00.
Fix in code: raw reversal of owned legs is refused (T2); new `PaymentsService.completeOrphanedReversal` / `POST /payments/:id/complete-reversal` **adopts the existing offset leg** (no second Treasury movement), mirrors the ledger credit with a `payment_reversal` debit, re-syncs the invoice and publishes the mirror GL event `finance.payment.reversed` once. It is **refused** when the original leg is not reversed, when there is not exactly one offset leg, or when the GL already booked the raw reversal (no double reversal). UNIQUE per payment makes a second call impossible.
Executed once on `daii_dev` (company Alpha) through the statement drawer (reason recorded, audited). After:
| Check | Result |
|---|---|
| Treasury movements | 9 before / 9 after (no new movement); `customer_payment_reversals` row `PREV-2026-000001` → existing offset leg `9c2db9c3…` |
| Customer ledger | new `CLE-2026-000009` `payment_reversal` debit 2.00; balance −14.00 → **−12.00**; statement reconciliation `matches: true` |
| Treasury vs ledger | cash received 32.00 = collected 32.00 (invoiced 20.00); account balances unchanged (2:14.00, CUST-000001:0.00, MAIN-CASH:18.00) |
| GL | `finance.payment.reversed` POSTED once; bank 1101 = **18.00 = MAIN-CASH**; AR 1110 = **−12.00 = customer ledger** |
| Invoice | `INV-2026-000002` status unchanged `paid` (remaining −2.00: see §8) |
No balance was edited by hand and no duplicate reversal exists.

## 5. Data sources and formulas (one definition each; also served as `definitions` by the API)
- **Balance** = Σdebit − Σcredit over `customer_ledger_entries`, every row (a reversal row cancels its original; no status filter). Positive = customer owes; negative = customer in credit.
- **Opening balance** = the same sum over every entry **before** the period start (UTC day). **Closing** = opening + period debit − period credit, cross-checked against an independent SQL sum to the period end (`reconciliation.matches`).
- **Period** = UTC calendar days, `from` inclusive, `to` inclusive of the **whole** day (`entryDate < to + 1 day`). Same convention as the GL business date.
- **Order** = `entryDate, createdAt, entryNumber`; running balance computed on the server in exact cents.
- **Netted out** rows = reversed originals, reversal legs, and every row of a payment reversed through its document; "totals excluding reversals" omit them, the official totals include them (they are in the balance).
- **Invoiced in period** = posted invoice + debit-note debits (no reversal rows) · **Collected** = payment + deposit + COD credits − `payment_reversal` debits (payment applications excluded: they do not change the balance) · **Returns** = `Sales/Shipment return credit` credits (the later application of that credit is excluded).
- **Remaining per invoice** = gross (net + tax) − Σ applied credits (same as `getInvoiceRemaining`, set-based). **Overdue** = remaining of invoices past due at the as-of day; shown **gross** and **net of unapplied credit** separately. **Unapplied credit** = credits with no invoice; **Customer credit balance** = −balance when negative; **Over-applied** = invoices with remaining < 0 (shown as an alert, never netted away).
- **Aging (D5)**: days past due = whole UTC calendar days, `max(0, asOf − dueDate)`; due today = 0 days (not overdue); bands 0–30, 31–60, 61–90, 90+ (30→0–30, 31→31–60, 60→31–60, 61→61–90, 90→61–90, 91→90+); "not yet due" is reported inside the first band as its own figure.
- **Statement reference** (D4) = `ST-<customer code>-<from>-<to>-<yyyymmddhhmm>-<8 hex of a SHA-256 over the content>`; stated on every output as a generated reference, **not** a register entry. No table added.
- Currency: the customer ledger has no currency column; every output states the company base currency and no mixed-currency sums exist.

## 6. API (all `GET`, `accounting.ar.view` read-only, JWT + Company context + module gate first, customer scope re-checked, other-company ids → 404)
`/customer-finance/statement/:customerId` · `…/statement/:customerId/export?format=pdf|xlsx|csv&lang=ar|en` · `/customer-finance/account-summary/:customerId` · `/customer-finance/entries/:entryId/details`. Write route added: `POST /payments/:id/complete-reversal` (`finance.payment.reverse`, idempotency key honoured). The pre-existing `ledger/:id`, `credit-summary/:id`, `balances` routes are **unchanged** (still without a permission node — changing them would alter access for existing roles; recommend the owner decides).

## 7. Build, dependencies, migrations
- **No migration is added by this branch.** Already applied to `daii_dev` and required by it: `1790030000000-CreateCustomerPaymentReversals` (T2) and the Treasury hotfix terminology `1790032000000`. `migration:show` against `daii_dev` with this branch's build: 0 pending.
- **New runtime dependencies** (`backend/package.json`, lockfile updated): `pdfkit@^0.15.2`, `bidi-js@^1.0.3`; dev: `@types/pdfkit`. Fonts (Noto Naskh Arabic + Noto Sans, SIL OFL 1.1) are embedded as base64 in `statement-fonts.ts` (no asset copying, no system fonts). **Release packaging must run `npm ci` from this lockfile.**
- Roles: the new screens need `accounting.ar.view`; users who had the customer account page only through `finance` will see the statement/indicators as unavailable until granted (the page degrades, it does not break).

## 8. Tests actually run (isolated cluster `127.0.0.1:5546`, DB guard accepted — not bypassed; database-free `jest.unit.config.js` for the pure specs)
| Suite | Result |
|---|---|
| Unit (database-free): `customer-statement-rules.spec` (14), `customer-statement-permissions.spec` (8), `statement-pdf.spec` (7: bidi layout, brackets, faces, pagination, AR+EN PDF), `treasury-ledger-labels.spec` (10) | all PASS |
| Real-PG `customer-statement.company-isolation.spec` S1–S10 (opening balance, inclusive last day, equal-timestamp order, reconciliation, reversal separation & filters, descriptions, A/B isolation, CSV/XLSX/PDF render, read-only proof) | 10/10 PASS (S10 = returns / applications / currency indicators) |
| Real-PG `payment-reversal.company-isolation.spec` R1–R11 (T2 reversal, repair R9/R10, aging boundaries + indicators R11, statement flag/net-out) | 10/10 PASS (R1–R10 + R11; R8 reconciliation included) |
| Real-PG regression set `tools/testing/regression-specs-cs-all.txt` (treasury ×4, customer ledger, invoices, payments, on-account, payment reversal, statement) | 10/10 specs PASS |
| `tsc --noEmit` backend + frontend; backend ESLint on all changed folders | clean (frontend has no ESLint config) |
| Browser acceptance on `daii_dev` (private ports 3640/5640): statement, drawer, repair, dashboard, PDF/Excel/CSV over HTTP, legacy-vs-new single-day check (legacy endpoint 0 rows, new 7) | PASS |

## 9. Regression-set result
`REGRESSION DONE: 10/10 passed` on the isolated cluster (treasury ×4, customer ledger, invoices, payments, on-account, payment reversal, statement). The statement spec was re-run alone after the returns/collections case S10 was added: 10/10 (S1–S10). Payment-reversal spec: 10/10.

## 10. Known limits and findings for the consolidation team
1. **No company profile/logo/address store exists** in the system (only the company name) — the PDF letterhead shows the name; logo, tax number and contact data need a separate decision.
2. «سجّلها» (created by) is «غير محدد» on `daii_dev` because the company DB's `users` table does not hold the creator; approver/poster are not stored on ledger rows.
3. Branch filter: not applicable (no branch on ledger entries in this line).
4. The PDF "Print" opens the server PDF in the browser viewer (print from there); there is no separate HTML print layout.
5. `INV-2026-000001` (−10.00) and `INV-2026-000002` (−2.00) are **over-applied** in the dev data (a deposit and an on-account payment were both entered for the same orders). This is shown as an alert; correcting such cases is a business/accounting decision, not done here.
6. The PDF falls back to normalised hamza/diacritic forms for the few ligatures the font subset cannot position (never fails the statement).
7. Existing read routes (`ledger/:id`, `credit-summary`, `balances`) remain without a permission node (see §6).
8. Not covered by automated tests: the React screens (browser-verified only), permission behaviour with real non-admin roles over HTTP, the `Print` button in a real print dialog.
9. The Treasury hotfix (separate branch/commit `428f8c7`, ported on integration as `428f8c7`) is part of the base of this branch; its own handover is `docs/handover/TREASURY_HOTFIX_HANDOVER.md`.

## 11. Integration notes
Cherry-pick/merge order for consolidation: (1) `feature/treasury-integrity` T1/T2 or this branch's copies `8e7c981`, `ff5a27e` (identical content, conflicts already resolved against the Treasury hotfix), (2) the repair/statement commits. Bring `package.json`/lockfile with it. No data step is required on other databases except **running the repair once per environment that still holds a raw-reversed payment** (the statement shows the flag and the drawer offers the action; refused automatically when the GL booked the raw reversal).

## 12. Shared preview (localhost:5173) integration and browser acceptance — 2026-10-24
**Integration:** the preview worktree `.claude/worktrees/preview-shared` (branch `preview/shared-dev-2026-10-24`, clean tree, nothing else in it) was **fast-forwarded** from `722fc73` to this branch (9 commits, no conflicts, no other team's work touched). The preview worktree's `backend/node_modules` was a junction to the main checkout (which lacks `pdfkit` / `bidi-js`): the junction was removed (`rmdir`, main `node_modules` verified intact: 589 entries) and `npm ci` was run from the new lockfile inside the worktree; the backend was rebuilt (`tsc -p tsconfig.build.json`) and **only the shared backend (3500) was restarted**; Vite (5173) was left running and serves the new files by HMR. `migration:show` with this build against `daii_dev`: 0 pending. Verified that 5173 serves the new sources (`CustomerStatement.tsx` calls `/customer-finance/statement`, `LedgerEntryDrawer.tsx` present) and that 3500 has the new routes (401 unauthenticated, not 404).
**Preview commit:** tip of `preview/shared-dev-2026-10-24` = this branch's tip at the time of the final sync (see `git log -1` on that branch; it equals `feature/customer-account-statement`).

**Browser/HTTP acceptance on 5173 (admin, company Alpha, `daii_dev`):**
| Area | Result |
|---|---|
| Account dashboard | tiles: balance −12.00, customer credit balance 12.00, unapplied advances 0.00, overdue 0.00, invoiced 20.00, collected 32.00, returns 0.00; over-applied alert (2 invoices, 12.00); aging bands; official-statement button; Actions menu; write-forms collapsed by default; tabs incl. read-only Credit & collection |
| Statement | full period: opening 0.00 / debit 22.00 / credit 34.00 / closing −12.00, reconciliation «مطابق»; 9 rows; **daily period 22 Oct**: 7 rows, opening −10.00, first running balance −12.00, closing −14.00 (set through the date inputs + Generate); 20 Oct: 1 row; `from` only: opening −10.00 / closing −12.00; empty month: opening = closing −12.00; unknown customer 404; invalid status 400 |
| Drawer / documents | row opens the drawer (source document, invoice link, receipt, Treasury status, reversal chain); no repair button now (mismatch gone); invoice link opens `/invoices/:id` (INV-2026-000002 rendered) |
| Output | buttons produced: PDF عربي (application/pdf), PDF English, Excel (xlsx), CSV, and **Print** (opens the PDF blob in a new window) — all with the on-screen period/filters; real PDFs rendered earlier in both languages |
| Permissions / scope | no token 401, bad token 401; company **Beta** token on Alpha's customer → **404** for statement, export and summary; Alpha token → 200 on all; guard denial → 404 proven in unit tests (`accounting.ar.view` required, §8); **not tested over HTTP with a real non-admin role** (no such account with known credentials; creating one was out of scope) |
| Reconciliation | customer ledger ↔ Treasury: customer receipts in the Treasury ledger (posted, non-reversal) **32.00** = ledger collected net of reversals **32.00**; Treasury balances 14.00 / 0.00 / 18.00 unchanged; GL bank/AR agree (§4) |
| PAY-2026-000003 / TRS-IN-2026-000006 | **not re-executed.** Replaying `complete-reversal` and the normal `reverse` both return **409 "already reversed (PREV-2026-000001)"** before any mutation; counts unchanged afterwards: reversals 1, Treasury movements 9, ledger reversal rows 1, `finance.payment.reversed` events 1, original leg `reversed` |
| Other screens (12 routes: customers, accounts, invoices, payments, aging, Treasury settings/balances/ledger, sales orders, shipments, collection settlements) | render, no raw terminology codes, no error banners, no JS errors |
| Unit | permission guard enforcement tests added (13/13 in `customer-statement-permissions.spec`) |
**Differences / limits:** the Browser pane was too narrow for readable screenshots during this run, so evidence is DOM/network based (the real PDFs were visually checked earlier); the pre-existing `daii_dev` over-application on both invoices remains (alert shown, no data change).
