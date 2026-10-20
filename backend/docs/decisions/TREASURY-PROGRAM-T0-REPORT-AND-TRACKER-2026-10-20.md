# DAII Treasury program — T0 report and execution tracker (2026-10-20)

Authority: CTO Master Execution Order (sequential, phase-gated). Branch `feature/treasury-integrity` (worktree `.claude/worktrees/treasury-integrity`, `node_modules` are junctions to the main checkout — **never `git worktree remove` this worktree**). Main checkout, `main`, the release and every other worktree are untouched.

## 1. Baseline (verified, not assumed)

| Item | Finding |
|---|---|
| Branch base | `integration/local-2026-10-16` @ `00cd8ee` (clean). Chosen because it is what 5173 serves, so Treasury work previews without a merge to `main`. `main` = `505584d` |
| **5173 serves** | Vite process (`--port 5173 --strictPort`) whose module ids resolve to `.claude/worktrees/integration/frontend/src/…` (read from the served `App.tsx`/`main.tsx`); proxy → `localhost:3500` |
| **3500 serves** | Integration backend build (`dist/main.js`) launched by a scratchpad launcher that reads the main checkout's `backend/.env`: `daii_dev` on `localhost:5433`, NODE_ENV=development |
| Experimental DBs on 5433 | `daii_dev` (platform), four READY companies (Alpha/Beta/Gamma/Delta), 5 more orphan `company_*` DBs, many rehearsal/redteam DBs. 0 active connections apart from this session at the time of the check |
| Dedicated test cluster | `127.0.0.1:5546` (DB guard; `tools/testing/biz-run.js`, DB names `daii_test_<ns>…`) is listening; used for destructive real-PG specs |
| Other work in flight (preserved) | `dev-preview` worktree: **22 dirty files** (item-details / trial-balance / PO eligibility) — not ours, untouched. `procurement-allocations` worktree clean at `7baf2f2`/branch head `6044748` |
| Current data | The four READY company DBs hold **no treasury data** (Alpha: 0 treasury legs, 2 journals / 2 events from GRNI; others empty) and `daii_dev` has 1 account, 0 legs. The earlier D3-era data lives only in the rollback snapshot below |

## 2. Read-only data investigation — results

Targets (experimental, per CTO mandate): all 9 `company_*` DBs and `daii_dev` (counts only; empty), and **`daii_dev_rollback_20261004_2358`** (the pre-reset snapshot: 101,869 treasury legs, 5,674 journals, 5,515 financial events, 2026-09-17 → 2026-10-04) with the full script. Every statement ran inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, 60 s timeout, client encoding SQL_ASCII (the snapshot contains non-UTF8 Arabic bytes). Nothing was repaired, re-driven or modified. Raw output: `evidence-treasury-integrity-2026-10-20/` (`01-rollback-snapshot.txt`, `02-explain.sql/.txt`, `00-company-map.txt`).

Script defect found and fixed while running: Q1's `HAVING` referenced a non-grouped column (error); changed to `WHERE` before grouping. Rerun succeeded (exit 0).

| Check | Result | Classification |
|---|---|---|
| **Q5 stop-conditions**: unbalanced journals, header/line mismatch, POSTED event without journal, duplicate journals per event | **0 rows** | No duplicate posting, no unbalanced journal in the snapshot |
| Q6 payments whose cash leg was reversed directly (G-06) | 0 rows; and **0 reversed legs at all** (`02-explain` H) | G-06b not exercised in this data — it remains a code-level defect |
| Q1c outbox not dispatched | 0 rows | no dead letters |
| Q4 clearing account | not configured in the snapshot (`config_values` has no `…clearing…` key) | direct cash-in cannot post GL here; see Q1 below |
| **Q1 legs without a POSTED event** | 278 unmapped test accounts (`E2EACC-*` 142, `PACC-*` 136): 101,859 legs, net ≈ 27.2 bn, **NO_EVENT**; `MAIN-CASH` (unmapped) 6 legs; `M0001`: 2 deposit legs (22.00) → `deposit.verified` **REJECTED** ("treasury account is not GL-mapped"), 1 direct cash-in 200.00 → `treasury.cash.recorded` **REJECTED** ("clearing account is unset") | G-03 and G-04 **confirmed in data** (see below) |
| **Q3a Treasury vs GL (1101)** | treasury 142.00, GL −2,000.00, drift **2,142.00**, 6 GL lines | **Fully explained** (below) |
| Other REJECTED events (non-treasury) | inventory negative_on_hand 18, `no_valuation_source` 4, WIP account missing 31, payroll wages-payable missing 6, fixed-asset 7, deadlock 3 (manufacturing), collection.remitted unmapped 1 | out of Treasury scope; recorded for the owners; the 3 `deadlock detected` rejections are evidence for the deadlock-retry review in T1 |

**Drift 2,142.00 on 1101 decomposed to the cent:**
- 222.00 = 22.00 (two verified deposits whose GL event was rejected) + 200.00 (direct cash-in whose GL event was rejected) → treasury moved, GL did not (**G-03**);
- 1,920.00 = net of `MAIN-CASH`'s five payments (customer +125.00, supplier −500 −775 −195 −575) that were posted to **1101 by the pre-D2 bank-control fallback** although `MAIN-CASH` is unmapped → GL moved on the wrong account (the D2 root cause, fixed 2026-10-05);
- 222.00 + 1,920.00 = 2,142.00 ✔. `MAIN-CASH` balance 3,080.00 = 5,000 test funding (direct cash-in, unmapped ⇒ **no GL at all**, G-04) − 500 − 775 + 125 − 195 − 575 ✔.

**Interpretation / gate:** every difference is explained, historic (all pre-D2 or fixture data), and sits in an experimental snapshot that has since been replaced by a rebuilt `daii_dev`. There is **no unexplained drift, no duplicate posting, no unbalanced journal and no cross-company finding**, so no stop-condition is triggered. They confirm the design's premises: the system **accepted money movements with no GL owner** (G-04: 278 unmapped accounts, ≈27 bn of fixture cash) and **kept treasury rows whose events were rejected** (G-03: 3 legs, 222.00). The DB-wide row counts also show how prior fixtures were generated: direct cash-in on unmapped accounts — behaviour the T1 guard will reject, so legacy fixtures/specs that rely on it must be updated in T1 (tracked as an item).

## 3. Procurement ownership boundary (to avoid collision)

`feature/procurement-invoicing-allocations` (head `6044748`; phases A, B, C-1, E committed) **already implements "one supplier payment over several invoices"**: it modifies `procurement/application/supplier-payment.service.ts`, `…/supplier-payment.controller.ts`, adds `supplier-payment-allocation.entity.ts` and migration `1790020100000-CreateSupplierPaymentAllocations`, plus `supplier-invoice.handler.ts` and the supplier-invoice lifecycle (Draft→Posted, approval). It is **not** in the integration branch/5173 yet.

| Area | Owner | Rule |
|---|---|---|
| `supplier-payment.service/controller`, allocation entity, supplier-invoice lifecycle & handler, `goods-receipt.handler` | **Procurement** | Treasury does **not** edit these. Supplier-payment **reversal** (T2.1) will be built as a separate service against Procurement's allocation model, after it is merged into the integration line |
| `treasury.service`, treasury controller, `finance-handlers` cash/transfer handlers, customer payments, treasury permissions, new posting-preflight contract | **Treasury** | Procurement avoids editing these |
| Shared contract surface (`FinanceTreasuryContract`, `FINANCE_*` contracts, `ap-events.contract`) | shared | changes additive only; notify the other team before touching |
| Migrations | both | disjoint timestamps; Treasury reserves `1790030000000+`. Procurement's are `17900201…–17900202…` |

**Consequence for the plan:** T2 supplier-payment reversal and T3 supplier multi-invoice allocation are **dependent on Procurement's branch**; T3 reuses (does not rebuild) its allocation model. Until it lands, those items are sequenced after customer-side work. This is a dependency, not a blocker.

## 4. Gate T0 — result: **PASSED**

- Branch/preview baseline documented ✔ · relevant code and tests identified (audit doc) ✔ · read-only results captured, abnormal results classified and retained ✔ · ownership boundary documented ✔ · no historical record modified ✔ (all transactions READ ONLY + ROLLBACK).
- Proceeding to **T1**.

## 5. Execution tracker

| Phase | State | Evidence / commit | Open |
|---|---|---|---|
| T0 | **Passed** 2026-10-20 | this file + evidence dir | — |
| T1 | In progress — starting with the atomic-posting spike (T1.2) on disposable DBs | — | legacy specs/fixtures that use unmapped cash-in need an explicit policy (§2) |
| T2–T7 | Not started | — | T2 supplier reversal depends on Procurement merge (§3) |
| Preview 5173 | Baseline (integration `00cd8ee`, backend 3500/`daii_dev`); no Treasury change shown yet | — | do not switch the preview until a gate passes |

Owner decisions still open (do **not** block T1): closed-period redrive policy; payroll cash-leg bank GL; un-apply vs same-unit reversal for applied on-account receipts; approval threshold matrix; payment recognition timing per instrument.
