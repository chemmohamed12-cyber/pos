# ADR-071 — Addendum 1 (v1): Commission gap-closure contract — PROPOSED

**Version:** ADDENDUM-1 / v1 · **Date:** 2026-10-25 · **Status: PROPOSED — NOT APPROVED.** The text and header of `ADR-071` are **not edited**. Final approval status is recorded only after CTO approval of this addendum with `ADR-070-ADDENDUM-1` and `ADR-072-ADDENDUM-1`.
**Basis:** CTO decision of 2026-10-25 (gap closure, not greenfield). Findings `X-n` = `HR_PAYROLL_PHASE0_FOUNDATION_AND_BASELINE_REPORT_2026-10-25.md` §3.
**Adopted contract outcomes:** eligibility follows the *approved business attribution rule*; approval time controls availability, not attribution; an approved result is consumed once by a finalized run; carry-forward and corrections are explicit, traceable, idempotent; `net_sales` and `customer_group` stay disabled until their basis and data source are explicit and verified; the actual collection path is documented and tested.
**Not decided here:** the attribution date itself, cut-off, commission expense timing/accounts, settlement channel (payroll or other), reversal of already-paid commission, negative balances — owner decisions (§6).

---

## A-1 (X-1) — Attribution vs availability
- **Entities/fields (additive, proposed):** `CommissionResult.attributionDate` (date) and `attributionRuleVersion` (text) — the date the *business rule* attributes the commission to (e.g. invoice business date, or collection date for `collected_amount`); written at calculation time from the source event; immutable like the rest of the snapshot. `approvedAt` is derived from the batch decision.
- **Invariants:**
  - C-1: *Attribution* is a property of the business transaction and never changes because approval happens late or early.
  - C-2: *Availability* = the result's batch is `approved`. A result is available to Payroll from the moment of approval.
  - C-3: Payroll's read contract is parameterized by a **selection rule object** supplied by policy: `attributedOnOrBefore(periodEnd)`, `approvedBefore(calculatedAt)`, `notConsumed`. The concrete rule (strict period membership vs carry-forward of earlier unconsumed results) is a **policy decision** (§6 P-1); the contract works for either.
  - C-4: Today's behaviour (window on `calculationTimestamp`) is **documented as the actual path**, not as the attribution rule; it cannot represent carry-forward (X-1) — to be replaced behind the same method name `listApprovedCommissionResults`, compatibly (extra optional parameters; same return type).
- **Compatibility:** results without `attributionDate` (existing) use `calculationTimestamp::date` as a **declared fallback** flagged `attributionRuleVersion='legacy-calculation-date'`; no historical result is rewritten (a new column with a computed default, not an update of immutable fields — migration form to be confirmed).
- **Acceptance tests:** result approved after a run calculated is *not* in that run and *is* available to the next eligible run per the chosen rule; the same result is never returned twice once consumed (A-2); legacy results behave exactly as before; attribution unchanged by approval delay.

## A-2 (X-2) — One consumption by a finalized run (ownership is Payroll's)
- **Entity (owned by Payroll, listed here as the contract's counterpart):** `PayrollCommissionConsumption(commissionResultId, payrollRunId, payrollRunLineId, revision, state ∈ {reserved, consumed, released}, amount, carriedForward bool, policyId, policyVersion)`.
- **Invariants:** C-5: **database-level** uniqueness — partial unique index on `commissionResultId` where `state IN ('reserved','consumed')`; C-6: `reserved → consumed` only in the transaction that finalizes the run, guarded by an affected-row count equal to the number of reservations; C-7: reservation belongs to a run revision, never to a user; recalculation/supersession/rejection/cancel ⇒ `released`; C-8: the amount and the policy/version are copied; the original `CommissionResult` is never touched (immutability, ADR-068 §F).
- **Concurrency:** two concurrent runs cannot both reserve the same result (the second insert conflicts and the result is excluded from it, logged); two concurrent approvals of the same run cannot double-consume (compare-and-set + advisory lock per run, pattern already used by `disburse`).
- **Commission-side contract:** Commission exposes **availability only**; it does not know consumption. It exposes `CommissionResultReversed/Adjusted` facts (A-3).
- **Acceptance tests (real DB):** parallel calculate on two overlapping revisions ⇒ each result reserved once; double-approve ⇒ one consumption set; release on supersede then re-reserve ⇒ single active row; consumed result cannot be re-reserved; carry-forward row flagged `carriedForward`.

## A-3 — Adjustments (Commission side)
- `CommissionAdjustment` (exists) is an **immutable, separately identifiable input**: carries `originalCommissionResultId`, signed `amountDelta`, `kind`, reason, `approvalRequestId`; becomes **available** only when approved (FA-01) like results.
- If the original result was already consumed by a **posted** run, the adjustment is consumed by the first eligible *open* run as an explicit line `inputKind='commission_adjustment'` linked to the original result and the prior run line (ADR-072 §14, unchanged). Idempotency: one adjustment ⇒ one consumption (same unique index design with `inputKind`).
- Negative net results (clawback larger than the period's earnings): handling is a policy decision (§6 P-4); until decided the run produces an **exception** (not a silent zero, not a negative net pay).
- **Acceptance tests:** adjustment of a posted-run result lands once in the next open run, linked both ways; redelivery creates no second input; unapproved adjustment is invisible to Payroll.

## A-11 (X-14, X-15) — `net_sales` and `customer_group`
- **Contract position:** policies with `basis='net_sales'` or `scope='customer_group'` are **disabled**: creation/activation is rejected until (a) the composition of net sales (returns, discounts, tax) is ratified and (b) a structured Customer Group source exists and is verified. Today the code maps `net_sales` to `netAmount` (inspected, `commission.service.ts:360`) — i.e. defined by implementation, not by decision (X-14).
- **Acceptance tests:** create/activate a `net_sales` or `customer_group` policy ⇒ rejected with an explicit reason; existing rows (if any) are listed by a read-only report and not auto-modified; flat/gross/collected paths unchanged.

## A-10 (X-13) — Actual collection path (documented, to be tested)
Commission subscribes to `finance.invoice.posted` and `collection.remitted`; it does **not** subscribe to `collection.recorded` (deliberate F03 convention, code comment). The ADR text (`collection.recorded|remitted`) is superseded **for implementation purposes** by this statement once approved.
- **Acceptance tests:** invoice posted ⇒ `gross_sales`/`net_sales`(disabled) result; `collection.remitted` ⇒ `collected_amount` result; `collection.recorded` alone ⇒ nothing; redelivered events ⇒ no second result (idempotency key per source event kind, ADR-071 §12); invoice and later collection against it ⇒ two different keys, no collision.

## Traceability & compatibility
Every consumed amount traces: source invoice/collection → `CommissionResult` (policy+version+inputs) → batch approval → consumption row → run line → Financial Event → journal. Additive schema only; no change to Sales/CRM; Targets untouched.

## §6 Policy decisions required (owners)
P-1 attribution date per basis and carry-forward rule/cut-off · P-2 settlement channel (payroll or other) per policy · P-3 commission expense recognition timing/accounts (DEC-04, Accounting) · P-4 reversal after payment, negative balances, recovery · P-5 net-sales composition · P-6 customer-group source (CRM). Until decided, the implementation plan treats them as parameters and does not hard-code a rule.
