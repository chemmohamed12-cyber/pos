# ADR-INV-06 - Rounding between valuation and the General Ledger

**Status: PROPOSED (Gate B) - two phases; phase 2 changes valuation figures and needs explicit approval after phase 1 data is reviewed.** **Answers:** D-INV-6. **Gate A evidence:** G-RECON-2 (measured O8/O8b): an adjustment at average 4.8889 posted a line of 9.7778 (transaction currency, 4 dp) that became **9.78** in the base currency (2 dp); valuation kept 9.7778; reconciliation reported `drift_found` with -0.0022.

## 1. Context
Valuation (`inventory_valuation_state` / `_movements`) is `numeric(20,4)`. Journal lines store the transaction amount at 4 dp and the base amount rounded to the base currency's decimals (EGP = 2). `reconcile()` requires **exact equality** (`inventory-reconciliation.service.ts:126`). Every fractional-average posting therefore adds a sub-cent residual to one side; residuals accumulate and the control reports differences that are not errors. A tolerance would also hide real small differences.

## 2. Decision
### Phase 1 - explain exactly, change no number (low risk, first)
Reconciliation (ADR-INV-09) attributes the rounding component **exactly**: for each inventory event it compares the valuation row's value delta (by idempotency key) with the journal's base amount, and reports `roundingResidual = sum(valuationDelta - journalBaseAmount)` as its own category with the count of postings behind it. `matched` means "no unexplained difference"; a pure-rounding difference shows as **explained: rounding** with the figure, never as a silent pass and never as a false alarm. No tolerance threshold is introduced.

### Phase 2 - remove the cause for new postings (behaviour change, approval required)
For events that post to the GL, the valuation engine records the **base-currency-rounded amount** that the journal will carry (receipt: `round(qty x cost)`, issue/adjustment: `round(qty x average)`), so valuation and GL hold the same figure by construction. The unit average cost stays at 4 dp for display/costing; total value becomes authoritative. Transfers (no journal) move the rounded amount out of the source and into the destination so company totals are unchanged. The rounding scale comes from the currency service (`decimalPlaces`), not a constant. Existing residuals are not auto-corrected; an accountant may clear them through the approved value-only adjustment (ADR-INV-05).

## 3. Alternatives
*Tolerance of +/- 0.01 (or per-posting)* - rejected: grows with volume and hides real errors. *Post journals at 4 dp* - rejected: contradicts the base-currency scale contract used by every ledger and report. *Round only at reconciliation time* - rejected: leaves the engine and the books carrying different totals.

## 4. Impact / compatibility / rollback
Phase 1: reconciliation service/UI only. Phase 2: `MovingAverageCostEngine` arithmetic (the SQL expressions at `applyReceipt/applyIssue/applyTransfer`), its callers' contracts (an optional `baseDecimalPlaces`), flag `inventory.valuation_round_to_base` (default off). Valuation totals will differ from `qty x average` by sub-cent amounts by design. Rollback = flag off (history written under phase 2 stays valid; it is already equal to the GL).

## 5. Tests
Property test with random fractional costs and quantities across receipts, issues, adjustments, transfers: phase 1 -> unexplained = 0 and `roundingResidual` equals the independent sum; phase 2 -> valuation total = GL 1120 exactly after N operations; transfer leaves the company total unchanged; zero-decimal and 3-decimal currencies; re-drive adds nothing.

## 6. Approval needed
Phase 1 now; phase 2 after the phase-1 residuals have been reviewed on real data (the Q4/Q-pack queries and the new reconciliation breakdown).
