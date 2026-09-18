# ADR-052 — GRNI Policy Impact Analysis (P0.3)

**Status: RESOLVED (2026-09-18) — superseded by `ADR-054-grni-policy-decision-option-b.md`.
CTO ratified Option B (GRNI-on, receipt-based recognition).** This document's
analysis (kept for the record, unchanged below) was produced per the P0
Procurement Financial-Core Resolution directive (2026-09-18), item 3, to
inform that decision. Implementation now proceeds under ADR-054 — read that
document for the ratified policy and its implementation requirements, not
this one.

## 1. What "A" actually is today (verified against source, not assumed)

This is not a gap engineering silently chose — it is the current build's
**existing, already-ratified** behavior, inherited from before Procurement
existed:

- `InventoryService.recordMovement` (`inventory-warehouse/application/inventory.service.ts:209-222`)
  updates the moving-average valuation subledger on every `'receipt'`
  movement, but **only ever publishes a GL-bound `inventory.movement.recorded`
  event for `dispatch`** (`INVENTORY_GL_MOVEMENT_TYPES` is dispatch-only).
  The code comment is explicit: *"a receipt has no accounting entry, only a
  valuation-subledger one"* — citing **ADR-040/ADR-041 (F07/F08 Inventory
  Accounting/Valuation)**, decisions that predate Procurement by several
  weeks.
- `finance.supplier_invoice.posted`'s handler (`accounting/application/
  financial-events/supplier-invoice.handler.ts:4-16`) posts `Dr Inventory /
  Cr AP` in ONE entry at invoice-posting time — its own comment states
  *"No GL entry exists yet for the Goods Receipt itself — same 'receipt
  movements never post to GL' rule F07/F08 already established... this
  handler is where Procurement's purchased value first enters the GL, at
  invoice-recognition time, not receipt time."*

So "A" is not a Procurement-specific shortcut — it is Procurement's Supplier
Invoice handler **conforming to a pre-existing, cross-domain platform rule**.
Verified live this session: PO-2026-000003's full chain (GR → Invoice → AP →
Payment → GL) produced exactly one Dr Inventory/Cr AP entry at invoice time,
nothing at receipt time — matches the code exactly.

"B" (the ratified blueprint's Decision 3, GRNI-on-by-default) would mean:
`Goods Receipt → Dr Inventory / Cr GRNI (suspense liability) → Supplier
Invoice → Dr GRNI / Cr AP` (two entries, a clearing account in between)
instead of A's single combined entry.

**This is the real tension the CTO needs to resolve — not a Procurement
question alone: Option B requires either (a) special-casing Procurement's
receipts to break ADR-040/041's "receipts never post to GL" platform rule,
or (b) re-litigating that platform rule for every domain that calls
`recordMovement('receipt', ...)`, not just Procurement's.**

## 2. Impact by area

### Inventory valuation
No change either way — `InventoryValuationService.recordReceiptCost` runs
identically under A or B; the moving-average cost basis is set at receipt
time regardless of whether a GL entry accompanies it. B does not change
*what* the inventory is worth, only *when the GL agrees with it*.

### AP / GRNI reconciliation
- **A:** No GRNI account exists; nothing to reconcile between receipt and
  invoice. `ApReconciliationService` (F05) compares the AP subledger
  (`SupplierLedgerEntry`) balance against the GL `ap` control account —
  both only ever move at invoice/payment time, so they can never disagree
  because of a pending receipt. Simpler, fewer failure modes.
- **B:** A new GRNI suspense-account reconciliation becomes necessary
  (received-not-invoiced ≈ GRNI balance) — a new reconciliation TYPE the
  Closing Audit Engine (ADR-050) does not currently have a service for
  (`ClosingAuditService` orchestrates AR/AP/CashBank/Inventory/FixedAsset
  today — GRNI would be a sixth).

### Closing Audit (ADR-050)
- **A:** A Goods Receipt with no matching invoice at month-end is
  **structurally invisible** to `ClosingAuditService` — it produced no
  financial event, so there is nothing to flag as open/unmatched. The
  Closing Audit's "unposted/unmatched transaction" detection (per the P0
  directive's own Month-End Closing scope) cannot currently see this
  category of risk at all.
- **B:** Every uninvoiced receipt is a real, visible GRNI balance the
  Closing Audit can — and, per the ratified blueprint's own intent, should
  — check and potentially block a close on.

### Supplier liability
- **A:** Supplier liability, as the GL understands it, does not exist until
  Invoice posting — even though the supplier physically delivered goods and
  (per PO terms) may already be owed money the moment of receipt.
  Understates true liability at any cutoff with an open (received,
  uninvoiced) PO line.
- **B:** Liability recognized at receipt (via GRNI), matching the economic
  reality — goods received obligates payment regardless of invoice
  paperwork timing. More conservative/accurate, standard practice in
  mature ERPs.

### Returns
Procurement has no return-to-supplier flow built yet (out of scope for
these 3 P0 items) — no current interaction either way. If/when a
Purchase Return is built, B would need a symmetric GRNI-reversal leg;
A would not, since there is no GRNI to reverse.

### Partial receipts / partial invoicing
Both are already structurally supported today, independent of A/B —
`PurchaseOrderLine.quantityReceived`/`quantityInvoiced` are tracked
per-line (verified: `purchase-order-line.entity.ts`), and
`SupplierInvoiceService` allows invoicing any subset of a line's received
quantity. Under B, each partial receipt would need its own GRNI leg sized
to that receipt's value, and each partial invoice would clear only the
matching portion — more journal entries, more precise matching, but no new
structural gap either option.

### Uninvoiced receipts at month-end (the core question)
- **A:** Inventory Asset on the balance sheet is **understated** by the
  value of any received-but-uninvoiced goods at cutoff — real goods sitting
  in the warehouse (verified as available stock — recall this session's own
  finding earlier that received quantity goes straight to available stock,
  no quarantine distinction) with zero GL recognition of the corresponding
  liability or, more precisely, zero GL recognition of the inventory asset
  itself either (since the Dr Inventory leg is also deferred to invoice
  time under A — this cuts both ways: A doesn't just omit the liability, it
  omits the ASSET recognition too, until invoiced).
- **B:** Both legs (Dr Inventory at receipt, Cr AP at invoice, GRNI bridging
  the two) are recognized as they occur — the balance sheet is accurate at
  any cutoff, not just at invoice boundaries.

### Reversal / correction
- **A:** A Goods Receipt error today has nothing to reverse in the GL (there
  was nothing posted). Correction is purely inventory-side (a
  counter-movement) — simpler.
- **B:** A Goods Receipt error requires a GL reversal of the GRNI/Inventory
  leg too, using the existing `JournalEntryService` reversal mechanism
  (already proven — Treasury/GL both have reversal support) — more moving
  parts, but no new mechanism needed, just more call sites.

### Financial Event idempotency
No structural difference — B's new `inventory.movement.recorded`-for-receipt
(or a new `goods_receipt.posted` event type) would use the same
`idempotencyKey` pattern every other handler already uses
(`FinancialEventService`'s `UNIQUE(idempotencyKey)` guard, verified this
session). No new idempotency risk, just one more event type to key
correctly.

## 3. What is NOT a valid way to resolve this

Per the CTO directive: this must not be silently resolved by engineering
either direction. Specifically ruled out for this analysis:
- Implementing B piecemeal for Procurement only, leaving F07/F08's other
  `recordMovement('receipt', ...)` callers (Warehouse Receipt transactions,
  opening-stock import) still receipt-silent — would create an
  inconsistent GL (some receipts post, some don't) for no principled reason.
- Implementing A permanently by simply deleting Decision 3 from the ratified
  blueprint without CTO sign-off — Decision 3 was an explicit, named
  ratification (`OP_PROCUREMENT_AP_BLUEPRINT.md` §6, "GRNI enabled by
  default").

## 4. Recommendation shape (not a decision)

Two honest paths exist, both technically clean:
1. **Ratify A as the platform's permanent policy** (formally supersede
   Decision 3 in a new ADR) — smaller closing-audit scope, but a
   documented, accepted understatement risk at cutoff for any open PO.
2. **Ratify B and schedule it** as a scoped follow-up (new GRNI account,
   new financial-event handler mirroring the existing Dr/Cr pattern, GRNI
   reconciliation added to `ClosingAuditService` as a sixth check) — before
   or as part of the Month-End Closing Engine build, since GRNI
   reconciliation is exactly the kind of thing that engine exists to catch.

This document does not recommend which. It exists so the CTO decision is
made with the actual current-state facts in hand, not assumptions.
