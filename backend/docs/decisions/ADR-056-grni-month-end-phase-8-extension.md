# ADR-056 — GRNI Month-End Integration: Approved as Phase 8 Additive Extension

**Status:** ACCEPTED — resolves the conflict between `ADR-051 §1` and `ADR-054`.
**Date:** 2026-09-18
**Decided by:** CTO.

## Context

`ADR-054` ratified GRNI (Option B) and required, as implementation item 7,
that Month-End Closing identify and reconcile outstanding GRNI balances and
uninvoiced receipts as a sixth reconciliation type. `ADR-051 §1` froze Month-
End's `ClosingAuditService` scope at exactly five reconciliation services
(AR/AP/Cash-Bank/Inventory/Fixed-Asset) — written before GRNI existed as
policy.

Per the governing rule established in `ADR-053 §16`, an architectural
conflict between two ratified ADRs is not resolved silently by whichever
team reaches it first. The "DAII month close" implementation session
correctly identified this exact conflict during its own Phase 7 verification
and escalated it rather than unilaterally adding a sixth reconciliation type
to an already-CTO-frozen contract, or unilaterally deferring GRNI out of
scope. This ADR is that escalation's resolution.

## Decision

**GRNI Month-End Integration is APPROVED.** GRNI reconciliation is part of
the Month-End Closing capability and is **not** deferred as a separate
post-release gap. A Month-End Closing implementation is not considered
complete against the DAII ERP scope until it can verify all six:

1. AR
2. AP
3. Cash/Bank
4. Inventory
5. Fixed Assets
6. **GRNI**

Launching Month-End with only the original five would ship a Closing Engine
structurally blind to one of the material obligations created by the
purchasing cycle this program just ratified (`ADR-054`) — an accepted gap of
exactly the kind `ADR-053 §18`'s "does it block or complicate what comes
after it" proof exists to catch before it ships, not after.

### Scope of the extension

The already-completed and verified Phase 1–7 work under `ADR-051` is
**preserved as-is and is not reopened.** GRNI is added as **Phase 8**, an
**additive extension** to the existing Month-End Closing implementation
contract, under the same governing document (`ADR-051`) — not a new,
separate Month-End effort, and not a rewrite of any prior phase.

Phase 8 must:

- Add the sixth reconciliation type (GRNI) **without silently altering** the
  behavior, schema, or previously-verified test results of the five
  reconciliation types already frozen in `ADR-051 §1`. If Phase 8's addition
  requires touching shared `ClosingAuditService` scaffolding used by the
  existing five, that scaffolding change must be additive (a new
  reconciliation-type registration, not a restructuring) and must not change
  any of the five's existing pass/fail behavior — re-verify all five's
  existing tests still pass unchanged, not just that they still exist.
- Implement the required chain: **Goods Receipt → GRNI → Supplier Invoice →
  AP**, per `ADR-054`'s provenance requirement (item 4) — a GRNI exception
  raised by the Closing Audit must be traceable back to its originating
  receipt(s).
- Identify outstanding/unmatched GRNI exposure (received-but-uninvoiced
  balances) and include it in the same closing audit/blocking model
  (`ClosingException` lifecycle, per `ADR-051 §2`) the other five
  reconciliation types already use — a GRNI exception is a `ClosingException`
  row like any other, not a parallel mechanism.
- **Not** modify unrelated accounting behavior, and **not** reopen
  `ADR-040`/`ADR-041` ("a receipt has no accounting entry, only a
  valuation-subledger one," for non-Procurement receipt sources) — this
  extension is scoped exactly to what `ADR-054` ratified, no wider.

### Procurement implementation dependency

GRNI's own posting logic (the Goods Receipt and Supplier Invoice financial
events required by `ADR-054`) is a **separate, currently-unowned** piece of
work — the session that authored `ADR-052`/owned Procurement's P0 items has
ended and is not assumed to resume automatically. Month-End's Phase 8 GRNI
reconciliation logically depends on GRNI postings actually existing to
reconcile against; the team executing Phase 8 should treat "does
Procurement's GRNI posting exist yet, and does its shape match what
Phase 8's reconciliation expects" as an explicit, checked dependency, not an
assumption — and should escalate to the CTO if Phase 8 reaches a point where
it is blocked on Procurement-side work that has no active owner, rather than
building a placeholder/mocked GRNI ledger to work around the gap.

## Consequences

- `ADR-051`'s frozen five-reconciliation-service scope (§1) is amended by
  this ADR to six, effective for any Month-End Closing acceptance from this
  point forward — this ADR is the authorization Phase 8 needed to proceed;
  `ADR-051` itself is not rewritten, this ADR sits alongside it as the
  additive amendment.
- A dedicated implementation session is required for `ADR-054`'s Procurement-
  side GRNI posting logic; it does not yet have an owner. Phase 8's own
  progress may be blocked on this and should say so explicitly rather than
  substitute a mock.
- The "DAII month close" session's existing Phase 1–7 tests remain the
  regression baseline — any Phase 8 change that causes one of them to fail
  differently than before is a defect in Phase 8, not an acceptable
  side-effect of "adding a sixth type."
