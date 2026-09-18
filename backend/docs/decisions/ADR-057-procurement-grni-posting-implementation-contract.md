# ADR-057 — Procurement GRNI Posting: Implementation Contract

**Status:** Approved baseline for implementation (Phase 0). Derived strictly
from `ADR-054` (ratified policy), `ADR-052` (verified current-state analysis),
`ADR-056` (Month-End's GRNI reconciliation side, already implemented), and
direct audit of the existing Procurement/Financial-Event source (not
assumed). Freezes the 12 items the CTO's directive required before coding.
Production remains HOLD throughout.

## 0. Audit findings this contract is built on (verified against source)

- `GoodsReceiptService.post` today calls `InventoryService.recordMovement`
  only — **publishes no financial event at all**. `finance.supplier_invoice
  .posted`'s existing handler (`supplier-invoice.handler.ts`) posts a single
  `Dr Inventory / Cr AP` entry at invoice time, for the invoice's whole
  `netAmount`.
- `PurchaseOrderLine.quantityReceived`/`.quantityInvoiced` are already
  maintained per-line, already enforce the 3-way-match quantity guard
  (`GoodsReceiptService.post`, `SupplierInvoiceService.createDraftInvoice`),
  and are the join key across every `GoodsReceiptLine` and
  `SupplierInvoiceLine` for that line — this is the existing traceability
  spine GRNI reuses, not a new mechanism.
- `EventBusService.publish(manager, topic, payload)` inside the SAME
  transaction as the domain write, with a deterministic `idempotencyKey`
  (`procurement:<doc>:<id>:<verb>`), is the established, exclusive publish
  pattern (`SupplierInvoiceService.postInvoice`) — GRNI reuses it verbatim.
- Checked, not assumed: **zero currently-open (received, not-yet-invoiced)
  `purchase_order_lines` rows exist in this dev database** (§6 below —
  directly relevant to the transition/backfill question, item 6).
- `GrniReconciliationService`/`GRNI_LEDGER_CONTRACT`/`controlFunction: 'grni'`
  already exist and are already regression-tested (ADR-056, Month-End
  Phase 8) — this phase binds the contract that Phase 8 left `@Optional()`
  and unbound; it does not rebuild anything Phase 8 already shipped.

## 1. Goods Receipt → GRNI financial event behavior

**One Financial Event per posted `GoodsReceipt`** (not per line) — new topic
`procurement.goods_receipt.posted`, published inside
`GoodsReceiptService.post`'s existing transaction, immediately after each
line's `InventoryService.recordMovement` call. Amount = Σ over the GR's own
lines of `quantityReceived × unitCostBase` (the same figures already
persisted on each `GoodsReceiptLine`, no new arithmetic). Handler produces:

```
Dr Inventory (control function `inventory` — the SAME account `handleSupplierInvoicePosted` already resolves)
Cr GRNI      (control function `grni`, NEW)
```

Mirrors `finance.supplier_invoice.posted`'s shape exactly — one event per
document, not per line — for consistency with every other handler in this
codebase.

## 2. Required debit/credit accounts and account-resolution rules

- **Receipt:** `Dr inventory` / `Cr grni`, both resolved via
  `ctx.resolveControlAccount('inventory' | 'grni')` — the SAME
  control-function mechanism `handleSupplierInvoicePosted` already uses for
  `inventory`/`ap`, **not** `resolveConfiguredPostableAccount`. This is a
  disclosed, deliberate reading of `ADR-054`'s "no hard-coded fallback"
  requirement: GRNI is structurally a control account managed by a
  subledger-equivalent reconciliation (`GrniReconciliationService`,
  `controlFunction: 'grni'`, already shipped in Phase 8) — identical in kind
  to `ap`/`ar`/`inventory`, none of which use
  `resolveConfiguredPostableAccount` (that mechanism is reserved for a
  *non-control*, plain postable account referenced by a config key, per its
  own doc comment: "the resolved account must... carry **no**
  `controlFunction`"). Using it for GRNI would let an administrator point
  the posting handler and `GrniReconciliationService` at two *different*
  accounts, permanently desyncing them by construction. No hard-coded
  fallback either way — an admin still configures the `grni` account through
  the ordinary chart-of-accounts screen, exactly like `ap`.
- **Invoice:** `Dr grni` / `Cr ap`, same `resolveControlAccount` mechanism,
  replacing the current `Dr inventory` / `Cr ap`.
- **Payment:** unchanged (`Dr ap` / `Cr bank`, existing handler untouched).

## 3. Idempotency key and duplicate-posting protection

`procurement:goods_receipt:<goodsReceiptId>:posted` — same
`UNIQUE(idempotencyKey)` guard on `accounting_financial_events` every other
handler already relies on (F03/ADR-035 D6). One `GoodsReceipt` → one event →
one journal, by construction (mirrors the already-verified 20-posted-
events-to-20-distinct-journals invariant from this session's own Month-End
verification).

## 4. Reversal/correction behavior

No purchase-return flow exists yet (`ADR-052 §2`, confirmed) — nothing to
build for it now, per `ADR-054` item 6's own explicit deferral. What IS in
scope: if a `GoodsReceipt` itself needs correcting (a data-entry mistake,
not a supplier return), the existing `JournalEntryService` reversal
mechanism (already proven for Treasury/GL) is the correction path — no new
mechanism. **Not built in this phase**: there is currently no
"void/reverse a Goods Receipt" operation anywhere in `GoodsReceiptService`
at all (verified — only `post`/`listForPurchaseOrder` exist), so there is no
existing call site to wire a reversal into. Building one would be a new
Procurement capability outside this ADR's scope (posting the *existing*
receipt flow, not adding a new one) — flagged here as a known gap, not
silently built or silently ignored.

## 5. Relationship between GRNI, Supplier Invoice/AP, and 3-way matching

Unchanged mechanically — the existing quantity-variance guard
(`receivedNotYetInvoiced = quantityReceived − quantityInvoiced`) already
*is* the GRNI-exposure guard: it already guarantees an invoice can never
clear more GRNI than was ever credited to it by a receipt. No new guard
code needed; the existing one already enforces GRNI's own invariant as a
side effect of enforcing the 3-way match.

## 6. Partial receipts and partial invoicing

Already structurally supported (`ADR-052`, confirmed): each `GoodsReceipt`
posts its own `Dr Inventory / Cr GRNI` sized to exactly that receipt's
lines; each `SupplierInvoice` posts its own `Dr GRNI / Cr AP` sized to
exactly that invoice's lines. Matching granularity is at the
**`PurchaseOrderLine`**, not a specific receipt-to-invoice pairing —
`SupplierInvoiceLine` has never captured which specific `GoodsReceiptLine`
it clears (verified: no such column exists), only which PO line. This
mirrors how AP/AR are already pooled by party, not itemized per-document at
the GL-journal-line level, in this exact codebase — full document-level
traceability (which receipts, which invoices, for one PO line) remains
available via the shared `purchaseOrderLineId` join, satisfying `ADR-054`
item 4's traceability requirement without inventing a new FIFO/allocation
mechanism `ADR-054`'s text does not itself specify. Building exact
receipt-to-invoice allocation would be *inventing* accounting/matching
policy beyond what was ratified — explicitly not done here.

**Transition/backfill (the concern `ADR-054`'s Consequences section flagged
as needing an explicit answer):** checked, not assumed — **zero** PO lines
in this database currently have `quantityReceived > quantityInvoiced`, so
there is nothing to backfill today. For the general case (a real
installation with open exposure at the moment this ships): no historical
Option-A journal entry is ever retroactively modified (this codebase never
edits a posted financial record). A PO line whose receipt happened under
Option A and is invoiced after this ships will post `Dr GRNI` with no
matching prior `Cr GRNI` for that specific receipt — a bounded, one-time,
self-documenting transition artifact limited to exactly that finite
population of in-flight lines, visible to `GrniReconciliationService` once
its contract binds (§10) rather than silently hidden. No migration is
authored for zero rows; if a future installation needs one, that is a
data-specific operational action at upgrade time, not application code.

## 7. Multi-receipt / multi-invoice scenarios

Follows directly from §6 — any number of partial receipts and partial
invoices against the same PO line compose correctly because each one posts
its own correctly-sized leg; the running `quantityReceived`/
`quantityInvoiced` counters (already atomic, already guarded) are what
keeps them consistent. No new state needed.

## 8. Posting status and failure/retry semantics

Identical to every other Financial Event in this codebase — `RECEIVED →
POSTED | REJECTED`, fail-closed (a missing `inventory`/`grni`/`ap` control
account rejects with a named reason, never silently invents one), visible
and explicitly redrivable via the existing `POST /accounting/
financial-events/:id/redrive` endpoint. No new status model.

## 9. Interaction with Financial Events and Accounting Posting

New topic `procurement.goods_receipt.posted` added to
`SUBSCRIBED_TOPICS`/`V1_FINANCE_HANDLERS`, registered in
`FinancialEventHandlerRegistry` exactly like every existing handler.
`finance.supplier_invoice.posted`'s existing handler function is *modified
in place* (`Dr inventory` → `Dr grni`) — same event, same idempotency key
convention, same registration; not a new topic for the invoice side.

## 10. Interaction with the existing `GrniReconciliationService`

No change to that service's own code (Phase 8, already shipped and
regression-tested). This phase's only effect on it is providing a real
`GrniLedgerContract` implementation and binding it via `useExisting` in
`ProcurementModule` (the exact `SUPPLIER_LEDGER_CONTRACT`/ADR-048 pattern).
`getAllGrniBalances(asOfDate)` — **`asOfDate` is accepted for interface
shape compatibility but not used for historical reconstruction**, the exact,
already-accepted convention `MovingAverageCostEngine.getValuedOnHandTotal`
established (ADR-041 D23) for the identical reason (no historical
reconstruction of a running quantity/cost state in V1) — computed as
`Σ (quantityReceived − quantityInvoiced) × unitCostBase` over every
`PurchaseOrderLine` with a positive balance, each balance entry naming
every `GoodsReceipt` that contributed to that PO line (for traceability),
not a single exact receipt. Once bound, `GrniReconciliationService`
transitions from `no_subledger_source` to `matched`/`drift_found`
automatically — no code change to that service required.

## 11. Closing Audit behavior after GRNI becomes an active posting source

No code change to `ClosingAuditService` — it already calls
`GrniReconciliationService.reconcile()` unconditionally (Phase 8) and
already classifies the result via the existing, unmodified
`classifyReconciliationStatus` policy (`LIVE_DISCREPANCY`/blocking on
`drift_found`, `DORMANT_SOURCE`/informational on
`no_subledger_source`/`matched` handled as "no exception"). The moment
`GRNI_LEDGER_CONTRACT` binds, real GRNI drift becomes a real, visible,
potentially period-closing-blocking `ClosingException` — exactly `ADR-054`
item 7's requirement, already fully wired, verified here by re-running
Month-End's own Phase 8 tests unchanged (§ Acceptance Matrix).

## 12. Permissions, audit trail, and segregation of duties

No new permission node. Goods Receipt posting is already gated by
Procurement's existing permission (`procurement.goods_receipt.*`,
ADR-048); Supplier Invoice posting is already gated by its own existing
node. The GRNI/Inventory GL legs are **`systemPosting`** — non-discretionary,
automatic consequences of an already-authorized operational action, exactly
like the existing single combined entry is today — no new approval step
(this mirrors every other domain's "the GL entry is a consequence of the
already-approved business action, not itself separately approved" rule; no
`ADR-054` text asks for one). Full audit trail: unchanged — every Financial
Event, journal entry, and the existing `goods_receipt.posted`/
`supplier_invoice.posted` audit records already capture this; no new audit
action type is required beyond what `AuditService.record` already logs for
each existing domain action.

## Items requiring no escalation (resolved from existing precedent, disclosed above)

Per the CTO directive's own instruction ("stop only where existing ratified
documents do not resolve a point"): every one of the 12 items above was
resolved from `ADR-054`/`ADR-052`/`ADR-056` plus direct source verification.
**No accounting-policy gap was found requiring CTO escalation.** The one
deliberate reading beyond `ADR-054`'s literal wording (§2's
`resolveControlAccount` vs `resolveConfiguredPostableAccount`) is a
technical-consistency resolution, not a policy question — it implements
`ADR-054`'s actual requirement (configured, no hard-coded fallback) via the
mechanism already binding for GRNI's own reconciliation (Phase 8), not a
new one.

## Acceptance Matrix (Phase 7-equivalent for this contract)

1. GR posts → `Dr Inventory / Cr GRNI`, balanced, one event, one journal.
2. Invoice posts → `Dr GRNI / Cr AP`, balanced, one event, one journal.
3. Full chain: `PO → GR → GRNI → Supplier Invoice/AP → GRNI clears →
   Supplier Payment → Treasury → GL → Supplier Ledger` — traced end to end
   via direct Postgres queries, not HTTP 200s (this session's own
   established discipline).
4. No duplicate posting (idempotency key re-delivery test).
5. Partial receipt + partial invoice, multiple of each against one PO line.
6. `GrniReconciliationService` transitions from `no_subledger_source` to
   `matched` once the real chain above is posted and reconciled.
7. Month-End's existing Phase 1-8 tests re-run **unchanged** — confirms this
   phase did not silently alter the five already-frozen reconciliation
   types' behavior (`ADR-056`'s own re-verification requirement).
8. Full regression suite.

Proceeding to implementation.
