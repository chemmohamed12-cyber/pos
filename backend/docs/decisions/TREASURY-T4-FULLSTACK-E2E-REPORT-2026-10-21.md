# Treasury — full-stack browser acceptance (T4 carry-over) — 2026-10-21

Branch `feature/treasury-integrity` (code = bef1c0e + the two-line dropdown fix in this commit). **Isolated environment only**: control-plane DB `daii_test_biz_t79_tr_cp` and Company DB `daii_test_biz_t79_tr_co` on the dedicated test cluster 127.0.0.1:5546 (DB guard active; created by `bv-bootstrap`, all tags migrated, `bv-seed` master data), real backend `dist/main.js` on **:3679**, real Vite frontend on **:5679**. `daii_dev`, Alpha–Delta, :5173, :3500 and Procurement's `biz_t80_*` environment were not touched. Test credentials are the `bv-*` bootstrap defaults (never real). The environment is left running; nothing was merged, versioned or deployed.

## Flow executed in the browser (Arabic, real API, real PostgreSQL)
| # | Step | Result |
|---|---|---|
| 1 | Login as maker, Treasury workspace | PASS — real balances/KPIs, unmapped-account counter correct |
| 2 | New document → customer collection, open invoices loaded from the real customer ledger, full allocation | PASS — draft TD-2026-000001, projected GL effect shown (Dr 1101 / Cr AR) |
| 3 | Submit for approval; maker sees "waiting for someone else — you cannot approve your own document" | PASS — self-approval blocked in the UI and by the API |
| 4 | Second user: approve, then execute (separate action) | PASS — Treasury cash_in TRS-IN-2026-000001 = 1,200.00; journal JV-2026-000001 Dr = Cr = 1,200.00; financial event POSTED; customer ledger: invoice debit 1,200 / payment credit 1,200 |
| 5 | Document detail shows settlement "executed and posted, not yet matched with a bank statement" | PASS |
| 6 | Statement import (form validation, arithmetic indicator) → suggest → confirm → reconcile | PASS — proof table difference 0.00; reconciled; nothing matched before the explicit confirm |
| 7 | Cash session open → close with short count and no reason | PASS (refused, "a reason for the variance is required. Nothing was closed") → close with reason → draft disbursement TD-2026-000002 (5.00) created, session immutable, "re-open" offered |
| 8 | English mode on the document list | PASS — all headings/status labels translated |
| 9 | Empty state (no statements) | PASS |

## Findings
- **Fixed (this commit):** the statement-import and cash-session dropdowns also listed an *inactive* account (the document form already filtered it). Now filtered; `tsc -b` clean.
- **Observation, not changed:** server-supplied text (projected-effect labels such as "Receiving cash / bank account", validation messages) is English inside the Arabic UI — pre-existing server message convention, recorded for the terminology backlog.
- **Observation, not changed:** the pane at ~565 px wide clips the shared application shell (sidebar is not collapsible at that width) — shared layout, not Treasury-specific.
- Environment artefacts, not product defects: the seed invoices had no customer-ledger rows (open-invoice list empty until rows with `entryType='sales_invoice'` were added); the second bootstrap user is a platform admin.

## Not covered here (classified)
- Restricted-role browser session (a user lacking a node): permission enforcement is proven over real HTTP in the real-PG specs (`treasury-documents.http`, 10/10) and the UI gating in the dev harness; **PARTIAL** for a restricted role on the full stack.
- Loading/error/network states on the full stack: proven in the harness (modes ok/slow/error/network/empty); **PARTIAL** on the full stack.
- Screen sizes: desktop and ~565 px observed; tablet/phone breakpoints not exercised on the full stack.
- `release-migration-registry.real-pg` (needs 5544): **BLOCKED**, unchanged.
