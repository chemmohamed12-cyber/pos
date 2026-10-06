# D4 — Returns accounting policy (2026-10-05)

**Status: POLICY APPROVED (CTO, 2026-10-05) — recorded before any code. IMPLEMENTED → INTEGRATED → REAL-PG VERIFIED → CLOSED (2026-10-05); see §6–§8.**
Order of work (CTO): Policy → Implementation → Real-PG → Regression (isolated seeded PostgreSQL, never `daii_dev`) → Closure. D5 stays on HOLD until D4 is CLOSED.

## 1. Approved policy (CTO baseline)

**Finding that triggered D4 (audit):** Returns move stock only; they create no financial effect on Customer Ledger / Revenue / AR / COGS / Inventory.

### 1.1 Customer / Sales Return linked to an original sale
- **Inventory:** `Dr Inventory / Cr COGS` at the **original cost of the units that left in the returned sale** — never the selling price, never a freshly guessed average. If the correct accounting cost of the returned quantity cannot be determined ⇒ **FAIL CLOSED** (no partial financial return).
- **Revenue / AR:** `Dr Sales Returns / Revenue Reversal`, `Cr Customer AR`, amount **based on the original value of the returned sale**. If the original sale carried sales tax / Output VAT, the **tax part linked to the returned value is reversed** per the original account.

### 1.2 Customer credit vs cash refund
A return is **not** an automatic cash refund. It creates a **Customer Credit / AR reduction**. If the customer already paid, the balance stays in the customer's favour in the Customer Ledger. An actual **cash refund is a separate financial operation and is not invented inside D4**.

### 1.3 Source transaction integrity
A return keeps/links: original Sales Order, original Sales Order Line, original shipment/delivery transaction (when present), original quantity, previously returned quantity. The existing quantity cap stays enforced; returns can never exceed what actually left.

### 1.4 Shipment Return
Do not assume every Shipment Return is a full financial Sales Return:
- shipment left inventory and **no** Sales Invoice / financial sale exists ⇒ `Dr Inventory / Cr COGS` only, at the actual exit cost;
- shipment is linked to a financial sale already ⇒ **same financial reversal policy as a Sales Return** (AR, Revenue, tax reversal per the original);
- never create a Revenue reversal or AR credit for an operation that never created Revenue/AR.

### 1.5 Critical accounting rule (required flow)
```
Validate source → Resolve cost → Resolve required GL accounts → Validate quantities
→ Transaction → Inventory mutation → Ledger/financial mutation → Event → Commit
```
Any missing configuration / accounting dependency ⇒ **reject before mutation** whenever technically possible. Forbidden: first-available cost, current-average-as-arbitrary-fallback, last purchase cost, guessed account, generic clearing account. Cost not deterministically available ⇒ STOP and report, not invent.

### 1.6 Out of scope
D5 (PPV / Input VAT of purchases). Cash refunds. Legacy `ReturnRequest`/`returns.controller` flow (disclosed in §4). Customer-ledger reverse path (known follow-up).

### 1.7 Required real-Postgres proof (15 points)
1 linked to original order · 2 quantity cap · 3 inventory restored · 4 COGS reversed at correct cost · 5 Revenue/AR reversed · 6 customer credit correct · 7 tax reversal · 8 Shipment Return without invoice → inventory/COGS only · 9 Shipment Return with financial sale → full reversal · 10 invalid/missing source → rejected, zero mutation · 11 missing accounting config → rejected, zero mutation · 12 A→A only · 13 B untouched · 14 Platform/shared DataSource never requested · 15 Dr = Cr.

## 2. Evidence-based findings (read from source, 2026-10-05)

| # | Finding | Consequence for D4 |
|---|---|---|
| F1 | `SalesReturnsService.completeSalesReturn` / `ShipmentReturnsService.completeShipmentReturn` only transition the process and call `recordMovement(... 'return_in' ...)`. Since D3-A that movement publishes an `inventory.movement.recorded` event (`glKind='return_in'`) which the handler **REJECTS** ("pending D4"). No ledger entry, no AR/Revenue/tax event. | This is the gap D4 closes. |
| F2 | A sale's stock leaves at **Delivery outcome 'delivered'**: `fulfillReservationsForOrder` → `recordMovement(dispatch, referenceType='sales_order', referenceId=<salesOrderId>)`, from the custody sub-location. The GL event for that dispatch consumes cost via `consumeIssueCost` (idempotency key = the event's key) and writes an `issue` row in `inventory_valuation_movements` (`valueDeltaBase`, `quantity`). | **Original cost source is deterministic:** the issue rows of the order's dispatch movements for the product. No row (dispatch GL event not posted / rejected) ⇒ cost unknown ⇒ FAIL CLOSED. |
| F3 | The sales invoice is created **per Sales Order** (not per shipment), lines snapshot the order lines (`lineTotal` = net after discount), **tax is invoice-level** (one `taxCodeId`/`taxAmount`, frozen at draft). `totalAmount` is net; gross = net + tax. Posting: `Dr AR (gross) / Cr Revenue (net) / Cr tax payable (tax)`. Invoice states: draft, posted, partially_paid, paid, void. | The original sale's AR/Revenue exists only when the invoice is in `posted / partially_paid / paid`. A `draft`/`void`/absent invoice created no Revenue/AR ⇒ no revenue reversal (policy §1.4). |
| F4 | `InvoiceService` (and `TaxEngine`) read through the **ambient** DataSource. | Returns must NOT call them in a Company context. D4 adds **manager-aware read methods** on the invoice contract and recovers the original tax account from the original `finance.invoice.posted` Financial Event (Company data), never from the ambient tax engine. |
| F5 | `SalesReturnLine.returnPrice` doc comment records an earlier CTO ratification (2026-09-16): "authoritative for any GL credit… `originalUnitPrice` display only". | **Conflicts with §1.1** ("amount based on the original value"). Resolution below (§3.D): the newer explicit D4 policy governs; `returnPrice` stays the document's declared value and is NOT the GL input. **Flagged for the CTO** — overrule if the older rule was meant to survive. |
| F6 | Return completion is a separate warehouse-facing step; the cap is `min(sold, shipped)` shared by both return types via `OrderLineReturnCapacityService`. | Both return types share ONE financial policy service. |
| F7 | If the invoice is posted AFTER a return completed, the draft's line quantities are unchanged (not netted for returned quantity). | Pre-existing gap; recorded as a **follow-up finding**, not fixed in D4. |
| F8 | Legacy `ReturnRequest`/`ReturnsService.recordDisposition` (restock) also emits `return_in` and publishes `return.completed` (ignored). | Out of D4 scope; its `return_in` events keep being REJECTED visibly (no cost) — disclosed §4. |

## 3. Implementation decisions (within the approved policy — not policy changes)

A. **One shared financial policy for both return types** — a `ReturnFinancialsService` (returns domain) computes, per source order: original unit cost per product (via `InventoryValuationContract`/inventory contract on the original dispatch movements), original invoice basis (via a manager-aware `FinanceInvoiceContract.getReturnBasis`), amounts, tax; and runs the **accounting pre-flight** (`InventoryPostingPolicy.assertSaleReturnPostable`, bound by accounting through the existing foundation registry — no module cycle) **before any write**.

B. **Cost:** unit cost = Σ|issue value| ÷ Σ|issue quantity| over the dispatch movements (`referenceType='sales_order'`, `referenceId=order`, product) whose valuation `issue` row exists; **all** such dispatch movements must be costed, else FAIL CLOSED. The return restores valuation at that unit cost (`recordReceiptCost`) so Σ valuation = GL 1120 keeps holding. Posting: `inventory.movement.recorded`, `glKind='return_in'`, cost carried in the payload (same pattern as opening stock / manual receipt): `Dr 1120 Inventory / Cr COGS (configured)`.

C. **Revenue / AR / tax (only when the original invoice is posted/partially_paid/paid):** per order line, cumulative-rounded original net `round2(lineTotal × cumReturnedQty ÷ invoicedQty)` minus what earlier returns already credited; invoice-level tax reversed pro-rata to returned net using the same cumulative rounding so that a full return reverses the invoice tax exactly. Ledger: one `return_credit_note` **credit** entry (gross) per source invoice, linked to the invoice and order (AR reduction / customer credit; no cash). GL: new event `finance.sales_return.credited` → `Dr Sales Returns (configured) net / Dr Output tax (original account) tax / Cr AR gross`; AR and tax accounts resolved exactly as `handleInvoicePosted` resolved them (tax account taken from the original posted invoice event payload).

D. **Amount basis vs `returnPrice`:** GL/ledger amounts come from the **original invoice value** (F5). The document's `returnPrice`/`lineTotal` remain as declared; the credited amounts are stored on the return line (`creditNetBase`, `creditTaxBase`, `unitCostBase`, `costTotalBase`) so any divergence is visible and auditable.

E. **Sales Returns account is configuration:** `accounting.sales_returns_account_code` (default `''` = fail-closed, resolved with `resolveConfiguredPostableAccount`: exists, active, postable, non-control). Not invented, not defaulted; COGS reuses `accounting.inventory_cogs_account_code`. Missing ⇒ the completion is rejected **before mutation** (§1.5).

F. **No restock destination ⇒ reject:** a source order with no warehouse can no longer be silently skipped on a financial return (it cannot restore inventory/cost) — rejected before mutation with a clear message.

G. **Atomicity:** inside one transaction: process transition → `return_in` movement + valuation + event → ledger credit → AR event → return-line financial snapshot → invoice status recompute; the outbox rows commit with it; GL posting follows through the Company outbox (`dispatchAfterCommit`).

## 4. Known limits / follow-ups (disclosed up front)
- F5 supersession (CTO to confirm). F7 invoice-after-return netting. F8 legacy `ReturnRequest` flow.
- A shipment that never reached 'delivered' has no dispatch cost ⇒ its Shipment Return completion is rejected (cost indeterminable ⇒ fail closed, §1.1) — previously it silently added stock that never left the ledger.
- Customer-ledger reverse path remains ambient (existing follow-up, untouched).
- Cash refund is a separate operation (not built).

## 5. Verification plan
New real-PG spec covering the 15 points (A/B, real GL pipeline, real moving-average valuation, real `InventoryPostingPolicyService`); existing `sales-returns` / `shipment-returns` / `inventory` / `customer-ledger` isolation specs re-run (closed-controller blast radius); build, lint; regression on an **isolated seeded PostgreSQL** only.

## 6. Implementation (as built)

| Piece | Where |
|---|---|
| Shared financial policy (plan = read-only validate/cost/amount/accounts; apply = mutate in the SAME tx) | `domains/returns/application/return-financials.service.ts` (`ReturnFinancialsService`) |
| Sales Return / Shipment Return completion now run `plan → transition → apply` in one transaction, then `dispatchAfterCommit` | `sales-returns.service.ts`, `shipment-returns.service.ts` (`completeSalesReturn` / `completeShipmentReturn`) |
| Original cost: Σ issue value ÷ Σ issue qty of the order's dispatches (all must be costed, else fail closed) | `InventoryService.resolveOriginalSaleCost` + `InventoryValuationContract.getIssueCostsByKeys` (`MovingAverageCostEngine`) |
| Stock back at the ORIGINAL cost: valuation restored, event `glKind='return_in'` carries the cost → `Dr Inventory / Cr COGS` | `InventoryService.recordSaleReturnIn`, `InventoryCostingHandlerService` (`return_in` branch; a cost-less `return_in` stays REJECTED) |
| Original invoice value (manager-aware; no ambient DataSource, no tax engine) | `InvoiceService.getReturnBasis` / `FinanceInvoiceContract` / `InvoiceReturnBasis` |
| Revenue/AR/tax: ledger `return_credit_note` credit (gross) + event `returns.sale_return.credited` → `Dr Sales Returns [+ Dr tax] / Cr AR`; AR/tax accounts taken from the ORIGINAL posted-invoice Financial Event | `handleSalesReturnCredited` (`finance-handlers.ts`), `AR_EVENT_TOPICS.salesReturnCredited`, `SUBSCRIBED_TOPICS`, `DOMAIN_OF_TOPIC` |
| Accounting pre-flight BEFORE any write (bound through the existing foundation holder — no module cycle) | `InventoryPostingPolicy.assertSaleReturnPostable` (`InventoryPostingPolicyService`) |
| Config (fail-closed, default `''`) | `accounting.sales_returns_account_code` (accounting manifest 1.17.0); COGS reuses `accounting.inventory_cogs_account_code`; logistics manifest 1.3.0 declares the new event |
| Per-line financial snapshot + header credited gross | migration `logistics/1789900000000-AddReturnFinancialSnapshot` (`unitCostBase`, `costTotalBase`, `creditNetBase`, `creditTaxBase`, `creditInvoiceId`; `creditedGrossBase`) |

Cumulative rounding: per order line `round2(lineTotal × cumQty ÷ invoicedQty) − already credited`; tax per invoice `round2(tax × cumNet ÷ invoiceNet)` differenced — a full return reverses the invoice **exactly** (proved: 40 + 60 net, 5.60 + 8.40 tax of 14.00).

## 7. Verification (real PostgreSQL)

**Spec:** `domains/returns/interface/returns-accounting.company-isolation.spec.ts` — 12 tests, real Company DBs A/B, real outbox → financial events → posting gate → GL, real moving-average valuation, real Customer Ledger/Invoice/Sales/Shipment return services; the original sale is built through real paths (receipt @4.00, dispatches costed at 4.00, then the average deliberately moved to 7.00).

| # | CTO point | Evidence |
|---|---|---|
| 1 | linked to original order | return line keeps `sourceSalesOrderId`/`sourceSalesOrderLineId` (O1) |
| 2 | quantity cap | remaining 6 of 10 returnable, 7 rejected `only 6 remain returnable` (also via Shipment Return — shared cap) |
| 3 | inventory restored | `return_in` +4 stock; valuation +4 @ **4.00** (not the 7.00 average) |
| 4 | COGS reversed at correct cost | `Dr 1120 16.00 / Cr 5101 16.00` (4 × 4.00) |
| 5 | Revenue/AR reversed | `Dr 4102 40.00 + Dr 2120 5.60 / Cr 1110 45.60` from the ORIGINAL invoice value (declared return price 9.00 deliberately different, not used) |
| 6 | customer credit | one `return_credit_note` credit 45.60 on the invoice; balance 214 → 168.40; **no treasury transaction** (no cash refund); an already-PAID invoice → balance −50.00 in the customer's favour |
| 7 | tax reversal | 5.60 then 8.40 = 14.00 exactly; GL 2120 back to 0; an invoice with no tax part posts no tax line |
| 8 | Shipment Return without invoice | inventory/COGS only (`1120 D 8.00 / 5101 C 8.00`), no credited event, no ledger entry |
| 9 | Shipment Return with financial sale | full reversal (`4102 D 50.00 / 1110 C 50.00` + COGS) |
| 10 | invalid/missing source | unknown id → not found; never-dispatched order → "original cost … cannot be determined"; no restock warehouse → rejected — snapshot of stock/valuation/outbox/events/journals/ledger identical before/after, state stays `requested` |
| 11 | missing accounting config | unset Sales Returns / unset COGS / mapped-but-absent account → rejected BEFORE mutation (snapshot identical); restored → the SAME document completes; plus event-time fail-closed (REJECTED naming `accounting.sales_returns_account_code`, re-drivable) |
| 12 | A → A only | everything in A; A's return id through B's manager → not found, B unchanged |
| 13 | B untouched | B: 0 rows in stock, valuation, events, journals, ledger, returns, outbox |
| 14 | Platform/shared DataSource never requested | completion inside `assertDataSourceNeverRequestedFor(B)`; control-plane outbox = 0 |
| 15 | Dr = Cr | no unbalanced journal; Σ valuation delta (−12) = GL 1120 delta (−12); GL AR = invoices − credits |

Existing closed-controller specs re-proved (blast radius): `sales-returns` + `shipment-returns` isolation (their fixtures now seed a costed dispatch and stub the accounting side), `inventory`, `warehouse-transactions`, `inventory-valuation`, `customer-ledger`, `payments`, `inventory-posting` (D3), `manual-receipt` (D3-B), `event-engine`, `general-ledger`, handlers unit spec, module-registry. **Returns suites 28/28; affected batch 79/79 tests** (one suite-level "permission denied to terminate process" teardown flag after its 4 tests passed). **Build** clean; **lint** clean (D4 files); `tsc` clean for `src`.

## 8. Regression record (isolated seeded PostgreSQL — never `daii_dev`)
Environment: the disposable seeded cluster `127.0.0.1:5656` used to close D3 (all 252 migrations incl. D4's). **One full run: 130 suites / 838 tests — 786 passed, 51 failed (8 suites), 1 skipped (opt-in T0).** Wording per CTO: **786/838 first run (+1 skipped); failures classified and individually cleared/isolated below — not "clean".**

| Class | Suites | Disposition |
|---|---|---|
| Contention (60 s `beforeAll` AppModule boot / 5 s hook timeouts under parallel load) + a spec another session was editing | `commission-phase1` (10), `attendance-biometric-import` (15), `area5-company-context-lifecycle` (5), `approval-engine.company-isolation` (8, untracked spec of the Approval Engine work) | Re-run **serially** on the same DB: **38/38 PASS** |
| Environment-guarded by design (refuse to run unless `DB_PORT=5544`, the HR session's instance; "never the shared dev server") — new `*.characterization.spec.ts` of the provisioning/limits work | `provisioning-lifecycle`, `limits-scope`, `ui-created-company-admin`, `module-add-existing-company` | **Not executed by choice** (the CTO forbade using 5544); unrelated to D4. |
| D4-caused | none | — |

## 9. Known limits / follow-ups (disclosed)
1. **`accounting.sales_returns_account_code` must be configured** (a postable, non-control contra-revenue account, e.g. "Sales Returns") before any return of an invoiced sale can complete — fail-closed by design, like D3's accounts. The COGS key `accounting.inventory_cogs_account_code` likewise.
2. **F5 supersession (CTO to confirm):** GL/ledger amounts come from the ORIGINAL invoice value; the earlier 2026-09-16 note that `returnPrice` is authoritative for a GL credit is superseded (the declared price stays on the document; credited parts are stored on the line).
3. **Behaviour changes that follow from fail-closed policy:** a Sales/Shipment Return whose original cost is indeterminable (no costed dispatch — e.g. goods returned from custody before 'delivered') is now **rejected** instead of silently adding stock; a source order without a warehouse is rejected instead of silently skipped.
4. **F7:** an invoice posted AFTER a return completed is not netted for the returned quantity (pre-existing gap — follow-up).
5. **F8:** the legacy `ReturnRequest` restock `return_in` has no cost → its inventory events stay REJECTED (visible, re-drivable) — separate path, not in D4 scope.
6. Customer-ledger reverse path still ambient (existing follow-up). Cash refund not built (separate operation, per policy).
7. The 4 characterization suites above remain un-run here (guarded to 5544).

## Status
**D4 = IMPLEMENTED / INTEGRATED / REAL-PG VERIFIED / CLOSED (2026-10-05).** D5 (PPV + Input VAT) remains on HOLD until the CTO releases it.
