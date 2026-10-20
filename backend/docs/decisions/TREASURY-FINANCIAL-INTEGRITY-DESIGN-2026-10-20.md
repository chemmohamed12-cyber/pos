# DAII Treasury — focused financial-integrity design (G-03, G-04, G-05, G-06, G-12, G-16) — 2026-10-20

**Status:** DESIGN PROPOSAL for CTO review. Gate 0 = accepted as preliminary; Gate 1 = pending. **No code, schema, migration, data query, merge, release or deployment has been done or is authorized.** Companion files: `TREASURY-PAYMENTS-GATE0-AUDIT-AND-PROPOSED-ARCHITECTURE-2026-10-20.md` (audit) and `TREASURY-INTEGRITY-READONLY-CHECKS-2026-10-20.sql` (read-only SQL, **not executed**; see §9 for the target approval request).

Tags: **[E]** existing behaviour (cited) · **[P]** proposal · **[U]** unresolved owner policy.

---

## 0. What this pass found (beyond the first report) — read this first

Reading the event bus and Financial-Event service changed the shape of the fix. Four facts, all from code:

1. **[E] Inline (same-transaction) dispatch already exists.** `EventBusService.dispatchPending` with a manager whose transaction is active runs `dispatchInline` (`foundation/events/event-bus.service.ts:128,169`); `dispatchAfterCommit` deliberately returns early in that case (`:104`). The Financial-Event handler path is already "ONE transaction: handler → draft → post" (`financial-event.service.ts:240`, ADR-041 D18a). So a treasury movement *can* be posted to the GL in the same database transaction without a second posting mechanism.
2. **[E] A REJECTED event is not an exception.** `ingest` returns `{status:'REJECTED'}` after `mark(...)` (`financial-event.service.ts:315-328`); nothing throws. Today every treasury UI path commits first and dispatches after (`treasury.controller.ts` `cashIn/cashOut/transfer`: `withIdempotencyInTransaction` → then `dispatchAfterCommit`). That is exactly the G-03 window.
3. **[E] A re-drive exists** — `FinancialEventService.redrive` (`:208`), `POST general-ledger/financial-events/:id/redrive` — idempotent (POSTED short-circuits; the idempotency key is unique). Recovery is not greenfield.
4. **NEW finding G-06b (from code reading, not reproduced):** `TreasuryService.reverseTransaction` always publishes its offsetting event with `emitGlEvent: true` and **no counter account** (`treasury.service.ts` reverse block → `emitCashRecorded`), and `handleCashRecorded` then books the offset to the **clearing** account (`finance-handlers.ts:287-296`). For a leg that belongs to a customer payment (original GL: Dr bank / Cr `ar`), a reversal of that leg therefore posts **Dr clearing / Cr bank**, leaving the AR credit in place, the payment row, customer-ledger entry and invoice status untouched, and parking the debit in clearing. The same applies to supplier-payment, deposit, COD-custody and payroll legs. The controller (`POST /treasury/transactions/:id/reverse`) has no check that a leg is owned by another document. SQL probes Q4/Q6 test whether this has actually happened in a given database.

Also noted (existing, by design, from the D2 record): **payroll disbursement's cash leg posts no bank GL**, so Treasury ≠ GL for payroll by construction. That is an accounting-policy decision (R1 request still PENDING), not something this design silently fixes; Q3 will show its size.

---

## 1. Design principles for the integrity phase [P]

1. **One posting mechanism.** All GL effects continue to flow Treasury/owner → outbox publish → Financial Event → handler → journal. Nothing new posts journals.
2. **A money movement and its GL effect succeed or fail together** for every path *whose GL owner is the movement itself* (direct cash, transfer, customer/supplier payment).
3. **Reject before mutate.** Validate date, period, mapping and counter-account *before the first write*, under the account lock.
4. **Whoever owns the GL story owns the reversal.** Treasury never reverses a leg that another document owns.
5. **Idempotency by state, not by header.** The header remains a client convenience; correctness comes from locked state-machine checks and unique keys.
6. **Additive and flag-controlled.** Behavioural tightening ships behind a per-company switch with a shadow stage; no endpoint signature changes in this phase.

---

## 2. G-03 — Pre-mutation validation and atomic posting

### 2.1 Pre-mutation preflight [P]
Treasury cannot import Accounting (`AccountingModule` imports `TreasuryModule`; D2 record). Use the existing contract pattern in `foundation/module-registry/contracts`:

`FINANCE_POSTING_PREFLIGHT_CONTRACT.check({ businessDate, orgUnitId, bankGlCodes[], counter: { code? | configKey? } })` → `{ ok } | { ok:false, code, message }`, implemented in Accounting by reusing what already exists:
- fiscal period open for date/org unit: `FiscalPeriodService.assertOpenForPosting` (`journal-entry.service.ts:352`) in a non-throwing form;
- bank GL code exists, active, postable: same lookups as `resolveBankLeg`;
- clearing/counter account configured and postable: `FinancialEventService.preflightConfiguredPostableAccount` **[E]** (`financial-event.service.ts:354`).

Called inside the movement transaction, after the account advisory lock and before `insertLeg`. Failure → HTTP 409/422 with an actionable message (which period is closed, which account is unmapped, which config key is empty), nothing written, no outbox row.

### 2.2 Atomic posting for self-owned GL effects [P]
After `events.publish(m, topic, payload)` inside the same transaction:

```
const r = await events.dispatchPending(1, m)      // inline path, [E] dispatchInline
const fe = await financialEvents.getByIdempotencyKey(key, m)   // read-only helper, proposed
if (fe.status !== 'POSTED') throw new ConflictException(fe.rejectionReason)   // rolls back leg + event + outbox
```
Result: the leg, the Financial Event row, the journal and the audit insert commit or roll back as one unit; no REJECTED row survives to be drifted against (invariant 4). Failed attempts are still audited through a separate non-transactional audit write ("rejected attempt").

Open technical points, to be settled by a spike under real PostgreSQL **before** any commitment (all [U] until proven):
- `ingest` opens `manager.transaction(...)` internally; confirm TypeORM nests these as savepoints on the caller's query runner and that a throw after `mark('REJECTED')` leaves no REJECTED row.
- Lock ordering: treasury advisory lock (`treasury:{id}`) is taken before the journal-numbering/ledger locks; confirm no inversion against the existing deadlock-retry (`MAX_POSTING_ATTEMPTS`).
- Latency: one extra journal insert per movement inside the request.

### 2.3 What stays asynchronous [P]
Paths whose GL is owned downstream stay as they are — deposit (`deposit.verified`), COD (`collection.remitted`), payroll — but gain preflight (§3) and the safety net in §2.4.

### 2.4 Safety net and recovery for anything that still ends REJECTED [P]
Causes that can still occur after a successful preflight: period closed between check and dispatch (async paths), chart change, handler defect.

| State | Detected by | Action | Guarantee |
|---|---|---|---|
| Treasury leg without POSTED event | **Posting-exceptions read model** = the logic of SQL Q1 as a service/report (no schema change; derived on demand) | Visible queue with cause, age, amount | No hidden drift |
| Event REJECTED/RECEIVED/MAPPED | same + `GET financial-events?status=REJECTED` **[E]** | After fixing the cause: `redrive` **[E]** | Idempotent: unique `idempotencyKey`, POSTED short-circuit; no second journal, no second leg |
| Outbox `failed` (retries exhausted) | Q1c | Operator re-queue (proposed admin action; not built) | Dead letter is visible, never silent |
| Redrive blocked by now-closed period | rejection reason | **[U]** options: (a) reopen period under the existing close controls; (b) post in next open period via a *linked* adjustment document. The system must not silently re-date to "today" | Original business date preserved |
| Treasury vs GL drift | existing `CashBankReconciliationService` runs **[E]** + scheduled run [P] | Exception report, owner-approved adjustment via existing FA-01 flow **[E]** | Drift is explained or escalated |

Recovery never edits or deletes a posted ledger row, journal or event.

---

## 3. G-04 — No treasury movement on an unmapped account without a defined GL owner

Today the D2 guard `requireGlMappedAccount` runs only in customer/supplier payment services **[E]**. Direct cash, transfer, deposit and the other contract callers can move money on an unmapped account; the event is simply not published (`emitCashRecorded`/`emitTransferCompleted` return early when unmapped).

**Rule [P]:** every treasury write declares a `glOwner`:

| glOwner | Meaning | Mapping requirement |
|---|---|---|
| `self` | Treasury publishes the GL event (direct cash, transfer) | bank code mapped **and** chart-valid, all accounts of the movement (both for a transfer), checked by preflight; never "skip the event if unmapped" |
| `owner_event` | A downstream event posts it (customer/supplier payment now; deposit, COD remit) | mapped & chart-valid at write time (extends D2 to deposits/COD, which today fail only after commit) |
| `none_by_policy` | Payroll disbursement cash leg today | **[U]** blocked pending accounting-policy decision; until then the leg stays as-is and is reported (Q3), not changed |

The silent `if (!account.glAccountCode) return` branches are removed in the same step, making "moved money, no GL effect" unrepresentable for `self`/`owner_event`.

Existing data: unmapped accounts that already carry movements are **reported by Q1/Q2 and not repaired** here.

---

## 4. G-05 — Permissions and segregation of duties

Today one node, `finance:editable`, gates account creation, GL mapping, cash-in/out, transfer, reversal and status changes **[E]** (`treasury.controller.ts:134-284`). Customer payments use `finance.payment.create`; supplier `procurement.supplier_payment.create`; adjustments already use `accounting.cash.{view,create,adjust,approve}` **[E]**.

### 4.1 Proposed nodes [P] (names provisional, to be aligned with the Authorization Blueprint)
`treasury.account.manage` · `treasury.account.map_gl` · `treasury.movement.prepare` · `treasury.movement.approve` · `treasury.movement.execute` · `treasury.movement.reverse` · `treasury.reconcile` · `treasury.exception.redrive`. Customer/supplier flows add `…payment.reverse` / `…payment.approve`.

### 4.2 Matrix (ordinary roles; SoD constraints are server-enforced in the approval engine, which already supports min-approvers and approver ≠ maker **[E]**)
| Action | Prepare | Approve | Execute | Reverse | Reconcile | SoD rule |
|---|---|---|---|---|---|---|
| Customer collection | `payment.create` | threshold only [U] | preparer (under limit) | `payment.reverse` + approval | `treasury.reconcile` | approver ≠ preparer |
| Supplier payment | `supplier_payment.create` | `…approve` | `…execute` | `…reverse` + approval | reconcile | approver ≠ preparer; executor ≠ approver above threshold [U] |
| Transfer | `movement.prepare` | `movement.approve` | `movement.execute` | `movement.reverse` + approval | — | approver ≠ preparer |
| Direct cash in/out (transitional, §6) | prepare | **always** approve | execute | reverse + approval | — | approver ≠ preparer |
| Account master / GL mapping | `account.manage` | second approver [U] | — | — | — | mapping changer ≠ any movement role holder [U] |
| Re-drive posting | — | — | `exception.redrive` | — | — | audited, reason required |

Thresholds are a **per-company configuration matrix (company × type × amount × currency)**; no number is invented here **[U]**. Platform roles never imply these nodes (F4 PlatformGuard **[E]**). Compatibility: a migration seeds the new nodes onto every role that holds `finance:editable` today (behaviour-preserving), then the owner tightens — separate approved step.

---

## 5. G-06 — Linked payment reversal (AR/AP, treasury, GL together)

### 5.1 Rules [P]
- `reverseTransaction` **refuses** a leg owned by a customer payment, supplier payment, deposit, COD collection or payroll run (409: "reverse through the owning document"). Direct-cash and transfer legs remain reversible there.
- New owner reversal services — `PaymentsService.reversePayment`, `SupplierPaymentService.reversePayment` — each in **one** transaction: lock payment, invoice and treasury accounts (sorted); verify not already reversed; verify no applications outstanding (on-account payments with `payment_application` rows must be un-applied first, or reversed in the same unit — [U] which); preflight the reversal date/period; write the **mirror subledger entry** (append-only; entry type to be confirmed against the ledger's allowed types before design freeze); write the treasury offset leg via a non-emitting internal call; publish **one owner-specific mirror event** carrying `reversalOf` and its own idempotency key; recompute invoice status; audit.
- Atomic posting per §2.2 (the mirror event must be POSTED or the whole reversal rolls back).
- Partial reversal / refund of part of a payment: [U], proposed as a separate document type (refund) rather than an in-place edit.

### 5.2 Debit/credit matrix (roles, not account numbers; all from existing handlers unless marked)
| Transaction | Debit | Credit | Subledger effect | Source |
|---|---|---|---|---|
| Customer payment against invoice | bank (treasury account's mapped GL) | `ar` control | AR credit, invoice remaining ↓ | `handlePaymentRecorded` [E] |
| On-account customer receipt (CUS-01 Option 1) | bank | `ar` control | unapplied credit in customer ledger | [E] |
| Apply on-account receipt to invoice | — (no GL) | — | ledger: debit unapplied / credit invoice | [E] |
| **Reversal of customer payment** | `ar` control | bank | mirror ledger entry; invoice status recomputed | **[P]** (mirror of the above; today's treasury reverse books clearing instead — G-06b) |
| Supplier payment | `ap` control | bank | AP debit, supplier-invoice remaining ↓ | `handleSupplierPaymentRecorded` [E] |
| **Reversal of supplier payment** | bank | `ap` control | mirror AP entry; invoice status recomputed | **[P]** |
| Direct cash-in | bank | clearing (configured) | none | `handleCashRecorded` [E] |
| Direct cash-out | clearing | bank | none | [E] |
| Reversal of direct cash movement | opposite of original | opposite | none | `reverseTransaction` [E] (correct for this type) |
| Transfer A→B | B bank | A bank | none | `handleTransferCompleted` [E] |
| Reversal of transfer | A bank | B bank | none; both legs together | [E] |
| Deposit verified | bank | `ar` control | unapplied credit | `deposit.verified` [E] |
| Bank fee / interest / opening balance / write-off | per FA-01 request type, maker-supplied contra | | none | `CashBankAdjustmentService` [E], approval-gated |
| Payroll disbursement cash leg | **none posted today** | | employee/payroll | D2 record [E] — **[U] policy** |

Exceptions: reversal in a closed period → §2.4 row 4 [U]; reversal of a payment whose invoice was later credit-noted → blocked, requires the credit-note flow first [P]; foreign currency → out of scope while the system is EGP-only (§8).

---

## 6. C — Transaction-entry policy (transition without breaking callers)

- **No endpoint is removed or changed in signature** in this phase [per directive].
- `POST /treasury/cash-in|cash-out` stay but become **restricted transitional**: (1) preflight + atomic posting (§2); (2) `customerId`/`salesOrderId` supplied → 422 pointing to the customer-receipt flow, because a customer label with no AR effect is misleading (G-02); (3) `reason` and `reference` mandatory, with a controlled reason list; (4) always routed through approval once the approval wiring exists, otherwise gated by the new execute node; (5) usage logged, so removal can be decided on data. Contract callers (`FinanceTreasuryContract.cashIn/cashOut/transfer`) are untouched.
- Purpose-specific workflows (customer collection, supplier payment, transfer, bank deposit, misc receipt, disbursement, adjustments) are specified in the audit document §4 and are **Phase T2**, not part of the integrity phase. The Treasury Workspace screen is deferred until T1 acceptance, per the directive.
- Deprecation/removal of the generic endpoints needs its own reviewed transition plan (callers inventory from the usage log) [U].

---

## 7. G-12 — Idempotency on every financial mutation path

Current [E]: treasury UI routes use `withIdempotencyInTransaction` with an **optional** header (`treasury.controller.ts:198-250`); the Treasury ledger page sends none (`TreasuryLedger.tsx:118-120`). `Payments`/`supplier-payment` rely on invoice-remaining under advisory lock **[E]**, which protects against over-payment but not against two *identical valid partial* payments.

Proposal:
| Layer | Mechanism |
|---|---|
| State-machine (correctness) | Documents (T2) execute via a locked status transition; double-submit finds the new state. For the integrity phase: reversal is guarded by locked status check **[E]** (reverse) and by a unique `reversalOf` key per leg/payment **[P]** |
| Header (client dedup) | UI generates one key per form instance; server stores key + request hash + response in the same transaction **[E mechanism]**. Same key + different body → 422 |
| Enforcement | New per-company flag `treasury.require_idempotency_key`: `off` (today) → `warn` (log + metric of keyless requests) → `enforce` (400 without header). Rollout is a separate approval; UI is updated first |
| Event level | Financial Event `idempotencyKey` unique **[E]**; every new owner event gets a deterministic key (`…:{documentId}:reversed`) |
| Partial-duplicate guard | Optional soft warning when the same user posts the same account/amount/reference within a window — advisory only, never blocks [P] |

---

## 8. D — Enterprise architecture adjustments

- **Currency:** EGP is hard-coded in treasury/payment events [E, G-11]. No permanent EGP assumption: events take the company base currency (already resolvable via `CurrencyService.getBaseCurrency`, used as the ingest default **[E]**); account currency becomes an attribute in T2. Multi-currency scope [U] — requirements to be gathered before FX design.
- **POS / cash drawer:** target-architecture hooks defined now, built later (separate phase): a *custody account* type (already a seeded Treasury account type **[E]** migration `SeedTreasuryCustodyAccountType`), a `cash_session` document (open float → movements → count → close) whose close produces a variance document and a settlement transfer to the safe/bank through the same document layer; POS sales settle to custody accounts via `owner_event` `glOwner`. No POS code is written or promised in T1.
- **Payment lifecycle boundaries [P, unresolved timing]:** three independent tracks per payment — (1) *operational execution* (draft → approved → executed/sent → confirmed/rejected/returned), (2) *accounting recognition* (liability settled, journal posted/reversed), (3) *bank settlement* (statement-matched/reconciled). A state in one track never implies another. When track 2 fires (at execute vs at bank confirm) depends on the payment instrument (cash, transfer, cheque, wallet) and is **not decided** until the instrument semantics are known (R1 request) **[U]**.

---

## 9. B — Read-only data investigation: request for target approval

The SQL (`…-READONLY-CHECKS-….sql`) runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, has a 60 s statement timeout, and contains no DML/DDL. Query map:

| Query | Answers |
|---|---|
| Q0 | Schema probe — proves every assumed column exists before anything is trusted |
| Q1 / Q1b / Q1c | Treasury legs whose expected Financial Event is missing, REJECTED, or stuck; outbox dead letters |
| Q2 | Accounts with no valid GL mapping and their movement footprint |
| Q3a / Q3b | Treasury vs GL balance per GL account code; daily net for timing |
| Q4 | Clearing-account balance and originating transactions, aged (G-01, G-02, G-06b evidence) |
| Q5 | Stop-condition probes: unbalanced journals, header/line mismatch, POSTED event without journal, duplicate journals per event |
| Q6 | Payments whose treasury leg was reversed directly (G-06 evidence) |

Honest limits: the COD custody → collection linkage and the exact outbox topic names for deposit/COD were not verified against schema (Q0 and a short manual check will); fiscal-period state is derived (no status column) so period-closed rejections are read from event `rejectionReason`, not computed.

**Approval I need before executing anything:**
1. **Exact target** (host, port, database name, and whether it is a disposable restore). Recommended: a fresh restore of `daii_dev` and one company DB; I will not touch the shared cluster in use by another session.
2. Confirmation that scope is the read-only script as written (one Company DB per run), and that production/hosted data is excluded.
3. Where the output may be stored (suggested: `backend/docs/decisions/evidence-treasury-integrity-2026-10-20/`, untracked).

Any non-zero Q5 result, off-GL movement, or unexplained Q3 drift triggers an immediate stop-and-report; nothing is repaired or re-driven.

---

## 10. G-16 — Verification matrix (real PostgreSQL, disposable databases only)

| # | Scenario | Type | Must assert |
|---|---|---|---|
| V1 | Direct cash-in with date in a closed period | real-PG A/B | 409; zero rows in `treasury_transactions`, events, journals, outbox, audit-success; company B untouched |
| V2 | Clearing account unset / not postable | real-PG | rejected before write; no leg |
| V3 | Unmapped account: cash-in, cash-out, either side of transfer, deposit, COD custody | real-PG | rejected (or reported per §3 policy); zero side effects |
| V4 | Failure injection: handler throws / `postEntry` gate rejects after preflight | failure-injection | whole unit rolled back; no REJECTED event row; balance unchanged |
| V5 | Failure injection: crash between publish and commit (kill connection) | failure-injection | no partial state; retry with same key succeeds once |
| V6 | N concurrent identical requests, same key | concurrency | exactly one leg, one journal; others return the stored response |
| V7 | N concurrent identical requests, **no** key (flag `warn`) | concurrency | documents behaviour; with `enforce` → 400 |
| V8 | Concurrent reversal of the same payment | concurrency | one reversal; second 409; no double GL |
| V9 | Reverse customer payment | real-PG + reconciliation | AR ledger, invoice status, treasury balance, GL `ar` and bank all return to pre-payment values; Dr=Cr; `reversalOf` set; original rows intact |
| V10 | Reverse supplier payment | same | same on AP |
| V11 | Reverse a payment leg via `POST /treasury/transactions/:id/reverse` | real-PG | 409, nothing changes (guards G-06b) |
| V12 | Reverse payment that has applications / later credit note | real-PG | blocked with explanation |
| V13 | Self-approval / insufficient permission on each new node | auth | 403, no mutation, audit of denial |
| V14 | Redrive REJECTED event after fixing cause; redrive twice | real-PG | one journal; second call dedups |
| V15 | Cross-company ids (account, invoice, payment) | isolation A/B | 404/403; no cross-DB access |
| V16 | Treasury ↔ GL ↔ AR/AP reconciliation after each scenario | reconciliation | drift 0 |
| V17 | Existing suites re-run: `treasury*`, `payments*`, `supplier-payment*`, `t05/t06/t08`, bank-leg specs | regression | unchanged |

All scenarios assert: document/leg status, journal balance, subledger effect, account balance, idempotency, audit history. Each runs on its own disposable database; before any run, check the shared cluster is idle.

---

## 11. Migration, compatibility and rollback

- **Schema:** none required for T1a–T1c (preflight, atomic posting, reversal guard, mapping guard use existing tables). T1d (permission nodes) is a data seed; the posting-exceptions model is a query. Any new column/table waits for a separately approved migration.
- **Behaviour switches (per company):** `treasury.sync_posting` (`off` → `shadow`: run preflight and *log* what would be rejected, change nothing → `enforce`); `treasury.require_idempotency_key` (`off`/`warn`/`enforce`). Rollback = set to `off`; no data change to undo.
- **Backward compatibility:** endpoint signatures, response shapes, contract methods (`FinanceTreasuryContract`) unchanged; new refusals return 409/422 with explicit messages. The Treasury UI gets only the minimum change (send idempotency key; show new messages) and can be shown on the existing preview without merging.
- **Historical data:** untouched. Rows flagged by Q1–Q6 are reported to the owner; correction (if any) is a separately approved, linked-adjustment step.
- **Rollback limit:** once a mirror reversal is posted by the new flow it is a real accounting event and is corrected forward, never deleted.

---

## 12. Phased plan and acceptance criteria (nothing authorized yet)

| Phase | Content | Acceptance |
|---|---|---|
| **T0** (read-only) | Execute approved SQL on approved target; report totals; 1–2 day spike of §2.2 on a disposable DB | Report with reconciliation totals; spike result: nesting + lock-order proven or design revised |
| **T1a** | Preflight contract + mapping/`glOwner` guard (G-03 pre-mutation, G-04), shadow mode first | V1–V3 pass; shadow log shows zero unexpected rejections on the target |
| **T1b** | Atomic posting for `self` paths; posting-exceptions model; redrive runbook | V4, V5, V14 pass; V16 drift 0 |
| **T1c** | Reversal guard (G-06b) + linked customer/supplier payment reversal | V8–V12 pass with three-way reconciliation |
| **T1d** | Permission nodes + SoD; idempotency flag `warn`→`enforce` plan; transitional restrictions on generic cash-in/out | V6, V7, V13 pass; usage log produces caller inventory |
| **T2** | Document layer, taxonomy, allocations, Treasury Workspace (preview first) | separate Gate 1 package |
| **T3+** | Bank statements/matching; POS & cash sessions; payment batches & lifecycle; FX | separate gates |

---

## 13. Gate 1 deliverable tracker (CTO list E1–E10)

| # | Deliverable | State |
|---|---|---|
| 1 | Evidence-backed gap matrix | Delivered (audit doc §1,§3) + this doc §0 (G-06b added) |
| 2 | Read-only data results | **Blocked** — awaiting target approval (§9) |
| 3 | Lifecycle diagrams | Partial: integrity flows in §2/§5; document lifecycle in audit §4.4; diagrams to be drawn after the spike result |
| 4 | Debit/credit matrix incl. reversals | Delivered for integrity scope (§5.2); remaining T2 types in audit §4.2 |
| 5 | Authorization & SoD matrix | Delivered (§4) — thresholds [U] |
| 6 | Posting-failure & recovery | Delivered (§2.4), pending spike and [U] on closed-period redrive |
| 7 | API / transaction / idempotency contracts | Delivered at design level (§2, §5.1, §7); OpenAPI-level contract after spike |
| 8 | Migration/compat/rollback | Delivered (§11) |
| 9 | Verification matrix | Delivered (§10) |
| 10 | Phased plan | Delivered (§12) |

## 14. Unresolved owner policies introduced or sharpened here
1. Closed-period redrive: reopen vs linked adjustment in next open period.
2. Payroll disbursement cash leg: post bank GL (and where) vs remain off-GL — blocks `glOwner = none_by_policy` closure.
3. Un-apply vs same-unit reverse for on-account receipts with applications.
4. Partial refund as separate document type.
5. Approval thresholds matrix (company × type × amount × currency).
6. Idempotency enforcement date for the UI/API callers.
7. Payment recognition timing per instrument (execute vs bank confirmation).
8. Whether the generic cash-in/out endpoints are ever removed (decide on usage data).
