# Org-Structure Engine — Attribution decision register (Phase 2, 2026-10-26)

**Status of every item: PENDING — no decision has been taken, no default rule is implemented, no code or data was changed for any of them.** Today's behaviour (column "current") stays exactly as is until a decision below is signed. The options are listed so the decision-makers can choose; none is recommended or assumed. Tests passing is not an approval of a business or accounting rule.

How to use: each item has a decision block at its end. A decision is valid only when the business/financial owner **and**, where marked, the CTO have filled it in with name and date. Until then the affected scope may not be called complete.

---

## D-A · Supplier Payments
**Current behaviour (code):** `supplier-payment.service.ts` publishes `supplier_payment.recorded` with `orgUnitId: null`; the payment can allocate to several supplier invoices (`supplier_payment_allocations`) and is paid from one treasury account (`treasury_accounts.orgUnitId` exists, unassigned by default). The invoices themselves *are* branch-attributed (their events carry the purchase order's branch). Result today: AP is raised in a branch and relieved at company level.

| Option | Effect on data / journal | Effect on permissions & scope | Effect on reports |
|---|---|---|---|
| A. Paying account's unit | event + both journal lines carry the bank account's branch (needs the account to be assigned) | a branch user sees payments from accounts of their branch | branch AP *outstanding* (invoices by branch minus payments by bank branch) can go negative/positive across branches |
| B. Invoice branch (one line group per allocation) | handler would write one Dr-AP line per allocation branch and the Cr-Bank line to the account's branch (**changes the event/handler shape**) | payment visible wherever any allocation is | branch AP balances close correctly; bank side attributed to the account's branch |
| C. Company level (null — today) | no change | no change | AP by branch never reconciles to the supplier ledger; payments stay in *Unassigned* |
**Owner of the decision:** Finance owner / CFO (name: ____). **CTO:** needed only for option B (event-contract change). **Tests required after approval:** single-branch invoice; mixed-branch allocation (per the chosen rule; per-line amounts sum to the payment); unassigned invoice + assigned invoice; bank account of another branch; void/reversal mirrors the original attribution; org report AP figures reconcile with the supplier ledger by branch; permission: branch user sees only their share.
Decision: ☐ A ☐ B ☐ C ☐ other: ____ · decided by ____ · date ____ · CTO (if B) ____

## D-B · Collections
**Current behaviour:** `collection.recorded` (operational, never reaches the GL) and `collection.remitted` (GL) carry no org unit. A collection links to a shipment, which carries `branchOrgUnitId` (from the sales order); the cash sits in the vehicle's custody treasury account, which inherits the **vehicle's** branch. A vehicle of branch A can deliver an order of branch B, so the three candidate branches can differ.

| Option | Effect on data / journal | Permissions & scope | Reports |
|---|---|---|---|
| A. Order/shipment branch | remittance entry carries the order's branch | follows order visibility | revenue and its cash in the same branch; custody account (vehicle branch) ≠ receivable branch → inter-branch balance |
| B. Vehicle/custody account branch | custody cash attributed to the vehicle's branch until remitted | visible to the vehicle's branch | cash by branch matches custody; order branch loses its cash |
| C. Receiving (remittance) account's branch | attribution at remit time | follows the receiving account | cash by branch matches banks; no link to order branch |
| D. Company level (today) | no change | no change | stays *Unassigned* |
**Owner:** Finance owner (name ____) **and** Logistics owner (name ____). **CTO:** only if an inter-branch clearing account is introduced. **Tests after approval:** matching branches; vehicle ≠ order branch; unassigned shipment; partial remittance; remittance into another branch's account; the custody balance report still equals the sum of open collections.
Decision: ☐ A ☐ B ☐ C ☐ D ☐ other: ____ · decided by ____ · date ____

## D-C · Manufacturing Orders
**Current behaviour:** `work_orders` have a production `warehouseId` and an optional `wipWarehouseId` (created without a branch); none of the `manufacturing.work_order.*` events carries `orgUnitId`; work centers have no branch attribute. WIP, material issue and finished-goods postings are therefore unattributed.

| Option | Effect on data / journal | Permissions & scope | Reports |
|---|---|---|---|
| A. Production warehouse's branch | events carry that branch; WIP warehouse inherits it | follows the warehouse scope | manufacturing cost by the branch that runs the order; components drawn from another branch's warehouse need a rule |
| B. Finished-goods warehouse's branch | attribution at receipt | follows the FG warehouse | cost sits where goods land |
| C. New attribute on the work center | **data-model change** (work centers get a branch) | scope by work center | most precise, new master data to maintain |
| D. Company level (today) | no change | no change | stays *Unassigned* |
**Owner:** Manufacturing owner (name ____) and Finance owner (name ____) for valuation of cross-branch component issues. **CTO:** required for option C (model change). **Tests after approval:** single-branch work order end to end (issue → WIP → receipt) with the GL lines carrying the chosen branch; cross-branch component; unassigned warehouse; WIP warehouse inherits the chosen branch; cost totals unchanged.
Decision: ☐ A ☐ B ☐ C ☐ D ☐ other: ____ · decided by ____ · date ____ · CTO (if C) ____

## D-D · Payroll Runs
**Current behaviour:** `payroll.run.posted` carries totals only (no `orgUnitId`); employees carry `departmentId` (an org unit), from which a branch is derivable (`OrganizationService.getBranchOf`); a run covers a whole period for all employees; employees without a department have no derivable branch.

| Option | Effect on data / journal | Permissions & scope | Reports |
|---|---|---|---|
| A. Split by employee's branch | one journal line group per branch; bucket needed for employees without department | HR users see payroll of their branches | salary cost by branch; transfers mid-period need a cut-off rule |
| B. Company level (today) | no change | no change | stays *Unassigned* |
| C. One "payroll unit" chosen per run | run-level attribute | follows that unit | simple, but not cost-accurate |
**Owner:** HR/Payroll owner (name ____) and Finance owner (name ____). **CTO:** option A/C add an attribute or change the posting handler. **Tests after approval:** run with employees of two branches (split sums to the run total); employee without department; mid-period transfer; org-report salary figures reconcile with run totals; payslip amounts unchanged.
Decision: ☐ A ☐ B ☐ C ☐ other: ____ · decided by ____ · date ____

## D-E · Department-only scope (security-relevant)
**Current behaviour:** the resolver (`OrgContextService`) accepts only a branch inside the caller's accessible units; visibility is the downward closure of memberships/grants. A user scoped only to a department therefore reaches **no** branch: branch-required creates (vehicles, warehouses) are refused ("No branch is available to you"), and a branch-stamped record would not be visible to them.

| Option | Effect | Risk |
|---|---|---|
| A. Operational: such users must also be granted their branch scope (no code) | no change to the engine | none new; administrators must grant correctly |
| B. Resolver derives the branch from an ancestor of the user's unit **and** visibility of that branch's records is extended to descendants' users | **changes the visibility rule** | widens access: a department user would see the whole branch's stamped records — security decision |
| C. Stamp at department level | data-model change | larger redesign |
**Owner:** CTO / security owner (name ____); business owner informed. **Tests after approval:** department-only user creating a vehicle / warehouse / order; visibility from a sibling department; re-assert the cross-branch negative cases of `org-context.real-pg.spec`; admin-grant flow.
Decision: ☐ A ☐ B ☐ C ☐ other: ____ · decided by ____ · date ____

---

## Summary table
| Item | Decision owner | Needs CTO | Status |
|---|---|---|---|
| D-A Supplier payments | Finance owner / CFO | if option B | **PENDING** |
| D-B Collections | Finance + Logistics owners | if clearing account | **PENDING** |
| D-C Manufacturing orders | Manufacturing + Finance owners | if option C | **PENDING** |
| D-D Payroll runs | HR/Payroll + Finance owners | if option A/C | **PENDING** |
| D-E Department-only scope | CTO / security owner | yes | **PENDING** |
**Alternative to deciding:** the release owner may formally exclude an item from this release's scope; the item then stays documented as *not covered* (its postings appear under *Unassigned* in the organizational report) and no completeness claim is made for it.
