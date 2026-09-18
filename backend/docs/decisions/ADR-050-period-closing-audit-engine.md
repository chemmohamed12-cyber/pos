# ADR-050 — Period Closing Audit Engine

**Status:** Implemented (V1). Activates ADR-049's deferred scope now that the
ERP financial chain (Sales/Procurement → Inventory → Subledgers → GL) has been
fully audited and closed end-to-end (CTO directive, 2026-09-18).

## Context

ADR-049 recorded the Period Closing Engine as a future capability with nine
scope items. Auditing the existing codebase (audit-first discipline, before
designing anything new) found that most of the mechanical scaffolding
**already exists** and did not need to be rebuilt:

- Period Lock, controlled reopening, and full audit trail for close/reopen
  already exist — F13 / ADR-046 (`FiscalPeriodService`, `FISCAL_PERIOD_PROCESS`),
  gated by the FA-01 maker-checker Approval Engine.
- Per-domain Ops↔Subledger↔GL reconciliation already exists for every
  relevant subledger — `ArReconciliationService`, `ApReconciliationService`,
  `CashBankReconciliationService`, `InventoryReconciliationService`,
  `FixedAssetReconciliationService` — each read-only, each returning a
  `matched | drift_found | no_subledger_source/no_valuation_source` verdict.

What did **not** exist: an orchestration layer that runs all of them together
for one fiscal period, aggregates the result, and gates `submitPeriodClose`
on it. That gap is this ADR's entire scope — composing existing, already-
tested mechanisms, not reinventing subledger reconciliation.

## Decision

`ClosingAuditService.run(fiscalPeriodId, actorUserId)`:

1. Resolves the `FiscalPeriod` (its `endDate` is the reconciliation `asOfDate`,
   its `FiscalYear.orgUnitId` scopes every sub-check).
2. Calls each of the five existing reconciliation services for that scope.
3. Separately queries `accounting_financial_events` for `REJECTED` events
   whose `businessDate` falls inside the period.
4. Persists one `ClosingAuditRun` row (mirrors the existing reconciliation-run
   entities: `accounting_closing_audit_runs`) with a `status` and a full
   `exceptions` JSONB array, and returns it.

**Two exception classes, not one — this is the one real design decision this
ADR adds beyond wiring:**

- **`blocking`** — a reconciliation came back `drift_found` (subledger ≠ GL,
  a genuine current-state discrepancy). This is what ADR-049 calls a
  "critical discrepancy" and is the only thing that hard-blocks
  `submitPeriodClose` (`ConflictException`, listing every blocking exception).
- **`informational`** — a `REJECTED` financial event dated inside the period,
  or a reconciliation returning `no_subledger_source`/`no_valuation_source`
  (a dormant contract, not a discrepancy). These are surfaced in the audit
  result ("not silently skipped," per ADR-049) but do **not** block closing.

**Why split them:** a `REJECTED` financial event is, by this codebase's own
established and repeatedly-verified discipline (2026-09-18 Financial Integrity
Verification), often a *correctly and permanently* rejected event — a
data-entry mistake, a business-rule protection (`negative_on_hand`), or a
reference to since-deleted historical test data. Making every such event a
hard close-blocker would create pressure to redrive or otherwise "fix" a
rejection that was correct to reject, which directly contradicts the standing
rule "confirm old rejected events remain rejected for their original valid
reasons and are not blindly redriven." A `drift_found` reconciliation has no
such legitimate permanent form — subledger and GL either agree or they do not
— so only that class is treated as a true blocker.

## Consequences

- `FiscalPeriodService.submitPeriodClose` now runs the Closing Audit first;
  submission is refused (before any FA-01 request is even created) while a
  blocking exception is open. Reopening a *closed* period is unaffected —
  ADR-046 already gates that path independently.
- Read endpoint `GET /accounting/fiscal-periods/:id/closing-audit` (same
  `accounting.fiscal_period.view` permission node as the rest of F13 — no new
  permission node, no manifest change) lets a maker preview exceptions before
  submitting, and lists prior runs.
- No new UI. F13 itself (fiscal year/period close) has no frontend yet either
  — this stays API-only, consistent with that precedent, until F13 gets one.
- Purely additive: one new table, one new service, a five-line change to
  `submitPeriodClose`. No existing reconciliation service's code changes.
