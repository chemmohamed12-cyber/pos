# Treasury Hotfix — Navigation Separation & Financial Movement Ledger — Handover

Branch: `hotfix/treasury-ledger-nav` (cut from `b661124`, tip of `feature/direct-sale-shipping`). Not merged, not released, not deployed.
Owner of integration, consolidated regression, merge and release: the previous team.

## Task TH-1 — Treasury navigation split
- **Acceptance:** the Treasury menu has Treasury Settings, Treasury Account Balances, Financial Movement Ledger; Balances is read-only; Settings keeps setup / GL mapping / status.
- **Independent of previous work:** yes.
- **Changes:** `navigation-registry.ts` (two items replace `/treasury/accounts`), `App.tsx` (routes `/treasury/settings`, `/treasury/balances`; `/treasury/accounts` redirects to settings), `TreasuryAccounts.tsx` (balance column removed — it moved to Balances), new `TreasuryBalances.tsx` (read-only), `TreasuryCover.tsx`, `guide.ts` (links).
- **Data-only migration (REQUIRED for the two new menu labels):** `backend/src/database/migrations/core/1790032000000-SeedTreasuryNavSplitTerminology.ts` — inserts `nav.treasury_settings`, `nav.treasury_balances` (`ON CONFLICT DO NOTHING`; `down` deletes exactly those rows). **No schema change.** NOT applied to any database. Until it is applied the sidebar shows the raw codes for those two entries (the Balances page title has an inline fallback).

## Task TH-2 — Financial Movement Ledger (report, drawer, export, print)
- **Independent of previous work:** yes, with one verified relationship: the report reads existing `treasury_transactions` rows and joins the existing party/document tables; it adds no table, column or posting behaviour. It does not depend on the deferred Shipping Expenses feature.
- **Backend:** `treasury-ledger-labels.ts` (pure classification + totals), `treasury-ledger-report.service.ts` (SQL joins, filters, details, CSV/XLSX export), `treasury.controller.ts` + `treasury.module.ts` (routes `GET /treasury/ledger/report`, `GET /treasury/ledger/export?format=csv|xlsx`, `GET /treasury/transactions/:id/details`; all `finance:editable`, org-unit scope applied, `accountId` goes through `assertLedgerAccountAccess`). The old `GET /treasury/ledger` is untouched.
- **Spec fix required by the new constructor args:** `foundation/testing/t06-collection-idempotency.biz.real-pg.spec.ts` (`new TreasuryController(...)` now takes 2 extra args; passed as `undefined as never` because that spec never calls them).
- **Frontend:** `TreasuryLedger.tsx` (filters, totals tiles, server-side pagination, details drawer with related movements + existing `FinancialTrace`, Excel/CSV/print, manual cash-in/out/transfer and reverse preserved).
- **Meaning rules (from existing posting reasons only, nothing inferred):** deposit, invoice payment, on-account payment, COD collection (custody), COD remittance, supplier payment, payroll disbursement, manual receipt/disbursement, transfer, reversal. Missing party/reason/document shows «غير محدد».
- **Totals:** posted rows only; transfers (both legs, incl. `shipping_collection_settlement`), reversed rows and reversal legs are excluded. COD custody collection and remittance-by-transfer count once (the transfer is excluded); remittance-by-cash-in and custody collection are mutually exclusive per collection in `delivery.service.ts`. Summary and export cover ALL matching rows, never the page.
- **Currency:** the Treasury ledger has no currency column — all amounts are the company base currency and the screen/export say so. Multi-currency totals are not possible without a schema change (not authorised).

## Verification actually performed
| Check | Result |
|---|---|
| `tsc --noEmit` backend (`tsconfig.json`) | clean |
| `tsc --noEmit` frontend (`tsconfig.app.json`) | clean |
| Unit logic of `treasury-ledger-labels.spec.ts` (10 cases: labels, no-invention, transfers, no double count, exact cents, SQL covers every kind, filters bound as parameters, export uses the all-rows path) | 10/10 PASS — run through a minimal jest-API shim with ts-node, **not** through jest |
| `jest` | **NOT RUN** — the DB guard refuses ambient `daii_dev:5433` and the approved isolated cluster (5546) is down; guard not bypassed |
| ESLint | **NOT RUN** — frontend has no `eslint.config.*` (ESLint 10 finds no config) |
| Browser acceptance (own ports 3620/5620, `dist/hotfix` build, Alpha company on `daii_dev`, read-only report queries) | Ledger loads 9 movements with party/document resolved; summary receipts 32.00 / payments 0.00 / net 32.00 equals an independent sum from `GET /treasury/ledger`; row opens details drawer (200); CSV (20 lines, header block with company/period/scope/totals, BOM) and XLSX (valid zip) download all matching rows; `family=receipt&status=posted` filter returns 5 rows; Balances page read-only |
| Real-PG integration specs for the new SQL | **NOT WRITTEN/RUN** (no approved isolated DB) — the SQL was proven only against `daii_dev` through the preview. First attempt exposed `suppliers.name` (real column `legalName`); fixed |

## Known limitations / for the previous team
1. Move the migration into the release set and apply it through the normal gate; run the real-PG treasury suites + the new ledger SQL on an approved isolated cluster.
2. «أنشأها» (created by) shows «غير محدد» on `daii_dev` because the company DB's `users` table does not hold the creator; approver/poster are not stored on `treasury_transactions` and are therefore not shown (no schema change).
3. Source-document links: invoice, sales order, payroll run open their page; supplier invoice and shipment link to their list pages (no detail route exists).
4. Journal-entry detail in the drawer relies on the existing `FinancialTrace` component (accounting permission applies there).
5. PDF = browser print of the screen (no server-side PDF); the print output is the on-screen report.
6. The working tree also holds the **deferred Shipping Expenses** work and other unrelated edits; none of it is in this branch's commits. Do not merge them with this hotfix.
7. `.claude/launch.json` got two local preview entries (`th-backend`, `th-frontend`) — not committed.
8. The built preview lives in `backend/dist/hotfix/` (git-ignored); delete it freely.
