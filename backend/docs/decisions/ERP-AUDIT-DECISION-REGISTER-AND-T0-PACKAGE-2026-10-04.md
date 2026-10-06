# ERP Integrity Audit — Area 21 baseline, Decision Register, T0 Package (2026-10-04)

Companion to `ERP-FUNCTIONAL-INTEGRITY-AUDIT-2026-10-04.md`. **No code/schema/config/data changed. T0 NOT executed (awaiting CTO GO).**

## 1. Area 21 baseline — re-derived from the live Matrix (file mtime 2026-10-04 16:31; sections §16–§52)

Authoritative source: `AREA21-RETROFIT-MATRIX.md` — §1.2 tables (13 Tier-1 + 30 Tier-2 = **43**), §51 (corrected count), §52 (latest closure).

```text
43 Controllers
├── CLOSED: 27
├── OPEN (independently safe, unstarted): 0
├── BLOCKED: 15
│     ├── 13 by ApprovalEngineService (§49/§2.2 decision)
│     └──  2 by Tax/Invoice dependency (invoices §24, returns §23)
├── STOP/ESCALATE (ownership decision): 1  (sales — `sales_rep` platform role, §38)
└── Remaining: 16   (27 + 16 = 43 ✔)
```

**CLOSED (27):** sales-orders, products, price-lists, customers, inventory, inventory-valuation, customer-ledger, supplier-invoice, treasury, shipment, fulfillment, payments, delivery, bom, deposits, warehouse-transactions, goods-receipt, purchase-order, purchase-request, supplier-payment, grni, wip, sales-returns, shipment-returns, work-order, reports, **general-ledger (§52, 2026-10-04)**.
**BLOCKED — Approval Engine (13):** supplier, ap, ar, cash-bank, inventory-accounting, fixed-asset, attendance, commission, hr, payroll, rfq, target, accounting.
**BLOCKED — Tax/Invoice (2):** invoices, returns. **STOP/ESCALATE (1):** sales.

Discrepancy explained: the CTO's "15/43" is the count that was current at §35 (`bom`), when the true count was 14 (the +1 ordinal error §51 corrects). The matrix has since advanced: 26 at §51 (2026-09-28), **27 after §52 (2026-10-04)**. Nothing is re-executed because of the number. Caveat: counts are read from the document, not re-proven by running every isolation spec.

Note: the audit's blast-radius table said "26 CLOSED / general-ledger OPEN" — now **general-ledger is CLOSED**; COA routes live in `accounting.controller` (still BLOCKED).

## 2. Decision Register (status = CTO PRELIMINARY RECOMMENDATION — not final until CTO signs)

| D | Preliminary decision | Still-open sub-questions (must be answered before implementation; none assumed) |
|---|---|---|
| D10 | **Gate for all accounting remediation.** Make Event dispatch Company-aware (Matrix §50 recommends handler ctx `{manager, companyId}` + per-Company dispatcher; alternative = Platform outbox with `companyId` envelope). Needs an ADR. | Option A (ctx + per-Company dispatcher) vs B (Platform outbox)? Approval Engine scope (§2.2) interacts (13 blocked controllers + approval callbacks). |
| D2 | Payment posts to the **paying treasury account's mapped GL**; unmapped ⇒ **REJECT, no fallback**; mapping editable in UI; ideally a prerequisite for financially-active accounts. | Mandatory at account creation or at first posting? What happens to the already-existing unmapped accounts / the ~250 test accounts? Customer on-account payments (no invoice) in scope? |
| D3 | **P0 policy decision — no code until a posting table is approved** for: Receipt, Opening Stock, Adjustment, Transfer, Return In, Dispatch. | The table itself (accounts per movement type). Per-warehouse GL accounts vs one central `inventory` control (decides Transfer treatment). Link to INV-03. |
| D5 | P1 policy: PO≠Invoice price variance + Supplier-Invoice VAT, before Procurement accounting is "complete". | PPV account; Input VAT account (1140 exists, unused); tax fields on supplier invoice. |
| D4 | P0: financial returns — Inventory + COGS reversal + Revenue reversal + AR/customer credit; settlement by Credit Note / Refund / Customer Credit Balance. | Which settlement modes ship first; credit-note document model; interaction with `returns` (BLOCKED, Tax dependency). |
| D6 | Keep maker-checker. Fix visibility: show `approvalRequestId`/"Pending Approval", surface in Approval queue; ratify checker rule. | Approval-matrix rule for `procurement.rfq_award` (approver node, min approvers). `rfq` controller is Approval-Engine-BLOCKED → UI-only change vs backend touch. |
| D1 | **Real Item↔Warehouse assignment** (master data; scope/eligibility of an item per warehouse). Stock stays `stock_movements`; assignment never stores balances. | Strict enforcement (block movements/receipts for unassigned pairs) or advisory? Many-to-many cardinality; migration/backfill for existing movements & the 5,291 test products; effect on sales-order/PO/transfer validations; assignment per warehouse **kind** (main/operational)? |
| PRC-01 | Show on-hand/reserved/available in PR/RFQ/PO via existing `GET /inventory/stock`. | "On Order" has no model — in scope or deferred? |
| D8 | Keep manual-JE + `link-acquisition` architecture; **complete UI/workflow** (pending→JE→link→active). | Does the UI also help create the acquisition JE, or only link an existing POSTED one? (`fixed-asset` is BLOCKED.) |
| D9 | Supplier **Edit: yes**; **code auto-numbering**; **no per-supplier GL account** (keep Supplier→sub-ledger→AP control). | Which fields editable after history exists; numbering format/prefix; `supplier` controller is Approval-Engine-BLOCKED. |
| D7 | **New Item Request** capability: PR line = Existing Item OR New Item Request → approval/coding → becomes Stock Item. No free-text items. | Model (draft product vs request entity), approver, how a request converts and relinks PR lines. |

**Execution order (CTO):** D10 → D2 → D3 → D5 → D4 → D6 → D1 → PRC-01 → D8 → D9 → D7 → COA/remaining P1/P2. Per item: VERIFY → ROOT CAUSE → SCOPE → IMPLEMENT → REAL-PG TEST → A/B ISOLATION → REGRESSION → DOCUMENT → CLOSE. Touching a CLOSED controller ⇒ re-run its real-PG isolation + document blast radius.

**Sequencing observations for CTO review (not decisions):**
1. D6/D8/D9/COA touch controllers that are still BLOCKED (rfq, fixed-asset, supplier, accounting) — only UI-level work is possible until the Approval Engine decision (§2.2).
2. D10 vs D2–D5 ordering is correct: §50 states every automatic GL posting for a Company-routed operation is not Company-correct today.
3. Config keys the policies depend on (`accounting.inventory_cogs_account_code`, `accounting.cash_movement_clearing_account_code`) have scope levels `platform/edition/installation` — **installation-wide, not per-Company** (Matrix Gate D). Per-Company COGS/clearing accounts are impossible until that is decided.

## 3. T0 Clean-Company verification package (PREPARED — NOT EXECUTED)

**⚠ Scope warning (must be decided before GO):** per Matrix §50, in a fresh Company **event-driven GL posting will not run today** (events land in the Company outbox; handlers use the ambient DB). So T0 in a Company cannot baseline PRC-05/TRS-01/INV-04/SRT-02 GL effects *before* D10 — it will show "no journals" (the D10 symptom itself). Proposed split:
- **T0a (pre-D10 baseline):** all operational legs + expected-fail GL legs; proves/records the D10 symptom with an executable test (the "Recommended proof" in §50).
- **T0b (post-D10):** repeat the financial legs; this is the real reconciliation baseline for D2–D5.
CTO decides: run T0a now, or hold T0 entirely until D10.

### 3.1 Preconditions (verify, do not assume)
- `Installation` row exists (else `POST /installation/companies` fails on the FK) — dev DB had 0 rows on 09-27; the later P0 verification companies exist, so re-check.
- A platform `admin` token; `initialAdminUserId` = an existing User. A **second** existing User is needed for maker-checker (RFQ award) and must receive a Membership + `procurement.rfq_award` editable.
- Postgres reachable with `CREATE DATABASE` privilege (the endpoint creates a physical DB `company_<uuid>`).

### 3.2 Steps (endpoints verified from source; **request bodies to be pinned from each DTO at execution — no invented fields**)
1. `POST /installation/companies` `{name, initialAdminUserId}` → expect `READY`, `databaseStatus ACTIVE`. Record `companyId`, DB name.
2. `POST /auth/select-company` → Company-scoped token; `POST /memberships` (Company-scoped) to grant user #2.
3. Chart: `GET /accounting/chart/templates`, `POST /accounting/chart/import-template {templateKey, dryRun}` (IFRS-SME); confirm control functions present (bank, ar, ap, inventory, grni, tax_*), and **two** `bank` accounts for the 1101/1102 test.
4. Fiscal year + open period (`POST /accounting/fiscal-years`, activate) and base currency (company migrations seed one — verify).
5. Master data: 1 Warehouse (`POST /inventory/warehouses`), 2 Products (`POST /products`), 1 Supplier (`POST /procurement/suppliers`), 1 Customer.
6. Treasury: 2 accounts (`POST /treasury/accounts`), `POST /treasury/accounts/:id/gl-mapping` → one → **1102**, one → **1101** (the call exists server-side; there is no UI for it — use API).
7. Config keys (`accounting.inventory_cogs_account_code`, `…cash_movement_clearing_account_code`): installation-wide (see §2 obs.3) — set only if CTO approves touching the shared config; otherwise record as a known T0 limitation.

### 3.3 Scenarios & assertions
| Id | Scenario | Assert |
|---|---|---|
| T0-1 | Receipt/dispatch/return_in/adjustment/transfer | stock ledger, `inventory_valuation_state`, journals per movement type, 0 negative on-hand |
| T0-2 | PR→RFQ→2 quotations→award (user A) → approve (user B) | RFQ state `sent`→`awarded`, exactly 1 PO, approval request visible; **record the real award request/response** (closes PRC-02 evidence gap) |
| T0-3 | PO→GR→Invoice(same price)→Payment from treasury acct mapped 1102, then from acct mapped 1101 | GRNI/AP/Bank journals; **bank leg account = paying account's mapped GL** (expected FAIL today = PRC-05 baseline) |
| T0-4 | Invoice price ≠ PO price | GRNI residual (PRC-06 baseline) |
| T0-5 | Sales invoice→customer payment→(deposit, COD remit) | ledger, treasury, GL AR/Bank; unmapped-account rejection (TRS-01 baseline) |
| T0-6 | Sales return + shipment return | ledger/GL/inventory effect (SRT-02 baseline = no financial effect) |
| T0-7 | Fixed asset: create → link acquisition JE → depreciation → dispose | TB at each step (FA-01) |
| T0-8 | Event proof (§50): publish `deposit.verified`/`collection.remitted` in Company A | journal appears in A and nowhere else (**expected FAIL pre-D10**) |
| T0-9 | Invariants SQL (per Company) | ΣDr=ΣCr; GL 2101 = supplier-ledger net; GL 1110 = customer-ledger net; GL 1120 = Σ valuation; mapped GL bank = treasury balance; REJECTED/IGNORED financial events = 0 or explained |
| T0-10 | A/B isolation | repeat T0-3 in Company B; nothing leaks to A or to the Platform DB |

### 3.4 Outputs
Pass/fail table per scenario with SQL evidence, the actual award request/response, the event-proof result, and a before/after baseline for D2–D5. Clean-up: Company decommissioned via `POST /installation/companies/:id/decommission` path only (suspend first — READY→DECOMMISSIONED is not allowed by the state machine).

### 3.5 GO checklist (CTO)
- [ ] GO for provisioning a real Company + physical DB
- [ ] T0a now vs hold until D10
- [ ] OK to set (or not) the installation-wide config keys
- [ ] Which user is "user B" (checker) for T0-2
