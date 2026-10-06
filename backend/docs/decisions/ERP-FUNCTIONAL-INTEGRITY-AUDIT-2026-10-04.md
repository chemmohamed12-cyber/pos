# ERP Operational & Accounting Integrity Audit — P0 prerequisite for UAT (2026-10-04)

**Mode: read-only.** No code, schema, config or data was changed. Evidence = source reads + read-only SQL against the dev DB (`daii_dev`, legacy/default database).
**Not done (disclosed):** no mutation was executed (e.g. the RFQ award was NOT re-fired), no UI screenshots were captured, no clean-company end-to-end chain was run. Findings that need those are marked OPEN, not guessed.

## 0. Evidence-quality warning (read first)

The dev DB is heavily contaminated by test harness data: 5,294 warehouses, 5,291 products, ~250 `E2EACC-*`/`PACC-*` treasury accounts, 682 `finance.invoice.posted` events for 2 real `sales_invoices`, 84,025 treasury transactions. **Code-level conclusions are authoritative; DB numbers are indicative only.** Any numeric reconciliation must be re-run on a clean company (§6 Test Plan, T0).

## 1. As-is accounting policy (extracted from handlers, not invented)

| Business event | Topic / publisher | Posting (as implemented) | Account resolution |
|---|---|---|---|
| Goods receipt | `procurement.goods_receipt.posted` | Dr Inventory / Cr GRNI at PO cost | control fn `inventory`, `grni` |
| Supplier invoice posted/void | `finance.supplier_invoice.posted/voided` | Dr GRNI / Cr AP at **invoice total** | `grni`, `ap` |
| Supplier payment | `finance.supplier_payment.recorded` | Dr AP / Cr Bank | `ap`; bank = hint else **control fn `bank` (first match, no ORDER BY)** |
| Sales invoice | `finance.invoice.posted` | Dr AR / Cr Revenue 4101 (+Cr Tax payable) | `ar`, 4101, `tax_payable` |
| Customer payment | `finance.payment.recorded` | Dr Bank / Cr AR | bank = control fn (same as above) |
| Deposit verified | `deposit.verified` | Dr [treasury acct GL] / Cr AR | **strict**: rejects if treasury acct unmapped |
| COD collection remitted | `collection.remitted` | same as deposit | **strict** |
| Direct treasury cash in/out | `treasury.cash.recorded` | Dr/Cr Bank vs clearing acct | emitted **only if** treasury acct has `glAccountCode`; clearing acct from config |
| Stock dispatch (sale) | `inventory.movement.recorded` | Dr COGS / Cr Inventory | allow-list = `{dispatch}` only; COGS acct from config `accounting.inventory_cogs_account_code` |
| Sales return / Shipment return completion | none (`return.completed` has **no handler**) | **no GL, no ledger** | — |
| Fixed asset | register create posts nothing | acquisition = separate POSTED manual JE linked via `link-acquisition`; depreciation + disposal event-driven | per ADR-045 |

All GL posting is event-driven (Event Engine → `FinancialEventService`). Journal balance gate is enforced centrally.

## 2. Root Cause Matrix

Legend — Class: BUG · MISSING CAPABILITY (MC) · BUSINESS RULE GAP (BR) · ACCOUNTING INTEGRATION GAP (AIG) · ARCHITECTURAL GAP (AG) · VERIFIED WORKING (VW) · BLOCKED. Status: OPEN / BLOCKED / READY.

| ID | Domain | Finding | Root cause (evidence) | Class | Sev | Arch impact | Status |
|---|---|---|---|---|---|---|---|
| INV-01 | Inventory | Warehouse screen lists all items; no Item↔Warehouse link | No assignment model: `products` (id,sku,name,unitPrice,status,unit) and `warehouses` (id,code,name,location,responsibleUserId,status,parentWarehouseId,kind) have no relation table. Stock = `SUM(stock_movements)`. Grid is **backend** (`getWarehouseInventoryPage`, `GET /inventory/warehouses/:id/inventory`) and is a deliberate `LEFT JOIN products` ("never silently missing" — CTO decision recorded in the method doc). Not a frontend filter. | MC / AG (decision D1) | P1 | Yes | BLOCKED on D1 |
| INV-02 | Inventory | Stock source of truth | on-hand = Σ`stock_movements`; reserved = Σ active+preliminary `stock_reservations`; available = on-hand − reserved. DB: 0 (warehouse,product) pairs with negative on-hand. | VW | — | — | closed |
| INV-03 | Inventory | Warehouse "Account Code" | No GL/account column on `warehouses`; `Warehouses.tsx` form = code/name/location/responsible only; inventory GL uses ONE `inventory` control account (1120). The "Account Code" label could not be located → **need the operator's screenshot**. If per-warehouse GL is wanted it is new capability. | MC / AG (D3) | P2 | Yes | **VERIFIED / CLOSED (2026-10-06, CTO: operator screenshot confirmed; no code change, model stays Central Inventory Control 1120 — see ERP-AUDIT-CLOSURE-REPORT-2026-10-06.md)** |
| INV-04 | Inventory↔GL | Inventory sub-ledger ≠ GL | Only `dispatch` publishes GL (`INVENTORY_GL_MOVEMENT_TYPES`, ADR-040 D2). Manual/opening `receipt`, `adjustment`, `transfer`, `return_in` raise stock with **no GL**. DB (indicative): `inventory_valuation_state` Σ=861,938.88 vs GL 1120 = −30,580.26; `inventory.movement.recorded`: 22 REJECTED (18 `negative_on_hand`, 4 `no_valuation_source`) vs 2 POSTED. | AIG | **P0** | Yes (policy D3) | BLOCKED on D3 |
| PRC-01 | Procurement | No stock visibility in PR/RFQ/PO | Zero stock lookups in procurement backend or in `PurchaseRequests/Rfqs/PurchaseOrders.tsx` (only `/inventory/warehouses`). Official source already exists: `GET /inventory/stock?warehouseId&productId` → `{onHand,reserved,available}`. **On Order: no code anywhere.** | INTEGRATION GAP (on-hand/reserved/available) + MC (on-order) | P1 | No (reuse) / Yes (on-order) | READY (part 1) |
| PRC-02 | Procurement | "Award doesn't respond" | `POST /procurement/rfqs/:id/award` → `awardToSupplier` **submits a maker-checker approval** (`procurement.rfq_award`), returns `{approvalRequestId}`; RFQ stays `sent` until a *different* user holding node `procurement.rfq_award` (editable) approves; only then PO is auto-created. `Rfqs.tsx` discards the response, shows no "submitted" state, has no approvals panel / reference to `rfq_award` (grep = 0). No matrix rule for the type → defaults (1 approver, node = type code). Maker≠checker enforced → a single-admin operator can never complete it. Dev DB shows 1 award request already decided → mechanism works end-to-end. **Live response not reproduced (no mutation done).** | BR (by design) + INTEGRATION GAP (visibility) | **P0 (critical flow)** | No | OPEN — confirm with operator repro |
| PRC-03 | Procurement | PR for a new item | `purchase_request_lines.productId` uuid NOT NULL; picker is `/products/all`. Item Master is mandatory by design; no non-stock/new-item request. | BR (D7) | P2 | Yes | BLOCKED on D7 |
| PRC-04 | Procurement | Receipt→Invoice→Payment chain | Receipt raises stock (`receipt` movement) + GR event; invoice 3-way match (qty hard guard, duplicate-ref guard, price variance informational); payment writes treasury cash_out + supplier ledger debit + event. DB: GL 2101 = −8,050.00 **equals** supplier-ledger net AP 8,050.00. | VW | — | — | closed |
| PRC-05 | Procurement/Treasury | Payment's GL bank leg ignores the paying treasury account | Event payload carries `treasuryAccountId` only (no account code); handler uses control fn `bank` via `findOne` with **no ORDER BY**; chart has TWO `bank` accounts (1101 Cash, 1102 Bank). DB: SPAY-1..4 paid from `MAIN-CASH` (glAccountCode NULL) and SPAY-5 from `M0001` (→1101) were **all credited to 1101**. Same for customer payment (Dr bank). | AIG | **P0** | Yes (D2) | BLOCKED on D2 |
| PRC-06 | Procurement | GRNI price variance & input VAT | Invoice clears GRNI at `invoice.totalAmount` but GR credited at PO cost → residual stays in GRNI; `priceVarianceAmount` stored, no PPV account/handler. Supplier invoice has no tax fields; `1140 Input VAT` (`tax_receivable`) unused by the handler. DB (indicative): GRNI 2115 = −2,965.00. | AIG / BR (D5) | P1 | Yes | BLOCKED on D5 |
| SUP-01 | Supplier | Form omits real fields | Create DTO supports tradingName, tax/VAT/commercial reg, creditLimitBase; `Suppliers.tsx` sends only code, legalName, supplierType, paymentTermsDays. Phone/address live in child tables (contacts/addresses) added after create. | INTEGRATION GAP | P1 | No | READY |
| SUP-02 | Supplier | No edit of master data | `SupplierService` has create/setStatus/addContact/addAddress/addBankAccount only — **no update**. | MC | P1 | No | READY (new endpoint; needs audit trail) |
| SUP-03 | Supplier | Code is manual | `code` required & user-keyed; no numbering (other docs use NumberingService). | BR (D9) | P2 | No | BLOCKED on D9 |
| SUP-04 | Supplier | Supplier ↔ Supplier Account | No per-supplier GL account. Model = AP **sub-ledger** (`supplier_ledger_entries`) under the single `ap` control account; reconciles (PRC-04). Introducing per-supplier accounts after history exists needs accounting review. | AG / VW as-designed | — | Yes | no action unless D9 |
| COA-01 | Accounting | Chart of Accounts create/associate | Backend supports create / update (name, nameAr, description, isContra, currency, allowManualJournal, isActive) / reparent / control-function / dimension rules / template import. UI exposes create, active toggle, control-function, reparent, import, dimension rules; **no UI to edit name/nameAr/description/isContra/currency**. `code`/`accountType` are immutable by design. Master creation writes no journal (correct). The operator's exact failure text is unknown. | INTEGRATION GAP (partial) | P2 | No | OPEN (needs repro) |
| TRS-01 | Treasury | Treasury↔GL mapping unusable from UI | Endpoint `POST /treasury/accounts/:id/gl-mapping` exists; **zero frontend usage**. 1 of ~250 treasury accounts mapped. Effects: `deposit.verified` ×2 and `collection.remitted` ×1 REJECTED ("treasury account is not GL-mapped") while customer ledger was credited (deposit credits 6,297 in ledger, none in GL); `treasury.cash.recorded` ×1 REJECTED (clearing acct config unset); direct cash-in/out on unmapped accounts emit **nothing** (silent). GL 1101 = −2,000 vs treasury cash_in≫cash_out sub-ledger. | AIG | **P0** | Yes (D2) | BLOCKED on D2 |
| TRS-02 | Treasury/AR | Inconsistent bank-resolution policy | Payment paths fall back to control `bank` (never reject); deposit/collection paths are strict (reject). Two policies for the same cash event class. | AG | **P0** | Yes (D2) | BLOCKED on D2 |
| CUS-01 | Treasury/AR | Customer payment cycle | Payment row + customer-ledger credit + treasury cash_in + `finance.payment.recorded` POSTED (1/1). Requires `invoiceId` (no on-account/advance payment). Bank-account caveat = PRC-05/TRS-01. | VW (with caveat) | — | — | closed* |
| SRT-01 | Sales | Return knows the original Sales Order | Lines carry mandatory `sourceSalesOrderId`/`sourceSalesOrderLineId`; cap enforced across Sales+Shipment return types ("shipped/sold/returned via each type"); UI has "specific order" scope + order-number column. Header `salesOrderId` is nullable (1 of 1 row null). | VW | — | — | closed |
| SRT-02 | Sales | Return has no financial effect | `completeSalesReturn` only records `return_in` stock movement; no customer-ledger credit, no credit note, no revenue/AR reversal, no COGS/inventory reversal (`return_in` ∉ GL allow-list; `return.completed` not published here and IGNORED by Financial Core: "no handler registered"). Same for `ShipmentReturnsService`. | AIG | **P0** | Yes (D4) | BLOCKED on D4 |
| SHR-01 | Sales | Shipment Return form shows no customer | Backend list/detail already return `customerName` (list column shown). The create-form shipment picker label = RSH/waybill + SO number only; `/shipments` rows carry `customerName` but the label ignores it. | BUG (UI) | P2 | No | READY (label only) |
| FA-01 | Fixed assets | Asset coded → nothing in Trial Balance | By design (ADR-045 D7): register create posts nothing, asset = `pending_acquisition`; acquisition needs a separately POSTED JE (debit on cost account == cost) then `POST fixed-assets/:id/link-acquisition`. **UI has no link-acquisition action and no JE reference input** → asset can never reach `active` from UI; no capitalization helper exists. Master creation without TB effect is correct. | INTEGRATION GAP + MC (capitalization) / AG (D8) | P1 | Yes | BLOCKED on D8 |
| FA-02 | Fixed assets | Rejected depreciation/disposal events | 5 depreciation REJECTED (`Currency "F14" not found` — test artifact), 2 disposals REJECTED (gain-on-disposal account config unset). | BLOCKED (config) | P2 | No | OPEN |
| ACC-01 | Accounting | Double-entry balance | Σdebit = Σcredit = 453,198,879.36 over 5,261 journal entries. | VW | — | — | closed |
| ACC-02 | Accounting | AR sub-ledger vs GL | Customer-ledger net −6,297.00 vs GL 1110 +1,814,300.00 — **inconclusive** (synthetic invoice events, §0). | — | — | — | OPEN → clean-run T0 |
| ACC-03 | Accounting | Event Engine has no Company context | Area 21 §50 (CRITICAL): handlers receive `row.payload` only → event-driven GL posting is not Company-correct under Model B. **Every AIG fix above is only valid for the default DB until the ADR lands.** | AG | **P0** | Yes (D10) | BLOCKED (escalated) |

## 3. Decisions required from CTO (nothing below was assumed)

| # | Decision | Unblocks |
|---|---|---|
| D1 | Item↔Warehouse: keep ledger-derived stock + add a server-side "has stock/movements in this warehouse" filter (no schema change), OR introduce a master-data assignment | INV-01 |
| D2 | Bank-leg policy: payment posts to the **paying treasury account's mapped GL** (reject when unmapped, like deposits) vs control-fn fallback; plus UI for GL-mapping and whether mapping becomes mandatory at account creation | PRC-05, TRS-01, TRS-02, CUS-01 caveat |
| D3 | Which movement types post to GL (manual receipt, opening stock, adjustment, transfer, return_in); per-warehouse inventory account yes/no | INV-04, INV-03 |
| D4 | Returns financial policy (credit note / AR + revenue reversal / COGS + inventory reversal / refund) | SRT-02 |
| D5 | GRNI price-variance account (PPV) and supplier-invoice input-VAT treatment | PRC-06 |
| D6 | RFQ award staffing: approval-matrix rule for `procurement.rfq_award`, who is the checker, and required "pending approval" visibility | PRC-02 |
| D7 | Purchase Request for an item not in Item Master (non-stock / item-request) | PRC-03 |
| D8 | Fixed-asset capitalization: auto-post acquisition JE vs manual JE + link (UI) | FA-01 |
| D9 | Supplier master: edit capability, auto-numbered code, per-supplier account | SUP-02/03/04 |
| D10 | Event Engine per-Company dispatcher ADR (Area 21 §50) | ACC-03 → all AIG |

## 4. Remediation Backlog (ordered per directive §17; each item follows VERIFY→ROOT CAUSE→SCOPE→IMPLEMENT→TEST→REAL-DB VERIFY→REGRESSION→DOCUMENT→CLOSE, one at a time)

1. **P0 Accounting Integrity** — ACC-03 (D10, gating) → PRC-05/TRS-01/TRS-02 (D2) → INV-04 (D3) → PRC-06 (D5)
2. **P0 Inventory Integrity** — INV-04 sub-items: root-cause the 18 `negative_on_hand` + 4 `no_valuation_source` rejections (is it test data or a real ordering gap between stock movement and valuation?)
3. **P0 Procurement Critical Flow** — PRC-02 (D6; at minimum "award submitted / pending approval" visibility, no rule change)
4. **P0 Sales Return Integrity** — SRT-02 (D4), then SHR-01 financial leg
5. **P0 Treasury / Customer Payment** — TRS-01 UI + mapping (D2), CUS-01 on-account payment (BR note)
6. **P1 UX / Traceability** — PRC-01 (on-hand/reserved/available from existing endpoint), SUP-01, SUP-02, FA-01 (D8), INV-01 (D1), COA-01
7. **P2** — SHR-01 label, PRC-03 (D7), SUP-03/SUP-04 (D9), INV-03, FA-02

## 5. Dependency / Blast-Radius Map (Area 21)

Source: `AREA21-RETROFIT-MATRIX.md` §51 (last entry 2026-09-28): **26/43 CLOSED**. ⚠ The directive says "15/43"; §51 itself records that earlier "14/15 of 43" baselines were off, but 15 vs 26 is not a +1 error — **the CTO's figure looks stale; please confirm which is current.**

| Finding | Controllers/services touched | Area 21 state | Consequence |
|---|---|---|---|
| INV-01/03/04 | `inventory`, `inventory-valuation`, `warehouse-transactions`, accounting handlers | CLOSED | re-run their real-PG two-Company specs after any change |
| PRC-01/04/05/06, PRC-03 | `purchase-request`, `purchase-order`, `goods-receipt`, `supplier-invoice`, `supplier-payment`, `grni` | CLOSED | same |
| PRC-02 | `rfq`, `ApprovalEngineService` | **OPEN (Approval-Engine-blocked)** | any change must wait for the Approval Engine scoping decision |
| SUP-01/02/03/04 | `supplier` | **OPEN (Approval-Engine-blocked)** | same |
| FA-01 | `fixed-asset` | **OPEN (blocked)** | same |
| COA-01 | `accounting` (chart routes), `general-ledger` | **OPEN** | same |
| CUS-01, TRS-01/02 | `payments`, `treasury`, `deposits` | CLOSED | regression required; `invoices` (OPEN, TaxEngine) adjacent |
| SRT-02/SHR-01 | `sales-returns`, `shipment-returns` | CLOSED; `returns` OPEN | financial fix must not touch `returns` until its blocker clears |
| ACC-03 | Event Engine + `FinancialEventService` + every handler | **CRITICAL ESCALATION open (§50)** | all AIG remediations are default-DB-only until D10 |

No closed controller was modified by this audit. Any remediation touching a CLOSED controller follows the standing rule: no silent edit — state the blast radius, re-run the affected real-PG spec.

## 6. Test Plan

- **T0 — Clean-company baseline (prerequisite).** Provision a fresh Company (real PG), seed minimal chart, 1 warehouse, 2 products, 1 supplier, 2 treasury accounts (one GL-mapped to 1102, one to 1101). Re-run every reconciliation below there — the dev DB cannot be used (§0).
- **T1 Inventory:** receipt/dispatch/return_in/adjustment → assert stock ledger, valuation state, GL 1120 per D3 policy; assert 0 negative on-hand.
- **T2 Procurement chain:** PR→RFQ→2 quotations→award (two distinct users)→PO→GR→SI→SP: assert RFQ state, PO created once (idempotent), GRNI/AP/Bank per policy, supplier ledger = GL 2101, treasury txn = GL bank per D2.
- **T3 Price variance:** invoice price ≠ PO price → assert GRNI residual per D5.
- **T4 Customer cycle:** invoice→payment (mapped & unmapped treasury acct)→ledger, treasury, GL AR/Bank, Trial Balance.
- **T5 Returns:** sales return + shipment return → inventory, ledger, GL per D4; cap enforcement across both types.
- **T6 Fixed assets:** create (pending) → link acquisition JE → depreciation → disposal → TB at each step.
- **T7 Invariants (SQL, per company):** ΣDr=ΣCr; GL 2101 = supplier-ledger net; GL 1110 = customer-ledger net; GL 1120 = valuation Σ; GL bank accounts = treasury balances of mapped accounts; FinancialEvents REJECTED/IGNORED count = 0 or explained.
- **T8 Isolation:** every remediation re-runs the affected controller's two-Company spec (Area 21 working method).
- **PRC-02 repro:** with 2 users, capture the actual award request/response, approval request row, and Approvals-queue visibility before any change.

## 7. Open evidence requests (cannot be closed by code reading)

1. Operator screenshot/steps for the warehouse **"Account Code"** field (INV-03).
2. Exact error/behavior when creating/associating a GL account (COA-01).
3. Exact award repro and who the approver was (PRC-02).
