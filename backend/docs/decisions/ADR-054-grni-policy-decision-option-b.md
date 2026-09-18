# ADR-054 — GRNI Policy Decision: Option B Ratified (Receipt-Based Recognition)

**Status:** ACCEPTED — binding accounting policy. Supersedes the open question in
`ADR-052-grni-policy-impact-analysis-PENDING.md`.
**Date:** 2026-09-18
**Decided by:** CTO, per the P0 Procurement Financial-Core Resolution directive, item 3.

## Context

`ADR-052` analyzed two options for Goods Receipt financial recognition without
recommending one, per its own scope. Option A (the code's current behavior,
inherited from ADR-040/041's "a receipt has no accounting entry, only a
valuation-subledger one") understates both the inventory asset and the
supplier liability between receipt and invoice, and leaves uninvoiced
receipts structurally invisible to the Month-End Closing Audit Engine
(ADR-050). Option B (GRNI — Goods Received Not Invoiced, a clearing/suspense
liability) recognizes both legs as they occur, at the cost of a new
reconciliation surface.

## Decision

**Option B is ratified as DAII's permanent accounting policy for goods
receipt.** The purchasing accounting cycle is now formally:

```
PO → GR → GRNI → Supplier Invoice → AP → Payment → Treasury
```

**At Goods Receipt** (posted, not draft):
```
Dr Inventory
Cr GRNI
```

**At Supplier Invoice** (clearing the corresponding GRNI exposure):
```
Dr GRNI
Cr Accounts Payable
```

**At Supplier Payment** (unchanged — already correct under ADR P0.1's Treasury
contract boundary):
```
Dr Accounts Payable
Cr Cash or Bank
```

This is a policy decision that **only Procurement's Goods Receipt handler is
affected today** — it does not reopen or change ADR-040/041's "receipts never
post to GL" rule for other domains (e.g. Warehouse Receipt transactions,
opening-stock import) unless and until the CTO separately extends this
decision to them. `ADR-052 §3` explicitly warned against implementing B for
Procurement alone while leaving other `recordMovement('receipt', ...)`
callers silent for no principled reason — this is accepted as a **known,
scoped, temporary asymmetry**, not an oversight: Procurement is the only
domain today where a Goods Receipt has a distinct downstream Supplier Invoice
to clear against, so it is the only domain where GRNI has a matching exposure
to close. Extending GRNI-style recognition to other receipt sources is a
separate future decision, not implied by this one.

## Implementation Requirements

This is not "add one journal entry at GR." The full GRNI lifecycle must be
built so Month-End can determine, per PO line and in aggregate: what has been
received, what has been invoiced, and what remains open — without breaking
provenance or the audit trail.

1. **Every posted Goods Receipt** must create an idempotent Financial Event
   producing `Dr Inventory / Cr GRNI`, following the exact same
   `FinancialEventService` idempotency-key pattern every other handler
   already uses (per `ADR-052`'s own confirmation that this introduces no new
   idempotency risk).
2. **Supplier Invoice posting** must clear the corresponding GRNI exposure:
   `Dr GRNI / Cr Accounts Payable`, matched against the originating receipt(s)
   — not a bare unmatched debit to GRNI.
3. **Partial receipts and partial invoicing** must both be supported.
   `PurchaseOrderLine.quantityReceived`/`quantityInvoiced` are already tracked
   per-line (per `ADR-052`'s verification) — each partial receipt gets its own
   GRNI leg sized to that receipt's value, and each partial invoice clears
   only the matching portion.
4. **Full provenance must be preserved and queryable end-to-end:**
   `PO → GR → GRNI → Supplier Invoice → AP`. A GRNI balance must always be
   traceable back to the specific receipt(s) that created it and forward to
   the specific invoice(s), if any, that cleared it.
5. **Supplier Payment is unaffected** — `Dr AP / Cr Cash or Bank`, through the
   already-ratified Treasury contract boundary (`cashOutForSupplier` on
   `FinanceTreasuryContract`, P0.1). No change required here.
6. **Returns must reverse the correct exposure according to the original
   receipt's provenance** — a return against an uninvoiced receipt reverses
   the GRNI leg; a return against an already-invoiced receipt requires the
   appropriate AP-side/credit-note treatment instead. (Procurement has no
   purchase-return flow built yet per `ADR-052 §2` — this requirement governs
   that flow's design when it is built, it does not require building it now.)
7. **Month-End Closing** must identify and reconcile outstanding GRNI balances
   and uninvoiced receipts. This is a **sixth reconciliation type** for
   `ClosingAuditService` (alongside AR/AP/CashBank/Inventory/FixedAsset per
   `ADR-052`'s own finding) — a received-but-uninvoiced GRNI balance is a real
   open item Month-End must be able to see and, per policy, potentially block
   a close on.
8. **No direct GL posting from Procurement.** Every GL effect in this policy
   goes through the approved Financial Event / Accounting integration
   boundary (`ADR-018`) — same rule as every other domain, no exception for
   GRNI.
9. **All financial events under this policy must be idempotent and
   concurrency-safe** — per `ADR-053 §6/§7`, this is now a permanent,
   verified completion criterion, not an assumption. Concurrent receipt
   posting, concurrent invoice posting against the same PO line, and
   concurrent Month-End GRNI reconciliation must all have defined,
   deterministic behavior.
10. **Update the relevant ADR and implementation contract before coding** —
    this ADR is that update for the policy itself; the Procurement/Month-End
    implementation contracts (and `ADR-050`'s `ClosingAuditService` scope)
    must be revised to include the GRNI reconciliation type before
    implementation begins, not after.

## Status of P0.3

**P0.3 (GRNI policy) is CLOSED as an accounting-policy decision.** The team
proceeds to implementation/design verification under this ADR. Per
`ADR-053 §16`, this policy decision is not to be reopened absent a concrete
accounting, architecture, or security conflict discovered during
implementation — any such conflict is escalated to the CTO, not resolved
silently in either direction.

## Consequences

- `ADR-050` (Period Closing Audit Engine) gains a sixth reconciliation
  obligation (GRNI) that must be reflected in its scope before Month-End
  implementation is considered complete against it.
- A new GRNI GL account (liability/suspense) must be configured through the
  existing `resolveConfiguredPostableAccount` mechanism — no hard-coded
  fallback account, matching every other accounting domain's convention.
- The Goods Receipt posting path gains a new Financial Event type; the
  Supplier Invoice posting path's existing handler must be extended to clear
  GRNI instead of (or in addition to, during any transition) its current
  single combined entry — the transition/backfill approach for POs already
  in flight under the old (Option A) behavior must be explicitly designed,
  not assumed.
- This decision does **not** extend to non-Procurement receipt sources
  (Warehouse Receipt, opening-stock import) — they remain under ADR-040/041's
  existing rule unless a future ADR extends this policy to them.
