# Treasury Hotfix — Shared-preview (port 5173) integration record

Date: 2026-10-24. Companion to `TREASURY_HOTFIX_HANDOVER.md`. Preview integration and acceptance only — no merge to main, no release, no deploy.

## 1. What the 5173 preview is made of (observed, read-only)
| Part | Finding |
|---|---|
| Frontend `:5173` | Vite dev server (PID 11012) started from the **main checkout** `release-new/frontend` — it serves whatever the main checkout's working tree contains at that moment (HMR). |
| Backend `:3500` | `node dist/main.js` (PID 6856, started 2026-10-24 17:08) — a **compiled build** of the main checkout (`backend/dist`, built 2026-10-22 09:24 from the `b661124` lineage; it already contains the deferred Shipping Expenses code). It has none of the hotfix routes (`GET /api/treasury/ledger/report` → 404 observed). |
| Other tree | `.claude/worktrees/integration` (`integration/local-2026-10-16` @ `eabd3fd`, 96 commits ahead of the hotfix base) has its own older `dist`; it is **not** what 5173/3500 serve. |

## 2. Base commits
- `hotfix/treasury-ledger-nav` = `dadc2ed` on top of `b661124` (tip of `feature/direct-sale-shipping`); merge-base with `integration/local-2026-10-16` = `5e41647`.
- **Incident to know about:** while the hotfix branch was checked out in the main checkout, the 5173 frontend (HMR) served the new Ledger page against the 3500 backend that has no ledger endpoints → the Ledger screen on 5173 was broken (404) and the menu was unchanged. The main checkout was switched back to `feature/direct-sale-shipping` (the preview owner's branch); the 5173 frontend serves the previous Ledger page again. Nothing was stopped or restarted; no file of another team was changed.

## 3. Exactly what the hotfix consists of
- Commit `dadc2ed` (preview-baseline line) — 15 files, 956 insertions / 73 deletions: backend `treasury-ledger-labels.ts`, `treasury-ledger-report.service.ts`, `treasury-ledger-labels.spec.ts`, `treasury.controller.ts`, `treasury.module.ts`, `navigation-registry.ts`, `t06-collection-idempotency.biz.real-pg.spec.ts` (constructor args), migration `core/1790032000000-SeedTreasuryNavSplitTerminology.ts` (data only); frontend `App.tsx`, `guide.ts`, `TreasuryAccounts.tsx`, `TreasuryBalances.tsx` (new), `TreasuryLedger.tsx`, `covers/TreasuryCover.tsx`; docs.
- Commit `428f8c7` on `hotfix/treasury-ledger-nav-on-integration` — the same change ported onto `integration/local-2026-10-16` (`eabd3fd`). Only conflict: `TreasuryLedger.tsx` (integration added `fmtDateTime` / `loadingLabel`); resolved by keeping the hotfix page and adopting those two helpers. Built without touching any checkout (git plumbing).
- **Excluded on purpose:** Shipping Expenses (sales-orders / shipment / Shipments.tsx / CollectionSettlements.tsx / DepositPanel.tsx / SalesReturns.tsx / SalesOrders*.tsx / migration `sales/1790031000000-AddSalesOrderShippingFee.ts`), `.claude/launch.json`, `_release-output/*`.

## 4. Compatibility review
- vs preview baseline (main checkout tree): the hotfix files do **not** overlap with any modified/untracked file in that working tree (empty intersection) → clean to apply.
- vs integration: dry-run `git merge-tree` → one textual conflict (above), none semantic. Resolved branch type-checks: backend `tsc --noEmit` exit 0, frontend `tsc --noEmit -p tsconfig.app.json` exit 0 (clean `git archive` export, `node_modules` linked read-only, links removed afterwards, shared `node_modules` intact).

## 5. Migration status
- `1790032000000-SeedTreasuryNavSplitTerminology` — **NOT applied anywhere.** No isolated preview database has been approved: the approved cluster `127.0.0.1:5546` is down and `daii_dev` / production are not authorised for this task. Consequence on any preview without it: the sidebar shows the raw codes `nav.treasury_settings` / `nav.treasury_balances` (Balances page title has an inline fallback).
- Target + status to be confirmed by the preview owner before applying (`terminology_entries` rows for those two codes absent = not applied).

## 6. Tests and checks
| Check | Result |
|---|---|
| Backend / frontend `tsc --noEmit` on both hotfix branches | clean |
| `treasury-ledger-labels.spec.ts` logic (10 cases) | 10/10 PASS via jest-API shim, **not through jest** |
| `jest` (incl. real-PG treasury suites, new SQL) | **NOT RUN** — DB guard refuses `daii_dev:5433`; no approved isolated cluster is up; guard not bypassed |
| ESLint | **NOT RUN** — frontend has no `eslint.config.*` |
| Browser acceptance | Done earlier on private ports 3620/5620 (`dist/hotfix` build, `daii_dev` Alpha, read-only): Ledger, details drawer, totals (32.00 = independent sum), CSV + XLSX of all matching rows, Balances. **NOT done on 5173**: needs the 3500 backend rebuilt/restarted — owner's action. |

## 7. Steps for the owner of 5173 (not performed by this team)
1. Pick the base: `hotfix/treasury-ledger-nav` (`dadc2ed`, applies on the current 5173 baseline) **or** `hotfix/treasury-ledger-nav-on-integration` (`428f8c7`).
2. Bring the commit into the tree that 5173/3500 are built from (`git cherry-pick dadc2ed` / `428f8c7`; no conflicts expected on the 5173 baseline).
3. Rebuild the backend and restart `:3500` at a time the owner chooses (`dist` is compiled; the frontend picks the change up by HMR).
4. Apply migration `1790032000000` only to an approved database after confirming its target.
5. Re-run the checks in section 6 on 5173: Settings, Balances, Ledger — filters, details drawer, totals, CSV/XLSX.

## 8. Remaining blockers
- Approved isolated database (or a restored 5546 cluster) for jest + real-PG testing of the new SQL and for the migration.
- Coordinated backend rebuild/restart of `:3500`.
- No ESLint configuration in the frontend.
