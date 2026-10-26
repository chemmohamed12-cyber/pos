# Vehicle Driver Workspace — Separate Expense Float: design (before implementation) — 2026-10-26

Approved policy (CTO): driver expenses are funded **only** from a separate expense float; customer collections are never used, netted or consumed by expenses; remittance of collections is unchanged; no net remittance, no netting journal.

## 1. Model — what a "float" is
A float is an ordinary **Treasury account** (type `cash`, the account Accounting maps to its own petty-cash / driver-advance GL account) that is *assigned to a vehicle* as its **expense float account**. No new account type, no new ledger, no GL account invented here. It is distinct from the vehicle's `custodyAccountId` (customer collections); the service refuses an assignment that equals any collection custody account, any settlement account, or another vehicle's float.

| Aspect | Mechanism (all existing) |
|---|---|
| **Assign to a vehicle** | `POST /shipments/vehicles/:id/expense-float` `{ treasuryAccountId \| null }`, permission `logistics.vehicle.edit`. Validations (fail closed): account exists, active, **GL-mapped**, type `cash`, not a collection custody / settlement account of any vehicle or shipping company, not another vehicle's float. Audit `shipment.vehicle.expense_float_set`. Unassigning is refused while the float has a non-zero balance or any claim is pending/approved. |
| **Fund** | An ordinary Treasury **transfer document** (T3: prepare → separate approver → explicit execute) from a company cash/bank account **to** the float account. The existing approval + posting controls apply; the GL effect is the Treasury transfer's own (Dr float account's mapped GL / Cr source's mapped GL). Nothing in Delivery posts funding. |
| **Replenish** | The same transfer document again (a new, separately approved document each time). There is no automatic top-up. |
| **Return unused float** | A transfer document in the opposite direction (float → company account). |
| **Claim an expense** | As C3: category must be a mapped `custody_*` reason of the disbursement posting profile; **additionally** the shipment's vehicle must have a float assigned and GL-mapped. Claim does not move money. |
| **Approve** | FA-01 engine, separate approver for **every** expense (maker ≠ checker, live `finance.cash_document.approve` check). |
| **Post (disburse)** | Explicit Treasury cash-out **from the float account** (balance check under the Treasury per-account lock, Financial Event, journal Dr expense (reason→account map) / Cr float account's mapped GL). If the float does not cover it the post is refused and the expense stays approved. It can never touch the collection custody account. |
| **Reverse** | A posted expense can be reversed by someone with `finance.cash_document.reverse` and a reason: Treasury owner-reversal with the same posting-profile counter (append-only offsetting leg + reversal journal); expense status `reversed`, original kept. |
| **Reconcile** | Server-side, per vehicle: float balance (Treasury ledger) vs expected = transfers in − transfers out − posted expenses + reversed expenses; the difference is a flag, not a verdict. Pending / approved-not-posted claims are shown as commitments against the available float. |

## 2. Separation from collections (the invariant)
- Expense posting reads and writes **only** the float account. A spec asserts that after any expense activity the collection custody balance, the collections' remittance state and the customer ledger are byte-identical.
- The custody reconciliation (collections / handovers) no longer subtracts expenses. `cashInDriverHand = counted collections − handovers`; `expectedCustodyAccountBalance = counted − remitted`. Expenses appear in their own **float block**.
- The C4 coupling "an expense may not take cash below what was handed over" is removed (no longer meaningful).
- Remittance (`remitCollection`) is untouched: gross, per collection, the only GL trigger.

## 3. Fail-closed list
Missing float assignment; float account inactive / not GL-mapped / wrong type; category unmapped; custody-expense approval permission missing; float balance insufficient; float equals a collection custody or settlement account. Each refuses with a specific message and records nothing.

## 4. Audit trail
Assignment, claim, approval/rejection (approval engine records), posting, reversal, cancel — all audited with actor and amounts; funding/replenishment/return are Treasury documents with their own full lifecycle audit. Treasury ledger legs are append-only.

## 5. Schema (additive; feature unreleased, so the C3 table is corrected in place rather than patched)
- `vehicles.expenseFloatAccountId UUID NULL` (new migration `1790040400000`).
- `custody_expenses`: `custodyAccountId` → `floatAccountId` (it never is the collection custody account), status gains `reversed`, columns `reversedByUserId/reversedAt/reversalReason/reversalTransactionId`. Migration `1790040200000` is edited in place (unreleased; isolated verification DBs re-created).

## 6. Explicitly not done
Automatic funding rules, per-driver (rather than per-vehicle) floats, float limits/policies, any net remittance. These need separate decisions.
