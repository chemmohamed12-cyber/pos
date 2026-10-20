# Treasury program — T2 gate report (payment reversals & financial authorization) — 2026-10-20

Branch `feature/treasury-integrity`; T1 = `c60a115`. Tests ran on disposable databases on the dedicated cluster 127.0.0.1:5546 (namespace `biz_t65_`/`biz_t66_`), coordinated with the Procurement session (it held 5546 before; the two runs never overlapped).

## 1. Scope delivered / not delivered

| Item | Status |
|---|---|
| T2.1 Reversal ownership — Treasury refuses a raw reversal of a leg owned by a customer payment, supplier payment, deposit, payroll run or COD collection (`findOwningDocument`; reversal rows inherit the owner) | **Done** |
| T2.1 Customer payment reversal through the owning document (`PaymentsService.reversePayment`): one transaction — owner-driven Treasury offset leg (`TreasuryService.reverseOwnedLeg`, no event of its own, refuses an unfundable refund), `payment_reversal` Customer-Ledger debits mirroring wherever the credit(s) currently sit (unapplied / on an invoice / split by an application), mirror GL event `finance.payment.reversed` (Dr AR / Cr the account's mapped GL, published through the T1 publish guard), invoice re-opened, one-per-payment `customer_payment_reversals` row (UNIQUE `paymentId`), audit | **Done** |
| Invoice status correction — sales-invoice process gains `paid→partially_paid`, `paid→posted`, `partially_paid→posted`; `InvoiceService.resyncStatusAfterReversal` derives the status from the remaining balance | **Done** |
| T2.1 Supplier payment reversal | **Not done — blocked by external dependency (see §5)** |
| T2.1 Partial refund as a separate document | **Not done** — deferred to T3 (document layer); not required for full reversal |
| T2.2 Separate permissions | **Done** for the treasury/payment actions that exist: `finance.cash.post/transfer/reverse/view`, `finance.cash_account.manage`, `finance.cash_account.mapping.manage`, `finance.payment.reverse` (manifest + controllers). All inherit from `finance`, so **no existing role gains or loses access**; a more specific grant now wins. Approve / execute / reconcile / redrive nodes belong to T3 (documents) and T5 |
| T2.2 Approval engine / maker-checker on movements | **Not done** — belongs to T3 (needs the document layer; thresholds are an owner policy [U]) |
| T2.3 Idempotency | **Partly**: client-generated key per form on the Treasury ledger screen (kept across a failed attempt, regenerated after success/mode change); server correctness does not depend on the header (UNIQUE `paymentId`, locked state checks — proven by the 5-concurrent-reversal test). Server-side enforcement mode (`warn`→`enforce`) is **not built** (needs a measurement window; owner decision on enforcement date) |
| T2.4 Transitional cash entry — generic cash-in/out stay compatible but refuse a customer/sales-order label (422, points to the customer payment flow) and require a reason (≥3 chars) and a reference; every call is audited with `direct: true` for the caller inventory | **Done** (the caller inventory itself and any removal remain open) |

## 2. Files (impact)
Backend: `treasury.service.ts` (ownership guard, `reverseOwnedLeg`, audit flag), `treasury.controller.ts` (granular nodes, generic-cash rules), `payments.service.ts` / `payments.controller.ts` (reversal), `invoices.service.ts`, `sales-invoice-process.ts`, `customer-ledger-entry-type.ts`, `finance.contract.ts`, `ar-events.contract.ts`, `finance-handlers.ts` (`handlePaymentReversed`), `handler-registry.ts`, `financial-event.service.ts` (topic/domain/guard), `finance.manifest.ts`; new: `customer-payment-reversal.entity.ts`, migration `1790030000000-CreateCustomerPaymentReversals.ts` (additive, empty table, down drops it), 3 specs. Frontend: `lib/api.ts` (idempotency key), `TreasuryLedger.tsx` (key, required reason/reference), `lib/displayNames.ts`.

## 3. Verification (actual runs)
- **Regression**: `REGRESSION_NS=biz_t66_ node tools/testing/biz-run.js --regression <24 specs>` → **`REGRESSION DONE: 24/24 passed`, 185 tests, 0 failed/skipped** (log `evidence-treasury-integrity-2026-10-20/20-T2-final-regression.log`). The 24 = the 21 prior specs + integrity + recovery + the new reversal spec. These specs also execute the **new migration** on freshly migrated company databases.
- **New real-PG spec `payment-reversal.company-isolation.spec.ts` — 7 tests**: R1 partial payment reversed: Treasury 300→0, invoice 600→900 remaining, status back to `posted`, GL bank 300→0 and AR −300→0, original Treasury leg `reversed` + linked, events `recorded:POSTED` then `reversed:POSTED`, Company B unchanged · R2/R3 `paid→posted`; reversing one of two payments leaves `partially_paid` · R4 second reversal refused, **5 concurrent reversals → exactly 1 reversal row/1 Treasury leg/1 journal** · R5 raw Treasury reversal of the payment's leg refused with "belongs to customer payment PAY-… reverse it through that document", zero change · R6 on-account receipt reversed unapplied; after a partial application both buckets reversed and the invoice re-opens · R7 closed period, blank reason, and an account that spent the money are all refused with a zero-side-effects fingerprint · R8 reconciliation: payment-related AR ledger movement == GL AR, all journals balanced, no non-POSTED event, every `finance.payment.reversed` has its reversal row.
- **Unit** (database-free mode, added to `tools/testing/unit-specs.txt`): `treasury-permissions.spec.ts` 13 (each route → its node, nodes declared in the manifest, destructive nodes not `low`), `treasury-generic-cash.spec.ts` 5 (422/400 before anything runs); existing permission/navigation/module-registry/plans/authorization suites re-run: 14 suites / 89 tests pass.
- `tsc --noEmit` (backend), `tsc -b` (frontend), backend `eslint` on all changed files: clean. Frontend has no eslint config in this worktree (not run).
- **Not tested**: controller-level HTTP authorization with real roles (the specs call services and inspect route metadata); the UI in a browser (T4/T7); the idempotency header end to end through the new reversal route.

## 4. Defects found and closed in this phase
| Defect | Closure |
|---|---|
| My scripted edit of the controller decorators wrote control characters over eight route decorators (compile error caught by the unit run) | restored from the known route list; `git diff` shows only the permission lines changed |
| Raw Treasury reversal of a payment leg booked the offset to the clearing account (G-06b) | guard + owner-driven reversal; R5 |
| Sales invoice workflow could not leave `paid` | new transitions; R2/R3 |

## 5. External dependency (documented blocker, work continued)
Supplier-payment reversal must act on Procurement's allocation model (`supplier_payment_allocations`, one payment over several invoices; migration `1790020100000` on `feature/procurement-invoicing-allocations`) and needs the supplier-invoice workflow to leave `paid`/`partially_paid`. That branch is **not** in the integration line and has no ETA (its merge and the `daii_dev` migration need owner approval); the Procurement session asked that the reversal be built **after** the merge, in a new file `supplier-payment-reversal.service.ts`, without editing `supplier-payment.service/controller`, `supplier-payment-allocation.entity`, `supplier-invoice-process.ts`, `supplier-invoice.handler.ts`. Prepared on our side and already working for them: publish-time guard on `finance.supplier_payment.recorded`, `TreasuryService.reverseOwnedLeg`, ownership guard for supplier-payment legs (via `supplier_payments.treasuryTransactionId`), `finance.payment.reversed`'s supplier twin to be added with the service. **Minimum decision to resume:** the owner's approval to merge the Procurement branch into the integration line (or an agreed interface change); then ~1 session of work: process transitions `reopen_partial/reopen` agreed once, reversal service, handler `finance.supplier_payment.reversed` (Dr bank / Cr AP), spec mirroring R1–R8.

## 6. Residuals / classification
1. Approval of reversals (maker-checker) and threshold matrix: **T3**, owner policy [U] (company × type × amount × currency; no amounts invented).
2. Server-enforced idempotency mode: T3/T4 with a measurement window; owner chooses the enforcement date.
3. `finance.payment.reverse` is `sensitive` by the verb rule, not on the `CRITICAL_NODES` list (changing that list changes a counted Authorization-Blueprint policy; recommendation recorded for the owner).
4. Existing roles that hold `finance` editable can reverse payments by inheritance (same set that could previously reverse any treasury leg); narrowing is an owner action using the new nodes. No role template was changed.
5. Deposit and COD reversal remain unavailable by design (their legs are owned; a reversal flow for them is not in this phase).

## 7. Decision
**Gate T2: PASSED for the customer side and all items deliverable without Procurement's branch; the supplier-reversal item is recorded as blocked-by-dependency, not as done.** Proceeding to T3 (document layer, customer multi-invoice allocation and receipts/transfers/deposits workflows; supplier allocation reuse waits for the same merge).
