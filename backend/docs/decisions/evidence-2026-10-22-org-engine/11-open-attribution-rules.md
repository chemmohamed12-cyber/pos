# Open organizational-attribution rules — status register (2026-10-26)

Rule followed: **no attribution rule is invented.** Each item below states (1) what the code and data do today (verified by reading the cited code), (2) the rule the business/finance owner must set, (3) the open decision as a concrete question, (4) the tests that become mandatory once the decision exists. Until a decision exists the item stays **OPEN** and the affected scope must not be described as complete. Passing tests are not approval of an accounting rule.

| # | Item | Current behaviour (verified) | Status |
|---|---|---|---|
| 1 | Supplier Payments | `supplier-payment.service.ts` publishes `supplier_payment.recorded` with `orgUnitId: null`; a payment can carry several invoice allocations (`supplier_payment_allocations`) and is paid from one `treasuryAccountId` (`treasury_accounts.orgUnitId` exists). The invoices it settles ARE branch-attributed (their events carry the PO's branch). | **OPEN** |
| 2 | Collections | `collection.recorded` (operational, never reaches the GL) and `collection.remitted` (GL) carry no org unit; a collection links to a shipment, which carries `branchOrgUnitId` (stamped from the order); the cash sits in the vehicle's custody treasury account, which inherits the vehicle's branch. | **OPEN** |
| 3 | Manufacturing Orders | `work_orders` have `warehouseId` and `wipWarehouseId`; none of the `manufacturing.work_order.*` events carries `orgUnitId` (the handler passes `event.orgUnitId`, which is absent), so WIP / material issue / finished-goods postings have no branch. The WIP warehouse is created by the work-order service with no branch. | **OPEN** |
| 4 | Payroll Runs | `payroll.run.posted` carries totals only; no `orgUnitId`; employees carry `departmentId` (an org unit) from which a branch is derivable (`OrganizationService.getBranchOf`); a run covers a whole payroll period for all employees. | **OPEN** |
| 5 | Department-only scope | `OrgContextService.resolveBranch` only accepts a branch inside the caller's accessible units; a user whose scope is a department (not its branch) reaches no branch, so branch-required creates fail with "No branch is available to you". Records stamped with the branch would also be invisible to them (visibility = accessible-unit closure, downwards only). | **OPEN** (structural) |

## 1. Supplier Payments
- **Rule needed:** which organizational unit a payment's GL entry belongs to. Candidates the owner may choose between (none is assumed): (a) the paying treasury account's unit; (b) the invoices' branch when every allocation is the same branch, otherwise split per allocation; (c) company level.
- **Open question → Finance owner / CFO:** "For a supplier payment settling invoices of branches A and B from a bank account owned by branch A, which branch(es) carry the Dr AP / Cr Bank lines?"
- **Tests required after the decision:** payment of single-branch invoice; mixed-branch allocation (per the chosen rule, with per-line amounts summing to the payment); unassigned invoice + assigned invoice; bank account of another branch; reversal/void mirrors the original attribution; org report's AP figures reconcile with the supplier ledger by branch.

## 2. Collections
- **Rule needed:** the branch that owns collected cash and its remittance: the shipment's/order's branch, the vehicle's branch, or the receiving treasury account's branch — they can legitimately differ (a vehicle of branch A delivering an order of branch B).
- **Open question → Finance owner + Logistics owner:** "When a vehicle of branch A collects COD for an order of branch B, whose branch carries the custody receivable and the remittance?"
- **Tests required:** matching branches; vehicle ≠ order branch; unassigned shipment; partial remittance; remittance into an account of a third branch.

## 3. Manufacturing Orders
- **Rule needed:** which branch owns WIP, material issues and finished-goods receipts (the production warehouse's branch, the finished-goods warehouse's branch, or a work-center branch — work centers have none today), and what a cross-branch material issue means.
- **Open question → Manufacturing owner + Finance owner:** "Is a work order owned by the branch of its production warehouse, and how are components drawn from another branch's warehouse valued/attributed?"
- **Tests required:** single-branch work order end-to-end (issue → WIP → receipt) with the GL lines carrying the chosen branch; cross-branch component; unassigned warehouse; WIP warehouse inherits the chosen branch.

## 4. Payroll Runs
- **Rule needed:** whether payroll is attributed per employee (employee → department → branch, one journal line group per branch) or at company level, and where employees without a department go.
- **Open question → HR/Payroll owner + Finance owner:** "Should the payroll journal be split by the employee's branch, and what is the bucket for employees with no department?"
- **Tests required:** run with employees of two branches (split sums to the run total); employee without department; employee transferred mid-period; org report salary figures reconcile with the payroll run totals.

## 5. Department-only scope
- **Options (decision, not implemented):** (a) such users must also be granted the branch scope (operational answer, no code); (b) the resolver derives the branch as the nearest branch ancestor of the user's accessible units, and visibility of branch-stamped records is extended to users scoped to a descendant department (changes the visibility rule — security-relevant); (c) stamp at department level (changes the data model).
- **Open question → CTO / security owner:** "May a user scoped to a department see and create documents of the branch above it, or must they hold the branch scope?"
- **Tests required:** department-only user creating a vehicle / warehouse / order; visibility of a stamped record from a sibling department; the cross-branch negative cases from `org-context.real-pg.spec` re-asserted.

## Effect on the release claim
Until items 1–4 are decided the organizational report's **financial** columns (posted debits/credits by branch) are valid for sales, procurement receipts/invoices/returns/credit notes and treasury, but **exclude** supplier payments, collections, manufacturing and payroll entries from branch attribution (they appear under *Unassigned*). Item 5 limits who can use branch-required functions until a rule is chosen.
