# Org-Structure Engine — Decision owners and approval requests (Phase 1 of the Final Closure Directive, 2026-10-26)

**Nothing in this document is an approval.** Engineering cannot name decision owners or sign for them; the **project lead / executive owner** fills the *Assigned person* column, sends each request below to that person, and the person records the decision in `ORG-STRUCTURE-ENGINE-ATTRIBUTION-DECISION-REGISTER-2026-10-26.md` (decision blocks) using the closure record of §3. Until a block is filled by its owner, the item is **PENDING** and nothing is implemented for it. Candidate under review: `a4e0daf` (local tag `org-engine-candidate-a4e0daf`), unchanged.

## 1. Owner assignment (to be completed by the project lead — engineering leaves these blank)
| Decision | Role required | Assigned person (name, title) | Assigned by / date | Request sent (date) | Status |
|---|---|---|---|---|---|
| D-A Supplier payments | Finance Owner / CFO; **+ CTO if option B** | ____ | ____ | ____ | PENDING |
| D-B Collections | Finance Owner **and** Logistics Owner (jointly); **+ CTO if an inter-branch clearing account is introduced** | ____ / ____ | ____ | ____ | PENDING |
| D-C Manufacturing orders | Manufacturing Owner **and** Finance Owner; **+ CTO if work-center model change (option C)** | ____ / ____ | ____ | ____ | PENDING |
| D-D Payroll runs | HR/Payroll Owner **and** Finance Owner; **+ CTO if split by branch or run-level attribute** | ____ / ____ | ____ | ____ | PENDING |
| D-E Department-only scope | CTO / Security Owner (business owner informed) | ____ | ____ | ____ | PENDING |
| Alpha warehouse assignments | Alpha data owner (company/warehouse data), coordinated with the operations owner | ____ | ____ | ____ | PENDING |
| Alpha backfill execution approval | an approver named by the project lead (may differ from the data owner) | ____ | ____ | ____ | PENDING |
| Exclusion of any item from this release | **Release Owner** | ____ | ____ | ____ | — |
Escalation path when an owner cannot decide: executive owner → Release Owner. A scope may be excluded from the release **only** by the Release Owner's written approval; it then stays documented as **not covered** and no completeness claim is made for it.

## 2. Approval requests (one per decision — send as is)
Each request is self-contained; the full option tables are in the decision register. **Please choose one option or write your own; do not leave the default (today's behaviour) unrecorded — "keep as today" is also a decision.**

**R-A (to the Finance Owner / CFO) — Supplier payments.** Today a supplier payment is posted at company level while the invoices it settles are posted in their branch. Which branch(es) should carry the payment's Dr AP / Cr Bank lines? (A) the paying bank account's branch; (B) the invoices' branches — one AP line group per allocation, bank side on the account's branch (changes the event/handler: CTO approval needed); (C) company level as today. Consider: branch AP outstanding, inter-branch settlements, who may see the payment, and the new payment-reversal feature on the 1.1.13 line (a reversal must mirror the original).

**R-B (to the Finance Owner and the Logistics Owner) — Collections.** Cash collected on delivery can involve three branches: the order's, the vehicle/custody account's, and the receiving account's. Which one carries the collection/remittance, or company level? If you want inter-branch balances cleared through a clearing account, the CTO must approve its accounting and architectural effect.

**R-C (to the Manufacturing Owner and the Finance Owner) — Manufacturing orders.** Which branch owns WIP, material issues and finished-goods receipt: the production warehouse's, the finished-goods warehouse's, a new branch attribute on the work center (CTO approval: data-model change), or company level as today? And how is a component issued from another branch's warehouse valued and attributed?

**R-D (to the HR/Payroll Owner and the Finance Owner) — Payroll runs.** Should payroll be posted per employee's branch (via the employee's department), at company level as today, or against one unit chosen per run? How are employees without a department and mid-period transfers handled? (Split by branch or a run-level unit needs the CTO's approval.)

**R-E (to the CTO / Security Owner) — Department-only scope.** A user scoped only to a department cannot reach the branch above it, so branch-required functions refuse them and branch-stamped records are invisible to them. Choose: (A) require them to also hold their branch scope (no code); (B) derive the branch from the department and extend record visibility to the branch (this **widens access** — a security decision); (C) stamp at department level (model change). No resolver or visibility change will be made before your decision and the negative-access tests.

**R-F (to the Alpha data owner) — Warehouse branches.** Fill the last column of `evidence-2026-10-22-org-engine/12-alpha-warehouse-branch-worksheet.csv` for the 13 warehouses (handover note: file 23). Nothing is inferred from names; unassigned rows may stay empty with a reason.

## 3. Closure record (copy into the decision block; the item is closed only when ALL fields are filled by the owner)
1. Final decision text · 2. Approver name and title · 3. Approval date · 4. Companies affected · 5. Chosen option and exceptions · 6. Evidence reviewed (file references) · 7. Required tests / code changes arising (links to the implementation plan, Phase 3 of the directive).
A decision recorded on someone's behalf, or inferred from silence, is **invalid**.

## 4. Status tracker (updated only from the owners' written replies)
| Item | Request sent | Reply received | Decision recorded | Next engineering step |
|---|---|---|---|---|
| D-A … D-E | not sent by engineering (no owner named yet) | — | — | wait for owners; then `…-DECISION-IMPACT-PLAN-…` is turned into work packages |
| Alpha worksheet | handed over in file 23 (needs the owner's name) | — | — | wait; then validated assignment → new dry-run → approval → backfill |
