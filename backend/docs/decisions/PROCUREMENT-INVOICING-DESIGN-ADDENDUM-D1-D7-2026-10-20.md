# Procurement invoicing - design addendum: D1-D7 adopted, reconciliation with the current DAII model, closure plan A-E

Date: 2026-10-20. Source: CTO directive "PROCUREMENT INVOICING FULL CLOSURE" (D1-D7 adopted as the target policy; phases A-E to be closed in sequence; release/merge/deploy only after the final gate and a separate authorization). Companion to `PROCUREMENT-INVOICING-REDESIGN-PHASE-1-2-2026-10-20.md`. Documentation only - no code or data change in this document.

## 1. What exists today (checked in code, 2026-10-20) vs each decision

| Decision | Current DAII behaviour | Gap to close | Phase |
|---|---|---|---|
| D1 no invoicing beyond received | Hard guard in `createDraftInvoice` (qty <= received - invoiced) + PO must be partially_received/received/closed; phase A adds the same limit per receipt line under a per-order-line lock | Override path (dedicated permission + reason + independent approval + audit); service / non-stock invoices have no separate workflow | C |
| D2 tolerances | Quantity hard-blocked, price variance informational (posted to PPV), no configuration | Company settings (price %, max amount, qty %, charges), both limits must pass, invoice goes ON HOLD instead of posting, permissioned override with reason | C |
| D3 discounts / freight / charges / tax | Only explicit VAT (`taxAmount`); GRNI cleared at receipt cost; PPV for price difference; no discount / freight / other charge fields; no landed-cost engine | New fields, allocation basis stored, capitalisation policy, expense accounts | C (see escalation E1) |
| D4 multi-order invoice | `supplier_invoices.purchaseOrderId NOT NULL`; lines point to PO lines; phase A allocates lines to receipt lines | Header relation derived from lines; `purchaseOrderId` optional once safe; same supplier / Company / currency checks | E |
| D5 lifecycle | `draft -> posted`, `draft -> void`, `posted -> partially_paid / paid / void`; no approval step | `Draft -> Submitted -> Approved -> Posted` plus Rejected / On Hold; maker != approver; checks inside the transition transaction; exactly-once posting kept | C |
| D6 credit notes | Free-text `ap-adjustment.service` (AP adjustment, approval-gated), not linked to an invoice | New document linked to invoice lines, cumulative cap, approval, tax / cost / supplier effects, valid after partial or full payment | D |
| D7 purchase returns | No purchase-return document exists (sales returns only) | New document linked to receipt lines, stock-out exactly once, GRNI or credit-note path, never rewrites the source documents | D |

Foundation already in place and kept: advisory locks per invoice / payment / order line, idempotent financial events (`procurement:<doc>:<id>:<event>`), event outbox + re-drive, per-Company connection on every path, balanced-journal posting gate, process engine with transition locks.

## 2. Reconciliation points and escalations (documented BEFORE the affected behaviour is implemented)

These are the material points the directive does not fully settle. Work on everything independent of them continues; the affected accounting behaviour is NOT implemented until the owner answers.

- **E1 (D3) - discounts and charges that arrive AFTER the receipt under moving-average costing.** A receipt already valued the stock at PO cost. A later invoice discount or capitalisable freight changes the cost of units that may already have been sold or transferred. The directive says "reduce / capitalise", but not what happens to the part that belongs to units no longer on hand. Proposed default (not implemented until confirmed): adjust inventory value for the quantity still on hand (receipt line remaining quantity) and post the share belonging to consumed units to a dedicated "purchase cost variance" account (separate from PPV), with the split shown on the invoice. Needs: confirmation of the rule and of the account.
- **E2 (D1) - draft before receipt.** The directive allows saving an incomplete draft but forbids posting before receipt coverage. Today even the draft is refused unless the PO has a receipt. Proposed: keep the stricter current behaviour for goods invoices (no draft above received) and add the override path only through the exception workflow; revisit only if the owner wants "invoice-first" drafts.
- **E3 (D7) - return cost under moving average.** "Return cost from the goods concerned" vs the moving-average cost at the time of return can differ. Proposed: stock-out at the receipt-line cost (traceable to the receipt), and the difference to the current average posted to the inventory-variance account; needs confirmation.
- **E4 (D4) - nullable `purchaseOrderId`.** Making the header column nullable is additive and reversible only while every row still has it; once multi-order invoices exist, `down` cannot restore NOT NULL. Documented as an irreversible-after-use migration; the old column stays populated with the primary order for compatibility.
- **E5 (D2) - per-supplier / per-item tolerance overrides.** Only implemented at Company level; finer scopes need a separate decision because the settings store does not support scoped keys safely today.

## 3. Execution order (continues automatically while each gate is met)

1. **A + B (done in code, uncommitted on `feature/procurement-invoicing-allocations`)** - migrations, allocation service, multi-invoice payments, UI, 12/12 + migration spec pass, 63 unit suites pass. Gate still open: change report + reconciliation evidence.
2. **C-1 lifecycle and controls (D1 override, D2, D5)** - settings, matching result, On Hold, approval, maker != approver, override permission. No new accounting treatment, so not blocked by E1.
3. **E (D4)** - multi-order invoice with allocations, same-supplier / Company / currency checks.
4. **D-1 purchase return, receipt-only path** (stock-out once, GRNI) - then D-2 credit note linked to invoice lines, then the return-after-invoice / after-payment paths (depend on E3).
5. **C-2 discounts / freight / charges** - starts only after E1 is answered.
6. Integration regression, preview verification on `:5173`, consolidated report, release authorization (separate), merge, post-merge checks, version per the repository policy, deployment workflow.

Rules kept throughout: disposable PostgreSQL only; cluster 5546 only when no other session's jest / biz-run exists, confirmed in a step of its own and with the other session informed; no migration against shared or hosted databases; no rewrite of any posted number, amount, journal, stock movement or balance; inferred allocations stay marked `backfill_fifo`; stop and report on inconsistent history, duplicate-effect risk, isolation failure, or a failing integrity gate.

## 4. Owner decisions on E1 / E3 / approval default (2026-10-20) and how they are implemented

**E1 - discounts and capitalised freight that arrive after receipt (APPROVED as proposed).**
- The share that belongs to units still on hand adjusts the inventory valuation (Dr/Cr Inventory, same transaction as the journal, via the valuation engine's value-only revaluation).
- The share that belongs to units already sold or consumed goes to a SEPARATE account "Purchase Cost Differences After Receipt" (config key `accounting.purchase_cost_difference_after_receipt_account_code`, default empty = fail-closed, account number assigned by the finance owner - none is assumed). The PPV account is never used for this.
- The split is decided at GL posting time by the cost-adjustment handler (`supplier-invoice-cost-adjustment-handler.service.ts`), stored on the event (`decidedSplit`) and shown line by line in the journal descriptions; a void mirrors the recorded split exactly. Assumption (moving average has no lots): units on hand for a line = min(invoiced quantity, current on-hand of the product in that warehouse).
- Expensed freight and other charges use a third, separately assigned account (`accounting.purchase_other_charges_account_code`) - needed by D3's "expense non-capitalisable charges", not named in the decision, flagged for the finance owner.
- The main posted-invoice journal is unchanged (GRNI, PPV, VAT, AP for net + VAT); the cost adjustment is its own idempotent event/journal; AP total = net + VAT - discount + freight + charges = the Supplier Ledger gross.

**E3 - cost of goods returned to the supplier (APPROVED with a correction).** Stock leaves at the actual book cost (moving average) at the return time; the receipt cost and the supplier-invoice cost stay as audit references; any difference between the stock value that leaves and the value approved on the supplier return / credit note goes to a separate "Supplier Return Cost Differences" account (`accounting.purchase_return_cost_difference_account_code`, default empty = fail-closed). The inventory-differences account is NOT used automatically and stock-count differences are never mixed in. The return document shows exit cost, matching value, difference and account. (Implementation: phase D, not started.)

**Approval workflow default (APPROVED).** Existing Companies stay OFF (no policy row = legacy). A NEW Company starts ON: Company provisioning calls `seedCompanyProcurementDefaults` once (insert only, `ON CONFLICT DO NOTHING`), which never overwrites an administrator's choice and never touches documents in flight. The switch is per Company and changed only with `procurement.invoice_policy.manage`. Verified by spec C1-9 / C1-10; the end-to-end provisioning characterization specs need the isolated instance on port 5544 which is not authorised here, so the provisioning stage itself is covered by the unit spec (mocked) and by calling the seeding function on a real Company database.

**Shared-database rule.** Updating the `:5173` preview needs `daii_dev` to be migrated; that is NOT done until the owner issues an explicit authorization naming the database, the change scope and the rollback plan. A migration plan and its review are prepared in the final report.
