# DAII — Risk and Technical-Debt Register (Team 3 Independent Product Audit) — 2026-10-11

> **Addendum notice (WP-DOC-02, 2026-10-11).** This document was committed in `2c6ccf3`; its original text is **unchanged**. Evidence that arrived after the audit cutoff `b591d1f`, and the separate finding PA-43, are recorded in the final section titled "Addendum". Where the original and the addendum differ, both are kept: the original describes the state at the cutoff, the addendum the state at `49cc7d5`.

Deliverable 3 of 6. Single source of Finding IDs (`PA-01 … PA-42`) for all six deliverables of directive DAII-TP3-AUDIT-01 and the follow-up request "Final Product Audit Report & Roadmap Inputs". Team 3 is independent and read-only: nothing here is a fix, no product code, schema, UI, permission or configuration was changed, no database-backed test was run by Team 3, and no production or hosting system was accessed.

## 0. Baseline, cutoff and conventions

| Item | Value |
|---|---|
| **Audit cutoff** | 2026-10-11 (repository state read at HEAD `b591d1f`, branch `master`) |
| **Evidence baseline** | `a6002fa` — the last commit with a complete clean-snapshot verification (clean `git archive`, evidence headers pinned, `dirtyPaths: []`, business suite T-00…T-20, 20 isolation specs, unit 59/430, guard 50/50; `evidence-clean-snapshot-2026-10-11/a6002fa/`) |
| **Delta between the two** | Product source changed after `a6002fa` in exactly three ways: (1) N-02 fix of `fulfillReservation` / `fulfillReservationsForOrder` (`a798d9d`, `b591d1f`, `inventory.service.ts`); (2) LA-1 Layer 2 admission (`60b9bdf`: `company-lifecycle-admission.ts`, two schedulers, `installation-audit.controller.ts`); (3) their specs and the T-21/T-22 test registration. Everything else in `backend/src` and `frontend/src` is identical to `a6002fa`. The clean-snapshot pipeline result for the delta is a placeholder (`<<PIPELINE>>`) in the N-02 report §5, so **the delta has no complete clean-snapshot verification** |
| Working tree | Other tracks' untracked release zips and `.err` files; not read as evidence |

**Evidence classes (never merged):** *Clean-snapshot test* (commit-pinned); *Working-tree test, WT* (HEAD at run time plus uncommitted files — historical, not a verification of the commit alone); *Dated manual walkthrough* (`MASTER_PROJECT_STATUS.md`, 2026-08-24, no commit tie); *Static reading by Team 3* (file and line cited); *First-hand* (this author's earlier sessions: `3b5c634`, `246d718`, `7079eae`, `b5a9a85`, `24082d6`, `9da2e54`, working-tree class).

**Nature** (separates confirmed defects from suspected risks): **CONFIRMED-TESTED** (reproduced by a test on a named commit) · **CONFIRMED-BY-READING** (the code fact is exact; the runtime consequence still needs a test) · **SUSPECTED** (reasoned or name-based, not shown) · **MISSING** (capability absent) · **EVIDENCE-GAP** (verification absent or blocked; never counted as a pass) · **DEBT**.
**Class:** security · data integrity · financial correctness · company isolation · architecture · operational · functional · quality · governance.
**Severity** = impact if left as is: High / Medium–High / Medium / Low–Medium / Low. No finding is Critical: Team 3 has no evidence of loss in a deployed environment.
**Confidence:** VERIFIED · INFERRED · UNVERIFIED. **Disposition (scope G):** `NV` implemented–needs verification · `PARTIAL` · `MISSING-REQ` missing but required · `ENH` proposed enhancement · `OOS` out of scope. **Owner** is a proposal, not an assignment.
**N-01 and N-02.** Team 3 does not declare either closed. N-01: the implementing session recorded "CLOSED for the local scope" (`b5dcece`, N-01 report §7) with CTO sign-off pending and explicit exclusions. N-02: "NOT CLOSED" per its own report; only the reservation-fulfil part is remediated.

## 1. Ranked register (severity first, then business impact)

| Rank | ID | Class | Nature | Sev | Domain | One line |
|---|---|---|---|---|---|---|
| 1 | PA-33 | data integrity | CONFIRMED-TESTED | High | Audit | A rolled-back transaction that wrote an audit record permanently breaks hash-chain verification (F-AUD-003, not fixed) |
| 2 | PA-34 | financial correctness | CONFIRMED-BY-READING | High | Payroll/Treasury/GL | Payroll disbursement writes the treasury ledger but publishes no GL event; Wages Payable is never cleared and the GL bank account is never credited |
| 3 | PA-35 | financial correctness | CONFIRMED-BY-READING | High | Payroll/GL | The payroll GL entry posts gross pay only; commission is paid in cash but never recognised as expense or liability |
| 4 | PA-16 | functional | MISSING | High | Payroll | No overtime, tax, insurance or payslip; gross equals net |
| 5 | PA-26 | operational | EVIDENCE-GAP | High | Release | Overall release NOT APPROVED; hosting UNVERIFIED; 1.1.4 incident on record |
| 6 | PA-25 | security | DEBT | High | Dependencies | 65 advisories (3 critical, 44 high); remediation NOT RUN |
| 7 | PA-23 | quality | EVIDENCE-GAP | High | Frontend | Zero automated frontend tests |
| 8 | PA-24 | operational | EVIDENCE-GAP | High | Scalability | Capacity NOT CLASSIFIED; ~31–39 req/s plateau on a 2-core laptop |
| 9 | PA-01 | functional | MISSING | High | Sales | No sales-order cancel after submission; no reactivation on any transactional document |
| 10 | PA-03 | quality | EVIDENCE-GAP | High | Sales/Finance | No automated order-to-cash chain test |
| 11 | PA-17 | quality | EVIDENCE-GAP | High | HR/Payroll | Integrated Attendance→Payroll→Commission→GL E2E is BLOCKED |
| 12 | PA-21 | data integrity | EVIDENCE-GAP | High | Foundation | N-01: PASS on clean `a6002fa`; closure recorded for local scope, sign-off pending; residual by-construction coverage |
| 13 | PA-13 | data integrity | CONFIRMED-TESTED (mitigated) | Medium–High | Accounting | F03 GL-posting deadlock: retry + classification landed, lock-order cure deferred, not re-tested after N-01 |
| 14 | PA-14 | data integrity | SUSPECTED (fix present, unverified) | Medium–High | HR/Accounting | Business-date / timezone class; Commission fix `f2d15fa` exists, regression re-run not recorded |
| 15 | PA-08 | functional | MISSING | Medium–High | Procurement | No supplier return flow |
| 16 | PA-09 | functional | MISSING | Medium–High | Treasury | No bank-statement import or matching |
| 17 | PA-29 | security / company isolation | EVIDENCE-GAP | Medium–High | Authorization | Residuals: F-INV-001 410 compatibility, four controllers without Company guard (inferred), CTO items |
| 18 | PA-41 | company isolation | CONFIRMED-BY-READING | Medium–High | Company lifecycle | LA-1 Layer 2: 3 of 10 sites wired; 7 blocked by foreign files; a path opening a Company DataSource without admission still exists |
| 19 | PA-37 | functional | CONFIRMED-BY-READING | Medium | Attendance/Payroll | Attendance and leave have no financial effect: absences never reduce pay |
| 20 | PA-38 | financial correctness | SUSPECTED | Medium | Commission | Commission is not reversed on invoice void, return or credit (only manual adjustment) |
| 21 | PA-39 | financial correctness | CONFIRMED-BY-READING | Medium | AP/AR | AP/AR adjustments default to a hard-coded account `5299`, recorded as "not an approved policy" |
| 22 | PA-36 | financial correctness | CONFIRMED-BY-READING | Medium | Payroll | Payroll sums money with JavaScript floating point, not the decimal library used elsewhere |
| 23 | PA-10 | financial correctness | CONFIRMED-BY-READING | Medium | Accounting | Year-end close is a status lock; no closing entries |
| 24 | PA-04 | data integrity | CONFIRMED-TESTED → fixed in code | Medium | Inventory | `fulfillReservation` double dispatch: fixed (`a798d9d`/`b591d1f`), verified by implementing track, N-02 not closed, no clean-snapshot of the delta |
| 25 | PA-05 | data integrity | CONFIRMED-TESTED | Medium | Foundation/Inventory | Limit cap overshoot; reservation over-release (N-02 H1/H2), unremediated |
| 26 | PA-42 | quality | EVIDENCE-GAP | Medium | Verification | The delta after `a6002fa` has no complete clean-snapshot verification |
| 27 | PA-22 | quality | EVIDENCE-GAP | Medium | Verification | 19 real-Postgres specs NOT RUN, 1 BLOCKED; CI excludes real-Postgres and never ran on a hosted runner |
| 28 | PA-20 | company isolation | CONFIRMED-TESTED | Medium | Integrations | Integrations tenancy mismatch (D-03), decision pending |
| 29 | PA-18 | operational | SUSPECTED | Medium | Foundation | Notification and job-queue are README only; 8 in-process timers, multi-instance unverified |
| 30 | PA-30 | operational | EVIDENCE-GAP | Medium | Operations | Product-level backup/restore and observability under load not assessed |
| 31 | PA-32 | financial correctness | EVIDENCE-GAP | Medium | Accounting | Financial statements not validated against independent fixtures |
| 32 | PA-11 | financial correctness | MISSING | Medium | Accounting | Multi-currency stops at rate capture |
| 33 | PA-15 | functional | MISSING | Medium | Accounting | No jurisdiction e-invoicing integration (requirement unconfirmed) |
| 34 | PA-27 | governance | DEBT | Medium | Docs | Master status file stale; no living capability matrix |
| 35 | PA-28 | architecture | DEBT | Medium | Architecture | 19 contract-bypassing imports, registry inversions, one large cycle, very large services |
| 36 | PA-40 | functional | MISSING | Medium | HR | HR master lacks contracts, documents, leave types/balances, shifts (charter Wave 2) |
| 37 | PA-02 | functional | MISSING | Medium | Sales | No customer quotation |
| 38 | PA-06 | functional | MISSING | Medium | Inventory | No lot/serial/batch/expiry (requirement unconfirmed) |
| 39 | PA-12 | functional | MISSING | Low–Medium | Accounting | No budgeting or multi-Company consolidation |
| 40 | PA-07 | functional | MISSING | Low | Inventory | Moving-average only |
| 41 | PA-19 | functional | MISSING | Low | Tracking | `tracking` domain README only |
| 42 | PA-31 | functional | MISSING | Low | Roadmap | No CRM pipeline, planning/MRP, project costing |

## 2. Finding records

Mandatory fields in every record: observation · evidence source · reproduction · impact · confidence · disposition · closure acceptance criteria · dependencies · proposed owner. Paths relative to `backend/` unless noted. "Snapshot" is `b591d1f` unless stated.

### PA-33 — Audit hash chain breaks after a rolled-back audit write (data integrity, High, CONFIRMED-TESTED)
- **Observation.** `audit_records.seq` is `SERIAL`; `AuditService.record` hashes `seq = MAX(seq)+1` while the stored `seq` comes from the database sequence. A transaction that wrote an audit record and rolls back burns a sequence value, so every later record is stored with `seq` = hashed `seq` + 1 and verification fails from that record on. Control case (committed writes) passes. Found while verifying N-02 (T-21 case D). Not fixed; remediation proposal (draw `nextval` under the existing advisory lock and hash that value; verification does not need contiguity) awaits authorisation.
- **Evidence.** `test-program/N-02-FULFIL-RESERVATION-REMEDIATION-REPORT-2026-10-11.md` §6; reproducer `src/foundation/testing/f-aud-rollback-reproducer.biz.real-pg.spec.ts` (step T-22); run `evidence-2026-10-10-biz/T-22/T-22-20261011T041117Z-4c03de` — **WT class**, header commit `ce924e2` with 12 dirty paths (not a clean-snapshot result).
- **Reproduction.** `node tools/testing/biz-run.js --only T-22` on the guarded cluster by an authorised operator (Team 3 did not run it); or read `audit.service.ts` for `MAX(seq)+1` versus the entity's generated key.
- **Impact.** Any failure after an audit write inside an outer transaction (ordinary error handling in the 78 caller-manager sites that now open transactions under the N-01 rule) makes `verifyCompanyChain` fail permanently. No business data is lost, but the tamper-evidence control — the basis for the closing snapshots, support-access audit and any external audit claim — can no longer be demonstrated for the affected Company, and a real tampering event would be masked by the existing failure.
- **Confidence.** VERIFIED (reproducer, WT class); reach in production flows INFERRED. **Disposition.** NV; fix needs CTO authorisation (core component).
- **Closure acceptance criteria.** Fix hashes the stored sequence value; T-22 flips to PASS on a clean snapshot of a named commit; concurrent audit writes (T-03/T-13/T-14) still PASS; a rollback-heavy scenario (T-21 case D) keeps the chain valid; verification of an existing Company with a burnt-sequence gap is defined (repair or accept).
- **Dependencies.** CTO authorisation; guarded cluster window. **Owner.** Foundation / Audit.

### PA-34 — Payroll disbursement posts no GL leg (financial correctness, High, CONFIRMED-BY-READING)
- **Observation.** `PayrollService.disburse` calls `treasury.cashOutForEmployee` for every run line and then only stamps `disbursedAt` and writes an audit record. `cashOutForEmployee` is hard-wired `NO_EMIT`; `emitCashRecorded` returns immediately when `emitGlEvent` is false; `disburse` publishes no event; `handlePayrollRunPosted` is the only payroll handler and posts Dr Salaries & Wages / Cr Wages Payable. The doc comment on `cashOutForEmployee` says "the GL effect (Dr Wages Payable) was already posted by `payroll.run.posted`", which is not what that handler posts, and ADR-070 states the disbursement posting as `Dr Wages Payable / Cr Treasury Account`. No handler or subscriber produces that entry. The integrated E2E spec and `payroll-phase1.spec.ts` call `disburse` and assert `disbursedAt`, never a journal or a GL balance after disbursement.
- **Evidence.** `src/domains/payroll/application/payroll.service.ts` (`disburse`, ~lines 529–575); `src/domains/treasury/application/treasury.service.ts` (`NO_EMIT` line 32, `cashOutForEmployee` ~734–755, `emitCashRecorded` ~381–390); `src/domains/accounting/application/financial-events/payroll-run-posted.handler.ts`; `docs/decisions/ADR-070-payroll-phase1-implementation-contract.md` (disbursement shape); `src/domains/payroll/application/integrated-attendance-payroll-commission-gl-e2e.spec.ts` (assertions end at `disbursedAt`).
- **Reproduction.** Read the files above. Runtime demonstration (needs a cluster window, read-only after a normal run): run the payroll lifecycle on a disposable Company, then compare the GL balance of the wages-payable and treasury-linked bank accounts with `treasury_transactions`; expected if the reading is right: Wages Payable keeps its full credit balance and the GL bank account is unchanged, so the cash/bank reconciliation reports a difference.
- **Impact.** After a payroll cycle the books show an unpaid liability that has been paid and a cash balance that is overstated in the GL while the treasury ledger shows it reduced; the cash/bank and sub-ledger reconciliations will flag or hide it depending on configuration. Financial statements would be wrong from the first disbursed payroll.
- **Confidence.** VERIFIED for the code facts; the runtime effect is INFERRED until the demonstration is run. **Disposition.** NV (the highest-priority financial defect candidate in HR).
- **Closure acceptance criteria.** An approved accounting shape for the disbursement entry; the entry produced through the Financial Event path with idempotency and a reconciliation gap detector (like `listReconciliationGaps` for posting); a spec asserting Wages Payable and the bank GL after disbursement, partial/retry/duplicate cases, and the cash/bank reconciliation clean; evidence on a clean snapshot.
- **Dependencies.** Accounting policy confirmation; PA-35; PA-16. **Owner.** Payroll / Treasury / Accounting.

### PA-35 — Commission is paid but never recognised in the GL (financial correctness, High, CONFIRMED-BY-READING)
- **Observation.** In `calculate`, `grossPay` is the sum of compensation lines, `commissionAmount` is read separately from approved commission results and `netPay = grossPay + commissionAmount − totalDeductions`. In `onApprovalApproved`, `totalGross` sums `grossPay` only and that value alone is published in `payroll.run.posted`; the handler debits expense and credits Wages Payable for `totalGross`. Disbursement pays each line's `netPay` (including commission). ADR-072 describes the GL posting as "gross pay + resolved commission". Commission never posts to the GL on its own (the E2E spec asserts zero commission-sourced financial events). The E2E spec asserts line amounts (gross 4000, commission 200, net 4200) and that the journal is balanced with two lines, but not the journal amount.
- **Evidence.** `payroll.service.ts` lines ~296–330 and ~452–480; `payroll-run-posted.handler.ts`; `ADR-072` financial-integration section; E2E spec lines ~176–232 (BLOCKED spec, not executed).
- **Reproduction.** Read the lines; runtime check: on a disposable Company run the E2E fixture and compare the posted journal debit with the sum of `netPay`.
- **Impact.** Commission expense (and its liability) is absent from the GL: profit and loss understates payroll cost by the commission total while the treasury ledger shows the full net paid. Together with PA-34 the payroll chain cannot reconcile to the ledger.
- **Confidence.** VERIFIED (code facts) / INFERRED (runtime effect). **Disposition.** NV.
- **Closure acceptance criteria.** Contract-conformant posting amount (gross + commission, later tax/insurance split), commission expense account decision, spec asserting journal amounts equal the sum of run lines, reconciliation of run lines to journal and to treasury.
- **Dependencies.** PA-34; accounting policy on commission expense account. **Owner.** Payroll / Accounting.

### PA-36 — Payroll money arithmetic uses JavaScript floating point (financial correctness, Medium, CONFIRMED-BY-READING)
- **Observation.** `calculate`, `onApprovalApproved` and `disburse` accumulate amounts with `Number(...)` and `reduce`, then `toFixed(2)`; accounting uses `decimal.js` with explicit rounding modes and `numeric(20,4)`.
- **Evidence.** `payroll.service.ts` (~295–310, ~455–456, ~570); `src/domains/accounting/domain/money.ts`. **Reproduction.** Read; unit test a run of many cent-valued lines (not run). **Impact.** Rounding drift between line sums, the journal total and the cash paid; values beyond 2 decimals truncated rather than rounded under the company's rounding mode. **Confidence.** VERIFIED (code) / drift magnitude UNVERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** All payroll money handled through the shared decimal helper; property test that sum of lines = journal = cash for random cent amounts. **Dependencies.** PA-16 rework. **Owner.** Payroll.

### PA-37 — Attendance and leave have no financial effect (functional, Medium, CONFIRMED-BY-READING)
- **Observation.** Payroll `calculate` pays every eligible employee with an active compensation, copies attendance day statuses into `PayrollAttendanceDayClassification` rows, and sets `totalDeductions = 0`; absent and missing-punch days classify as `unclassified` with no pay impact until a holiday calendar policy exists (open `ADR-053 §16` escalation); approved leave only changes the day-classification label. Employees with no approved attendance batch are still paid.
- **Evidence.** `payroll.service.ts` `calculate` and `classifyDay`; E2E spec lines ~190–195 assert `unclassified` / `payImpact none` as the intended fail-safe. **Reproduction.** Read; run the spec scenario (BLOCKED). **Impact.** Attendance is an information system, not a pay driver; absenteeism has no payroll consequence; leave entitlement and balances do not exist (PA-40). **Confidence.** VERIFIED. **Disposition.** PARTIAL (by ratified design).
- **Closure acceptance criteria.** Ratified holiday/working-day policy, absence and leave pay rules with effective dating, golden fixtures for absent / leave / late / overtime days. **Dependencies.** PA-16, PA-40, CTO policy. **Owner.** HR / Payroll.

### PA-38 — Commission is not reversed on invoice void, return or credit (financial correctness, Medium, SUSPECTED)
- **Observation.** Commission subscribes to `finance.invoice.posted`, `collection.remitted` and approval events only; not to `finance.invoice.voided`, `returns.sale_return.credited` or return-credit events. Corrections exist as manual `CommissionAdjustment` records.
- **Evidence.** `src/domains/commission/application/commission.service.ts` ~96–132, `createAdjustment` ~541. **Reproduction.** Read; runtime: post and approve a commission, void the invoice, observe (not run). **Impact.** Commission can be paid on revenue later voided or returned unless a person adjusts it. **Confidence.** INFERRED (ADR-071 may intend a manual adjustment policy — to confirm). **Disposition.** NV.
- **Closure acceptance criteria.** Policy decision (automatic reversal versus reviewed adjustment queue), implemented and tested with void/return/credit cases and payroll cut-off interaction (ADR-072). **Dependencies.** ADR-071 reading; PA-35. **Owner.** Commission.

### PA-39 — AP and AR adjustments default to account 5299 (financial correctness, Medium, CONFIRMED-BY-READING)
- **Observation.** `ap-adjustment.handler.ts` and `ar-adjustment.handler.ts` use `expenseAccountCode ?? '5299'` (miscellaneous expenses). The D5 record calls the manual AP credit/debit-note path with hard-coded `5299` "not an approved accounting policy" and lists it as a follow-up; no VAT reversal on those notes.
- **Evidence.** `src/domains/accounting/application/financial-events/ap-adjustment.handler.ts:75,86`, `ar-adjustment.handler.ts:40`; `D5-PPV-INPUT-VAT-POLICY-2026-10-05.md`. **Reproduction.** Read the three lines. **Impact.** Notes and write-offs land in a catch-all account, distorting P&L classification and omitting VAT effects. **Confidence.** VERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** Approved policy (accounts per adjustment kind, VAT treatment), configuration keys instead of a literal, tests per kind. **Dependencies.** CTO accounting policy. **Owner.** Accounting.

### PA-41 — LA-1 Layer 2 only partly applied (company isolation, Medium–High, CONFIRMED-BY-READING)
- **Observation.** The Layer 2 mechanism (`runOperationalAdmitted`) is committed (`60b9bdf`) and wired in 3 of 10 sites (preliminary-hold expiry, approval expiry, installation audit access). Seven remain unwired because they sit in files owned by other tracks (closing-snapshot recovery, membership provisioning ×3, membership reconciliation, event dispatcher, plans ×2). The record states "LA-1 is not closed: a path that opens a Company DataSource without admission still exists." Its proofs ran on a copy, not the live tree; the clean-snapshot result for `60b9bdf` is not filled.
- **Evidence.** `docs/decisions/saas-control-plane/LA-1-LAYER2-SPECIFICATION-AND-IMPLEMENTATION-RECORD.md` (site table and summary); `FINAL-CLOSURE-PACKAGE.md` ("LA-1: PARTIAL"). **Reproduction.** Read the site table. **Impact.** A suspended or not-READY Company can still be modified by seven background or provisioning paths. **Confidence.** VERIFIED (record) / runtime UNVERIFIED. **Disposition.** PARTIAL.
- **Closure acceptance criteria.** The seven sites wired by their owners with the same pattern and a real-Postgres spec each; CTO decision recorded; clean-snapshot evidence. **Dependencies.** Track owners; CTO decision. **Owner.** Company lifecycle / each site owner.

### PA-42 — The delta after `a6002fa` has no complete clean-snapshot verification (quality, Medium, EVIDENCE-GAP)
- **Observation.** `a6002fa` has the complete pipeline. After it: the N-02 fix, LA-1 Layer 2 and test registration. The N-02 report §5 pipeline result is a placeholder; T-21 passed on the working tree. Team 3 therefore cannot state that HEAD `b591d1f` passes the business suite, unit or guard, and does not.
- **Evidence.** N-02 report §4–§5; `git diff --stat a6002fa HEAD -- backend/src`. **Reproduction.** Clean snapshot of the then-current HEAD with the CI script and the business suite (authorised operator). **Impact.** The inventory fulfilment locking, scheduler admission and audit-controller guard changes rest on working-tree evidence and unit-level specs only. **Confidence.** VERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** Pipeline filled from a clean snapshot of the then-current HEAD; the independent evidence review that the N-02 report lists as outstanding. **Dependencies.** Cluster window. **Owner.** Verification.

### PA-01 — Sales Order cannot be cancelled once submitted; no reactivation of any transactional document (functional, High, MISSING)
- **Observation.** `sales_order_approval` and `sales_order_open_account` have no cancel/void action and no transition out of `released`; only a draft can be deleted. Purchase orders, work orders and invoices do have cancel/void; reactivation exists only for company, user, GL account, product, routing and shipment lifecycle objects.
- **Evidence.** `src/foundation/process-engine/process-definition.ts` (0 occurrences of "cancel"); `src/domains/sales-orders/interface/sales-orders.controller.ts` routes; contrast `purchase-order-process.ts`, `work-order-process.ts`, `sales-invoice-process.ts`. **Reproduction.** `grep -c cancel src/foundation/process-engine/process-definition.ts` → 0. **Impact.** Abandoned or erroneous released orders have no sanctioned unwind path; deposit, reservation and commission effects must be corrected indirectly. **Confidence.** VERIFIED. **Disposition.** MISSING-REQ.
- **Closure acceptance criteria.** Cancel pre-conditions per state (deposit, reservation, fulfilment, shipment, invoice) with compensation rules; reservations released; deposit by approved policy; reconciliation clean; concurrency test (double cancel, cancel versus ship); reactivation decided and enforced. **Dependencies.** Deposit policy (CTO); N-01 primitives; PA-38. **Owner.** Sales / Customer-Finance.

### PA-02 — No customer quotation (functional, Medium, MISSING)
- **Observation.** Only `supplier-quotation` (RFQ) exists. **Evidence.** search of `src` for quotation entities. **Reproduction.** `grep -rliE "quotation|SalesQuote" src --include=*.ts`. **Impact.** Order-to-cash begins at the order; a gap against reference ERPs; requirement unconfirmed. **Confidence.** VERIFIED. **Disposition.** ENH. **Closure acceptance criteria.** ADR "out of scope" or quotation→order with price-list binding, validity, approval. **Dependencies.** Price lists. **Owner.** Sales; decision CTO/Product.

### PA-03 — No automated order-to-cash chain test (quality, High, EVIDENCE-GAP)
- **Observation.** Per-domain isolation specs and the business suite T-01…T-21 cover pieces; no spec drives one order from creation through approvals, deposit, fulfilment, shipment, delivery, invoice, payment and GL with assertions per hop. The only chain walkthrough is the dated manual run of 2026-08 (`MASTER_PROJECT_STATUS.md` §7). **Evidence.** T-plan, spec names (absence judged by names). **Reproduction.** Read the T-plan and spec list. **Impact.** A seam regression is caught only by the oracle after the fact, if at all. **Confidence.** INFERRED. **Disposition.** NV.
- **Closure acceptance criteria.** One scripted chain at HTTP level on a clean snapshot with R1–R10 and per-hop ledger/inventory assertions. **Dependencies.** Cluster window; PA-01/PA-04 for unwind/race cases. **Owner.** Verification.

### PA-04 — `fulfillReservation` double dispatch: fixed in code, not independently reviewed (data integrity, Medium, CONFIRMED-TESTED → fixed)
- **Observation.** Before the fix: 6 concurrent calls on a reservation of 3 produced 6 dispatch movements and on-hand −18 under plain and transaction managers (T-20 H3, clean `a6002fa`); T-21 on unfixed code: 8 of 8 succeeded. After the fix (`a798d9d`, `b591d1f`): the reservation is re-read under the per-(warehouse, product) advisory lock and the call runs through `runInTransaction`; T-21 cases A–G pass on the working tree (single success, 409 for the rest, retries safe, partial failure and rollback leave no movement, order-level atomic, no over-serialisation, global consistency). Case H (audit chain after rollback) fails — see PA-33.
- **Evidence.** N-02 report §1–§7; `src/domains/inventory-warehouse/application/inventory.service.ts`; evidence `evidence-2026-10-10-biz/T-21/T-21-20261011T041223Z-a952b7` (WT class). Report status: "IMPLEMENTED AND VERIFIED BY THE IMPLEMENTING TRACK — NOT CLOSED."
- **Reproduction.** `--only T-21` (authorised operator). **Impact (residual).** Reach of the race through the delivery state machine still INFERRED; the fix covers the service, not callers' idempotency. **Confidence.** VERIFIED (before/after on the cited runs). **Disposition.** NV (pending independent review).
- **Closure acceptance criteria.** Clean-snapshot evidence of the HEAD including the fix (PA-42); independent evidence review; HTTP-level double delivery-confirmation test; PA-33 resolved or accepted. **Dependencies.** PA-42, PA-33. **Owner.** Inventory / Verification.

### PA-05 — Limit overshoot and reservation over-release (data integrity, Medium, CONFIRMED-TESTED)
- **Observation.** N-02 H1: `LimitService.consume` allowed 13 against a cap of 10. H2: `releaseReservedQuantity` succeeded 11 of 12 for 5 reserved units (pass inside a transaction — the N-01 mechanism). H4: racing `ProcessEngineService.start` raises database errors (loud, no corruption). H5 shipment transitions: BLOCKED (no fixture). Not remediated.
- **Evidence.** `test-03/N-02-DIAGNOSTIC-PROBES-REPORT-2026-10-11.md`; clean snapshot `a6002fa` T-20 result (6 FAIL-DEFECT, 2 PASS, 1 BLOCKED) per the reconciliation record. **Reproduction.** `--only T-20`. **Impact.** Plan limits exceedable; reservations over-releasable. **Confidence.** VERIFIED probe / reach INFERRED. **Disposition.** NV.
- **Closure acceptance criteria.** Shared transaction rule applied to `limit.service` and the reservation methods under CTO authorisation; T-20 H1/H2/H4 as assertions PASS; H5 fixture built and probed. **Dependencies.** CTO authorisation. **Owner.** Foundation.

### PA-06 — No lot, serial, batch or expiry tracking (functional, Medium, MISSING)
- **Observation.** No such entities or columns in `src`. **Evidence.** `grep -rliE "serial_number|lotNumber|batchNumber|lot_number|batch_no" src` → no production hits. **Reproduction.** that command. **Impact.** No traceability, warranty or recall; requirement for this client unconfirmed. **Confidence.** VERIFIED (absence). **Disposition.** ENH. **Closure acceptance criteria.** Requirement decision, then a tracking design extending movements, reservations, returns and valuation. **Dependencies.** Inventory-valuation contract. **Owner.** Inventory; decision CTO/Product.

### PA-07 — Moving-average is the only costing engine (functional, Low, MISSING)
- **Observation.** The cost-engine interface is designed for FIFO/standard cost but only moving average exists. **Evidence.** `src/domains/inventory-valuation/domain/cost-engine.ts`. **Reproduction.** Read it. **Impact.** Some jurisdictions or customers require another method. Moving average itself is verified under concurrency (T-01/T-03/T-10, clean `a6002fa`). **Confidence.** VERIFIED. **Disposition.** ENH. **Closure acceptance criteria.** Requirement decision; second engine behind the interface with a reconciliation proof. **Dependencies.** none. **Owner.** Inventory valuation.

### PA-08 — No supplier return flow (functional, Medium–High, MISSING)
- **Observation.** No return-to-vendor document, stock-out against a goods receipt, GRNI reversal or supplier-ledger return entry; warehouse transaction types are receipt/issue/transfer/adjustment/count. The AP debit note exists financially (PA-39). ADR-052 and D5 list supplier returns as a follow-up (acknowledged, not specified).
- **Evidence.** `src/domains/inventory-warehouse/domain/warehouse-transaction-type.ts`; `D5-PPV-INPUT-VAT-POLICY-2026-10-05.md`; `ADR-052` line ~95. **Reproduction.** `grep -rniE "return_to_supplier|supplierReturn" src`. **Impact.** Procure-to-pay cannot handle rejected goods without manual adjustments that break the receipt→GRNI→invoice trace. **Confidence.** VERIFIED. **Disposition.** MISSING-REQ.
- **Closure acceptance criteria.** Return document referencing the receipt with caps, stock and GRNI/PPV effects, supplier-ledger entry, approvals, concurrency tests (as T-07), oracle extended. **Dependencies.** GRNI/PPV return policy (CTO); PA-39. **Owner.** Procurement.

### PA-09 — No bank-statement import or matching (functional, Medium–High, MISSING)
- **Observation.** Cash/bank reconciliation compares the GL with the internal treasury ledger and records a run; no statement entity, import or matching exists. No specification found in the repository.
- **Evidence.** `src/domains/accounting/application/cash-bank-reconciliation.service.ts`, `cash-bank-reconciliation-run.entity.ts`, `interface/cash-bank.controller.ts`. **Reproduction.** Read; search statement terms. **Impact.** Agreement with the bank cannot be demonstrated; unrecorded charges and unmatched deposits undetectable. **Confidence.** VERIFIED. **Disposition.** MISSING-REQ.
- **Closure acceptance criteria.** Statement import with preview, matching, differences through the cash-bank adjustment path, audit, Company A/B isolation spec, worked fixture. **Dependencies.** Excel foundation; PA-34 (payroll cash leg). **Owner.** Accounting / Treasury.

### PA-10 — Year-end close is a status lock (financial correctness, Medium, CONFIRMED-BY-READING)
- **Observation.** `applyApprovedYearClose` transitions the fiscal-year state, audits and publishes `accounting.fiscal_year.status_changed` (no consumer); no closing entries or retained-earnings roll-forward; the Balance Sheet derives unclosed income from inception (ADR-047 D3, deliberate). `retained_earnings` is declared the "year-end roll-forward target — F13".
- **Evidence.** `fiscal-period.service.ts`, `financial-reporting.service.ts#getBalanceSheet`, `domain/control-function.ts`. **Reproduction.** Read; `grep -rn FISCAL_YEAR_STATUS_CHANGED_EVENT src`. **Impact.** Statements are arithmetically right but the ledger lacks the statutory closing/opening structure auditors expect. **Confidence.** VERIFIED. **Disposition.** PARTIAL.
- **Closure acceptance criteria.** Decision (derived equity as policy, or closing entries with reopen safety); tests that statements are unchanged by the close and reopen works. **Dependencies.** PA-32. **Owner.** Accounting; decision CTO.

### PA-11 — Multi-currency stops at rate capture (financial correctness, Medium, MISSING)
- **Observation.** Currencies, rates and per-line rate snapshots exist; no revaluation or realised/unrealised result. **Evidence.** `currency.service.ts`, `journal-entry.service.ts`, `exchange-rate.entity.ts`. **Reproduction.** Read; search revaluation terms (none). **Impact.** Fine for a single-currency company, a gap for importers. **Confidence.** VERIFIED (absence). **Disposition.** PARTIAL. **Closure acceptance criteria.** Requirement decision; revaluation run with approval and exchange-result accounts; reconciliation extended. **Dependencies.** Accounting policy. **Owner.** Accounting.

### PA-12 — No budgeting and no consolidation (functional, Low–Medium, MISSING)
- **Observation.** No budget entity or service; no cross-Company consolidation (a charter Wave 5 item). **Evidence.** searches of `src`; charter §5. **Reproduction.** `grep -rliE "budget|consolidat" src/domains src/foundation`. **Impact.** Management control and group reporting not available. **Confidence.** VERIFIED. **Disposition.** ENH (Phase 2). **Closure acceptance criteria.** Roadmap decision; consolidation designed as read-only aggregation under the approved entitlement/audit model. **Dependencies.** Multi-company model (constraint). **Owner.** Accounting / Platform.

### PA-13 — F03 GL-posting deadlock: mitigated, lock-order cure deferred (data integrity, Medium–High, CONFIRMED-TESTED)
- **Observation.** Concurrent postings can deadlock (audit latest-row `FOR UPDATE` versus `numbering_sequences FOR UPDATE`). RCA `b5a9a85` (first-hand). Remediation Option B (retry up to 3× on 40P01) + Option C (`TRANSIENT_DATABASE_ERROR` classification) landed in `9c746aa` with a 15-round verification spec; Option A (lock-order restructuring) deferred. N-01 (`23e5ec1`) later changed transaction scope for callers on a plain manager; no record re-runs the F03 verification on a commit containing it.
- **Evidence.** `docs/studies/F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`; commit `9c746aa`; T-10/T-16 on clean `a6002fa` PASS (not a targeted deadlock test). **Reproduction.** Run `f03-deadlock-retry-verification.spec.ts` on a commit with `23e5ec1` (authorised operator). **Impact.** Latency and tail rejections under concurrent posting; no silent corruption indicated. **Confidence.** VERIFIED (RCA, mitigation) / INFERRED (interaction). **Disposition.** NV.
- **Closure acceptance criteria.** Retry verification PASS on current HEAD; decision on Option A or permanent acceptance with a deadlock counter. **Dependencies.** CTO decision; PA-42. **Owner.** Accounting / Foundation.

### PA-14 — Business-date / timezone class (data integrity, Medium–High, SUSPECTED — fix present, unverified)
- **Observation.** Postgres session timezone is `Africa/Cairo`. `3ef67f4` introduced one UTC business-date convention in the sub-ledger/reconciliation path; `54d8818` fixed Attendance local-time handling; the Commission regression found on 2026-09-21 (202/204 serial run, first-hand) led to `f2d15fa` and `1219ab6` the same day, but no record shows the canonical serial regression re-run clean, and the integrated E2E spec still reads BLOCKED. `commission.service.ts:305` derives a target date from `toISOString().slice(0,10)`. Cairo versus UTC remains an open CTO decision.
- **Evidence.** E2E spec header; commits above; `src/foundation/localization/business-date.ts`. **Reproduction.** Canonical serial regression (`--runInBand`) of the affected suites; not run by Team 3. **Impact.** Events within three hours of Cairo midnight may land on the wrong business day, silently. **Confidence.** VERIFIED (2026-09-21) / UNVERIFIED (now). **Disposition.** NV.
- **Closure acceptance criteria.** One rule and helper; fixtures at 23:30–03:30 Cairo for Attendance, Payroll, Commission, GRNI; 204-test serial regression clean; integrated E2E PASS. **Dependencies.** CTO decision. **Owner.** HR / Commission.

### PA-15 — No jurisdiction e-invoicing integration (functional, Medium, MISSING)
- **Observation.** Tax engine, tax codes, tax periods and a tax summary exist; the invoice has an external-document reference field; no tax-authority integration. Jurisdictional requirement not stated in reviewed documents. **Evidence.** `tax-engine.service.ts`, `getTaxPeriodSummary`, migration `1755855000000`. **Reproduction.** Read. **Impact.** Unknown until the requirement is confirmed. **Confidence.** requirement UNVERIFIED. **Disposition.** ENH / OOS pending legal requirement. **Closure acceptance criteria.** Written requirement, then an adapter behind a contract with Company-scoped credentials and outbox retry. **Dependencies.** PA-20. **Owner.** Accounting; decision CTO/legal.

### PA-16 — Payroll computes no overtime, tax, insurance, payslip (functional, High, MISSING)
- **Observation.** Payroll Phase 1 implements periods, compensation, calculation, review, approval (maker≠checker), GL posting event, disbursement and adjustments. By ratified design (ADR-067 §D/§E) no overtime, income tax or social insurance is computed; `overtimeAmount` is a reserved null; no tax/insurance control accounts; no payslip in backend or frontend; holiday calendar open.
- **Evidence.** `payroll.service.ts` class doc and `calculate`; handler doc; search "payslip" none; frontend `pages/payroll` (4 pages). **Reproduction.** Read. **Impact.** Not acceptable as statutory payroll; acceptable only as a gross-pay model. **Confidence.** VERIFIED. **Disposition.** PARTIAL.
- **Closure acceptance criteria.** CTO decisions on §D/§E; implementation with effective-dated rules, golden fixtures, payslip, GL liabilities; evidence on a clean snapshot. **Dependencies.** CTO policy; PA-34/35/36/37. **Owner.** HR / Payroll.

### PA-17 — Integrated Attendance→Payroll→Commission→GL E2E is BLOCKED (quality, High, EVIDENCE-GAP)
- **Observation.** Spec `24082d6`; status BLOCKED — REGRESSION NOT CLEAN (`9da2e54`, 2026-09-21; first-hand): 4/4 targeted, 202/204 canonical serial. A candidate Commission fix exists (PA-14); the resume is unrecorded. For the resume: the spec asserts line amounts and journal balance but not the journal amount or post-disbursement GL (PA-34/PA-35), so a PASS of the current spec would **not** prove payroll-to-ledger agreement.
- **Evidence.** `docs/studies/INTEGRATED_ATTENDANCE_PAYROLL_COMMISSION_GL_E2E_SPEC.md`; `integrated-attendance-payroll-commission-gl-e2e.spec.ts`. **Reproduction.** Read headers; `git log` for fix commits. **Impact.** Payroll lifecycle has no end-to-end proof. **Confidence.** VERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** PA-14 closed; serial regression clean; spec extended with journal-amount, disbursement-GL and treasury-reconciliation assertions; PASS on a pinned commit. **Dependencies.** PA-14, PA-34, PA-35. **Owner.** HR/Payroll with Commission.

### PA-18 — Notification and job queue absent; in-process timers (operational, Medium, SUSPECTED)
- **Observation.** `foundation/notification` and `foundation/background-processing` are README only; eight `setInterval` schedulers; no lease or leader election. **Evidence.** architecture graph §1; directory listing; `EVENT-OUTBOX-DISPATCH-BEHAVIOUR-2026-10-11.md`. **Reproduction.** `grep -rn setInterval src`. **Impact.** No user notifications; with two instances each scheduler runs twice (effect unverified; the outbox claims rows). **Confidence.** VERIFIED (code) / UNVERIFIED (runtime). **Disposition.** PARTIAL. **Closure acceptance criteria.** Multi-instance test of each scheduler; outbox backlog at 1×/3×/10×; notification design or recorded exclusion. **Dependencies.** Staging host. **Owner.** Foundation.

### PA-19 — `tracking` domain not implemented (functional, Low, MISSING)
- **Observation.** README only. **Evidence.** `test-03/evidence/capability-matrix.md`. **Reproduction.** List `src/domains/tracking`. **Impact.** None on audited scenarios. **Confidence.** VERIFIED. **Disposition.** OOS now. **Closure acceptance criteria.** Implement or remove the placeholder by roadmap decision. **Dependencies.** roadmap decision only. **Owner.** CTO.

### PA-20 — Integrations: single connector, tenancy mismatch (company isolation, Medium, CONFIRMED-TESTED)
- **Observation.** One connector (QR store) and a partner intake endpoint (`IntegrationAuthGuard`). Tables created by the `sales` Company migration tag while `IntegrationsService` uses the control-plane DataSource (D-03; T-18 FAIL-DEFECT on `a6002fa`, 4 CREATE TABLE pending); connector entity has no Company binding. Options A/B/C and a plan (D-04) exist; none chosen.
- **Evidence.** `test-03/INTEGRATIONS-TENANCY-DECISION-RECORD-2026-10-11.md`, `D-04-…`, `src/foundation/integrations/*`. **Reproduction.** `--only T-18`. **Impact.** Integration data may not be isolated per Company. **Confidence.** VERIFIED. **Disposition.** PARTIAL.
- **Closure acceptance criteria.** Option decided; implementation per D-04; Company A/B spec for connectors/credentials/mappings/sync logs; T-18 structural check PASS. **Dependencies.** CTO decision. **Owner.** Platform / Integrations.

### PA-21 — N-01: PASS on a clean snapshot; closure recorded for local scope; sign-off pending (data integrity, High, EVIDENCE-GAP)
- **Observation.** `runInTransaction` (`23e5ec1`) fixed numbering and process-engine at the primitive. On clean `a6002fa`: business suite T-00…T-20 exit 0 with R1–R10 PASS, T-19 15/15 (four entity creates 80/80 each, HTTP `POST /api/customers` 120/120), 20/20 isolation specs, unit 59/430, guard 50/50; before the fix 18/80, 9/80, 8/80, 25/80. The implementing session's review (`b5dcece`, N-01 report §7) records "CLOSED for the local scope", CTO sign-off pending, excluding hosting, multi-instance operation and N-02. Independence note: the reviewer is the author of the changed code; evidence was produced by the verification session. Residual per §7.3: 78 caller-manager sites protected by construction and isolation specs, not per-site concurrency tests; 15–20-way concurrency on 2 cores; process-engine `start` still errors under racing starts (N-02 H4).
- **Impact.** Residual exposure is the unprobed call sites (by-construction coverage only), multi-instance behaviour and the independence of the closure review; the money-path primitives themselves are protected.
- **Evidence.** N-01 report §3, §6A, §7; reconciliation §4. **Reproduction.** Clean snapshot of `a6002fa`, `biz-run.js`. **Confidence.** VERIFIED (records read; not re-executed). **Disposition.** NV. **Team 3 neither declares nor contests the closure.**
- **Closure acceptance criteria (residual).** CTO sign-off recorded; per-endpoint specs for the highest-traffic remaining paths or recorded acceptance of the by-construction argument; multi-instance run or recorded exclusion. **Dependencies.** Cluster window. **Owner.** CTO (sign-off); Foundation / Verification.

### PA-22 — Test-coverage holes (quality, Medium, EVIDENCE-GAP)
- **Observation.** Real-Postgres isolation set: 80 PASS, 1 BLOCKED (`release-migration-registry`, hard-coded port), 19 NOT RUN (provisioning, pool, fan-out, restore, registry, name-namespace and product-named-database groups). 42 service/controller classes have no spec by name; 74 of 212 specs use inert `{} as never` collaborators. CI (`ci.yml` → `tools/ci/ci.sh`) runs install, build, lint, structure, doc links, unit, guard; no real-Postgres job; never executed on a hosted runner.
- **Evidence.** `test-program/VERIFICATION-CLOSURE-AND-RELEASE-DECISION-REPORT-2026-10-11.md` §2; TEST-03 Q-03/Q-04; `.github/workflows/ci.yml`. **Reproduction.** Read those. **Impact.** Provisioning/pool/restore behaviour has no verification in this program. **Confidence.** VERIFIED counts / INFERRED by-name parts. **Disposition.** NV.
- **Closure acceptance criteria.** CTO guard decision and namespace adaptation approved; the 19 run; hosted CI run; scheduled real-Postgres job. **Dependencies.** CTO guard decision. **Owner.** Verification.

### PA-23 — Frontend has no automated tests (quality, High, EVIDENCE-GAP)
- **Observation.** `frontend/package.json` scripts: dev, build (`tsc -b && vite build`), lint (oxlint), preview; no test runner; no `*.test.*`/`*.spec.*` under `frontend/src` (164 `.tsx`). UI acceptance is manual browser work on isolated environments (project records).
- **Evidence.** `frontend/package.json`; `find frontend/src -name "*.test.*" -o -name "*.spec.*"` → 0. **Reproduction.** Those commands. **Impact.** No safety net for UI refactors or dependency majors (react-router 6→7). **Confidence.** VERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** Test strategy with component tests and a short browser E2E set for order-to-cash, procure-to-pay, period close and payroll, run in CI. **Dependencies.** none technical. **Owner.** Frontend / Verification.

### PA-24 — Capacity NOT CLASSIFIED (operational, High, EVIDENCE-GAP)
- **Observation.** T-16: 10,495 requests, 0 errors, oracle PASS, plateau ~31–39 req/s from 5 users on a shared 2-core machine (Node ≈ 93 % of one core), p95 345 ms at 5 users → 3.8 s at 50; T-16 assertions PASS again on clean `a6002fa`. No approved targets; no hosting measurement; memory +19 % over 5 minutes in a harness including the test framework unexplained.
- **Evidence.** Verification report §3; `CAPACITY-DECISION-BRIEF-FOR-CTO-2026-10-11.md`. **Reproduction.** `--only T-16`; staging profile on an approved host (not run). **Impact.** No basis for a multi-tenant SaaS capacity claim. **Confidence.** VERIFIED measurements; scaling conclusions UNVERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** Approved workload and targets (D-10), staging host with separate generator, soak and multi-instance, CPU profile, PASS/FAIL against targets. **Dependencies.** CTO decisions; host. **Owner.** Verification / Platform.

### PA-25 — Dependency vulnerabilities (security, High, DEBT)
- **Observation.** `npm audit` (D-01, `d51a751`): backend 65 advisories (3 critical, 44 high, 14 moderate, 4 low), 15 runtime-reachable packages, 50 dev-only; frontend 3. Reach (INFERRED): `proxy-addr` only if `trust proxy` is configured (the app never sets it; host proxy UNVERIFIED); `tar` install-time via bcrypt; multer/body-parser on authenticated upload endpoints; `joi` at start-up only. Remediation tiers T1/T2/T3 proposed, not executed.
- **Evidence.** `test-03/DEPENDENCY-AUDIT-D01-2026-10-11.md`, `evidence/npm-audit-backend-summary.md`. **Reproduction.** `npm audit --json` (network). **Impact.** Release gate; T2 majors need a regression net PA-22/PA-23 show is thin. **Confidence.** VERIFIED advisories / INFERRED reach. **Disposition.** NV.
- **Closure acceptance criteria.** T1 applied and re-audited from a clean snapshot (runtime critical = 0), T2 scheduled, T3 acceptances recorded. **Dependencies.** PA-22, PA-23; host proxy check. **Owner.** Foundation / Security.

### PA-26 — Release and hosting readiness (operational, High, EVIDENCE-GAP)
- **Observation.** Verification verdict: local functional readiness READY (N-01 open at the time); isolation 80/1/19; capacity NOT CLASSIFIED; F-INV-001 410 change NOT APPROVED (D-9 blocked); hosting UNVERIFIED; **overall release NOT APPROVED**. Production 1.1.4 incident (installation row never initialised confirmed; 503 cause unconfirmed) and the 1.1.6 deploy cut-off are on record. The release engine (largest foundation module; `release-execution.service` 1,669 lines) has no spec by name.
- **Evidence.** Verification report §8; `POST-DEPLOYMENT-INCIDENT-REVIEW-1.1.4-2026-10-09.md`; release 1.1.6–1.1.8 records; TEST-03 Q-03. **Reproduction.** Read. **Impact.** Cannot be released or hosted for customers on current evidence. **Confidence.** VERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** Release gate: staging host, restore and rollback drills, migration-registry check, N-01/N-02 closure, PA-24/PA-25 resolved or accepted, independent sign-off. **Dependencies.** CTO decisions; host. **Owner.** Platform / Release.

### PA-27 — Documentation authority drift (governance, Medium, DEBT)
- **Observation.** `MASTER_PROJECT_STATUS.md`, called authoritative, was last reconciled 2026-08-24 (43 suites / 550 tests, "feature-complete") while the repository has 212 specs and a changed architecture; ADR-053 required a living Capability Coverage Matrix ("not yet created"). H-01 closed by importing 80 files (snapshots).
- **Evidence.** File headers; ADR-053. **Reproduction.** Read; `find backend/src -name "*.spec.ts" | wc -l`. **Impact.** Newcomers and auditors are misled on state. **Confidence.** VERIFIED. **Disposition.** NV. **Closure acceptance criteria.** Reconcile or mark historical; adopt the capability matrix as the living one with an owner. **Dependencies.** CTO. **Owner.** Documentation.

### PA-28 — Architecture debt (architecture, Medium, DEBT)
- **Observation.** 19 concrete cross-domain service imports; 21 registry inversions; one strongly connected component of 44 of 64 modules; five services over 1,000 lines; 259 non-null assertions; 275 raw queries. **Evidence.** `test-03/ARCHITECTURE-GRAPH-2026-10-11.md`; TEST-03 §3. **Reproduction.** `tools/assessment/arch-graph.js`, `cross-domain-imports.js`, `code-metrics.js`. **Impact.** Changes ripple; extraction hard; lint blind to bypasses. **Confidence.** VERIFIED. **Disposition.** NV (no rewrite). **Closure acceptance criteria.** Resolved-path lint; no new concrete imports; ADR for oversize services. **Dependencies.** CI. **Owner.** Platform architecture.

### PA-29 — Authorization residuals (security / company isolation, Medium–High, EVIDENCE-GAP)
- **Observation.** F1–F6 committed with phase reports; F-INV-001 closed locally but the 410 compatibility change is unapproved and D-9 is blocked on an operator; four JWT controllers lack Company and platform guards (INFERRED, hand review pending); pending CTO items (default company-admin capability, support-access options) recorded in project notes. Constraint: Team 3 does not redesign the approved model.
- **Evidence.** `AUTHORIZATION-F1…F6-PHASE-REPORT-2026-10-07.md`, `test-program/F-INV-001-*`, `controller-guard-scan.json`. **Reproduction.** Read; hand review missing. **Impact.** A residual path or an incompatible change could expose or break stock access. **Confidence.** VERIFIED (records) / INFERRED (guards). **Disposition.** NV.
- **Closure acceptance criteria.** Hand review recorded; D-9 evidence returned; each CTO item decided and tested. **Dependencies.** CTO; operator. **Owner.** Authorization.

### PA-30 — Backup, restore and observability evidence thin (operational, Medium, EVIDENCE-GAP)
- **Observation.** A `pg_dump`/`pg_restore` drill on a development database (2026-08); release engine has backup schedulers; restore specs NOT RUN; no restore of a Company database through the product recorded; observability has logger/health/metrics but no alerts/SLOs found. **Evidence.** `MASTER_PROJECT_STATUS.md` §8b; `src/foundation/observability/*`, `src/foundation/release/*`. **Reproduction.** Read. **Impact.** Recovery time and loss exposure cannot be stated. **Confidence.** UNVERIFIED. **Disposition.** NV. **Closure acceptance criteria.** Executed product-made backup/restore into a disposable instance with audit-chain verification (needs PA-33 decided); alert definitions tested. **Dependencies.** PA-22, PA-33, host. **Owner.** Platform / Release.

### PA-31 — Breadth gaps against reference ERPs (functional, Low, MISSING)
- **Observation.** CRM stops at the customer master; manufacturing has no planning/MRP/capacity scheduling; no project accounting or timesheets. MRP, consolidation and advanced planning appear in the charter's Wave 5 list. **Evidence.** crm infrastructure listing; searches; charter §5. **Reproduction.** List directories. **Impact.** Breadth only. **Confidence.** VERIFIED. **Disposition.** OOS now / Phase 2. **Closure acceptance criteria.** ERP Integration Contract per ADR-053 before any build. **Dependencies.** Phase 1 gate. **Owner.** CTO / roadmap.

### PA-32 — Statements not validated against independent fixtures (financial correctness, Medium, EVIDENCE-GAP)
- **Observation.** Trial balance, balance sheet, P&L, cash flow and exports exist; the reconciliation oracle proves sub-ledger-to-GL agreement; no hand-computed golden fixtures are recorded. **Evidence.** `financial-reporting.service.ts`, `general-ledger.company-isolation.spec.ts`. **Reproduction.** Read; search specs for fixtures (none). **Impact.** Classification, FX, depreciation or WIP errors could pass all tests. **Confidence.** UNVERIFIED. **Disposition.** NV.
- **Closure acceptance criteria.** Golden fixtures (incl. FX, tax, depreciation, disposal, WIP); oracle extended with "balance sheet balances" and "cash-flow net equals treasury movement". **Dependencies.** PA-10, PA-11. **Owner.** Accounting / Verification.

### PA-40 — HR master is narrower than the charter's Wave 2 (functional, Medium, MISSING — specified at charter level)
- **Observation.** Charter Wave 2 lists "Employee / Department / Organization / Contracts / Documents / Attendance / Leave / HR Operations". Implemented: employees (status history, manager, user link), departments, leave requests with approval. Not found: employment contracts, employee documents, leave types and balances/entitlements, shifts and schedules, holiday calendar, loans/advances, end-of-service, performance reviews. `targets` covers sales targets only.
- **Evidence.** `src/domains/hr/infrastructure` (3 entities), `hr.service.ts` method list, `architecture/DAII_ERP_LONG_TERM_COMPLETION_CHARTER.md` §5. **Reproduction.** List the directory and methods. **Impact.** A coherent end-to-end HR solution (see the integration assessment) needs these before payroll rules can be driven by HR data. **Confidence.** VERIFIED (absence). **Disposition.** MISSING-REQ for the Phase 1 HR scope as the charter defines it.
- **Closure acceptance criteria.** Phase 0 contract per capability; implementation with isolation and lifecycle tests. **Dependencies.** Phase 0 decisions H0-1…H0-7. **Owner.** HR.

## 3. Cross-reference to existing findings (not duplicated)

| Existing ID | Where defined | Carried as | Status note |
|---|---|---|---|
| H-01 | TEST-03 | PA-27 context | Closed by R1 (`1829794`); copies are snapshots |
| Q-01 / Q-03 / Q-04 | TEST-03 | PA-03, PA-22, PA-23 | Open |
| N-01 / N-02 | TEST-03 / verification | PA-21, PA-04, PA-05 | N-01 local-scope closure recorded, sign-off pending; N-02 not closed |
| C-01 | TEST-03 | PA-22 | Closed locally; hosted run UNVERIFIED |
| A-01, C-02, C-03 | TEST-03 | PA-28 | Open |
| D-03 | TEST-03 | PA-20 | Decision pending |
| P-01…P-03, L-01, L-02 | TEST-03 | not restated | P-02 partly executed (untracked duplicate trees, nothing deleted); others open |
| S-03, S-04, S-05 | TEST-03 | PA-25, PA-26 | S-04 audited (D-01), remediation not run |
| F-INV-001, D-9, D-10 | verification | PA-29, PA-24 | Blocked / pending |
| F-AUD-003 | N-02 report | PA-33 | Not fixed |
| LA-1 | saas-control-plane | PA-41 | PARTIAL |

## 4. Technical-debt view

| Rank | Item | IDs | Effort | Why |
|---|---|---|---|---|
| 1 | Regression strength: frontend tests, real-Postgres in CI, 19 specs, chain tests | PA-22, PA-23, PA-03, PA-42 | L | Every remediation and upgrade is only as safe as this |
| 2 | Integrity primitives: audit chain, N-02 remainder, F03 lock order | PA-33, PA-05, PA-13, PA-21 | M | The same defect class produced four P0s; PA-33 is a new member |
| 3 | Payroll-to-ledger agreement | PA-34, PA-35, PA-36 | M | Statements wrong from the first payroll |
| 4 | Dependency remediation | PA-25 | M–L | T1 small; T2 needs rank 1 |
| 5 | Documentation authority | PA-27 | S | Cheap, protects handover and audit |
| 6 | Architecture coupling | PA-28 | M | Slows Phase 1 more than it endangers it |

## 5. Not assessed (explicit)

Hosting and production behaviour; real customer data; penetration testing; browser-level UI behaviour (Team 3 ran no browser); statutory requirements of any jurisdiction; licensing opinion; frontend code quality beyond counts; dynamic dependency injection beyond static imports; data migration from the client's legacy spreadsheets. No database-backed test was run by Team 3: the isolated cluster is reserved by other sessions, and every runtime result above is taken from an existing report with its commit and class named. Items marked CONFIRMED-BY-READING need a runtime demonstration before they are quoted as observed behaviour.

## 6. Addendum — evidence update after the audit cutoff (WP-DOC-02, 2026-10-11)

Original sections 0–5 are preserved unchanged. Reference commit at the time of writing: `49cc7d5cb639cd492823a803019758fd2abe216e`. Clean-snapshot evidence referred to: `71e5f5e` (clean `git archive`; 23 of 23 business run headers carry `71e5f5e…`, `dirtyPaths: []`, `sourceKind: clean-git-archive-snapshot`; folder `evidence-clean-snapshot-2026-10-11/71e5f5e-final/`) and `f881e53` (reviewer's re-run; 6 of 6 run headers carry `f881e53…`, `dirtyPaths: []`, clean snapshot; code identical to `71e5f5e` — `git diff --stat 71e5f5e f881e53 -- src tools` is empty per the verification report; folder `…/71e5f5e-reviewer-rerun/`, despite its name). Working-tree results are never counted as clean-snapshot evidence; code-reading findings stay labelled as such.

### 6.1 New finding

### PA-43 — UUID Repair May Invalidate Historical Audit Hash Chains (added after the audit cutoff by CTO decision, 2026-10-11)
| Field | Content |
|---|---|
| **Finding ID / domain / severity** | PA-43 · Audit integrity / Release Center data repair · **provisional Medium–High** (consequence conditional on the repair being needed and run; to be re-rated by WP-AUD-09) |
| **Nature / status** | CONFIRMED-BY-READING for the code fact; INFERRED for the consequence; need UNVERIFIED. **OPEN — CODE-REVIEW FINDING.** Separate from PA-33 (which concerns the `seq` value and the hash at rollback) |
| **Observation** | `src/database/uuid-repair.core.ts` repairs non-RFC-4122 ids by updating primary keys and then every referencing column. Its `SOFT_REFERENCES` table includes `audit_records.actorUserId` (under `users`, line 116) and `audit_records.organizationId` (under `org_units`, line 187). For each entry the core runs `UPDATE "<table>" SET "<column>" = <new id> WHERE "<column>" = <old id>` (line 461). Both columns are inputs of the audit hash. The core's header says ids inside the JSON columns `before`/`after` are deliberately not rewritten; the two scalar columns are. No hash recomputation, chain check or audit exemption exists in that file |
| **Evidence source** | Code reading: `uuid-repair.core.ts` lines 38, 95–116, 187, 458–476; `src/foundation/release/data-repair.service.ts` lines 10–11, 212, 220, 280; migration `1755853200000-AddDataRepairRunTable.ts` (permission leaf `system.release.*`, per its comment); `src/foundation/audit/audit-hash.ts`. Nothing was executed |
| **Reproduction** | Read-only: follow the lines above. A runtime demonstration, if ever approved, only on a disposable database with a seeded non-compliant id referenced by audit rows, comparing `verifyCompanyChain` before and after, under a separate authorization. **The repair must not be run on real or shared data** |
| **Impact (potential)** | If run on a database whose audit rows reference a repaired id, hashed fields of historical rows change and the chain would verify as broken from the first affected row; historical rows would be altered. An integrity-verification failure of historical evidence, not a loss of business data. **Inferred risk, not an observed incident** |
| **Proved / inferred / unknown** | Proved: the rewrite list includes the two audit columns, the `UPDATE` is generic over the list, and the hash includes those columns. Inferred: executing the repair would invalidate the chain for affected rows. Unknown: whether any Company needs the repair, whether it has ever run, whether another safeguard in the complete execution path prevents or detects the effect (the post-repair integrity check inspects references; no chain verification was found in the code read) |
| **Confidence** | VERIFIED (code facts) · INFERRED (consequence) · UNVERIFIED (need, compensating controls) |
| **Disposition** | Implemented — needs verification (investigation first) |
| **Closure acceptance criteria** | (1) The whole repair path traced and reviewed; (2) actual need established or excluded per Company by a read-only audit under authorised access; (3) if needed, a chain-preserving policy approved (DEC-25) before any repair is run, with a defined post-repair chain verification; (4) no historical audit row modified, rehashed or normalised by this work |
| **Constraints** | The repair is not run; no historical audit record is altered, re-hashed or normalised; any future handling needs independent review, explicit authorization and a separate scope |
| **Dependencies / owner / package** | Authorised read-only access; DEC-25 (DEC-02 related but independent) · Foundation/Release owner, reviewer independent of the code path · WP-AUD-09 |

### 6.2 Status and evidence updates to existing findings (original wording above is kept)

| Finding | Original statement (preserved above) | Update at `49cc7d5` | Evidence and class |
|---|---|---|---|
| PA-04 `fulfillReservation` | fixed in code, working-tree class, clean-snapshot pending, N-02 not closed | Fix `a798d9d`; **clean-snapshot evidence** on `71e5f5e` and `f881e53` (T-21 13 PASS, T-20 H3 PASS in both styles, `fulfillReservationsForOrder` sorted-key change in `5c5b791`). Independent review: peer reviews exist (`c804845`, `89a0a2a`, `5104e1e`, `66c63b9`) but the CTO ruled they do not satisfy the independence gate (the reviewer wrote the transaction rule). **Still not accepted; N-02 OPEN** | clean-snapshot (tests) · peer review (limited) |
| PA-05 limit / release / start | unremediated | H1, H2, H4 fixed in `5c5b791`; T-24 and T-20 PASS on `71e5f5e` and `f881e53` (clean snapshots). H5 shipment transitions still BLOCKED (fixture in progress); sibling methods NOT RUN. **Each finding keeps its own acceptance; none is closed** | clean-snapshot (tests) |
| PA-33 audit chain after rollback | confirmed by test, working-tree class | Fix `c764fc5` (`audit.service.ts`); T-22/T-23 PASS on `71e5f5e` and `f881e53` (T-23 7/7; T-22's explicit-seq case is a by-design characterisation); Team 3 scope review: the diff conforms to the CTO's authorization (`DAII-PA33-DIFF-SCOPE-REVIEW-2026-10-11.md`); DEC-01 confirmed narrowly. **Independent review and acceptance still pending; PA-33 OPEN**; existing broken chains untouched (DEC-02) | clean-snapshot (tests) · Team 3 scope review (not an independent closure review) |
| PA-22 isolation coverage and CI | 80 PASS / 1 BLOCKED / 19 NOT RUN; CI never run on a hosted runner | Three states preserved in the reconciliation note §7.2: A 80/1/19; B 90/9/1 (corrected: 89 executed-PASS, 1 skipped, 9 BLOCKED, 1 NOT RUN); C clean-snapshot run of 91 files on `71e5f5e`: 89 executed-PASS, 1 skipped, 1 known-BLOCKED failure. CI script at `f881e53`: install, build, structure, doc links, unit 59/430, guard PASS; **lint FAIL (3 errors, LA-1 files) → CI NOT GREEN** | clean-snapshot (isolation run: attribution by folder) |
| PA-41 LA-1 Layer 2 | 3 of 10 sites wired; no clean-snapshot result | The admission spec `company-lifecycle-admission.real-pg.spec.ts` is in the 91-file run and passed on `71e5f5e`; the two scheduler specs and the protected `company-audit-access` spec are not in that run. Seven sites still unwired. Lint errors belong to the LA-1 owner (WP-LA1-03) | clean-snapshot (admission spec) |
| PA-42 delta without clean-snapshot | open | **Resolved for the N-02 / PA-33 code** by the clean snapshots of `71e5f5e` / `f881e53`; open only for the LA-1 pieces not named above | clean-snapshot |
| PA-21 N-01 | closure recorded for local scope, sign-off pending | no change | — |
| PA-33 and PA-43 | — | kept separate: PA-43 concerns a different path that rewrites hashed historical fields | — |

### 6.3 Counts
Findings: 43 (PA-01…PA-43). Severity of the 42 original findings is unchanged by this addendum; PA-43 is provisionally Medium–High. No finding is closed by this addendum.

### 6.4 Update 2026-10-13 (handover closeout; original text above unchanged)
| Finding / item | Effect of the 2026-10-13 closeout | Evidence |
|---|---|---|
| PA-33 / WP-AUD-08 | Option B writer re-verified: T-04 alone PASS on it (`4dc3862`); T-03 alone PASS; 91-spec regression 89/1/1/0 on the first pass; T-26 expectations were **inverted** (success → refusal) in `b4821ab`, with stronger post-conditions — recorded for the reviewer. Still OPEN; independent review pending; DEC-01b holders unassigned; DEC-02 decision required | `DAII-HANDOVER-CLOSURE-REPORT-2026-10-13.md`; `DAII-DEC-01B-AND-DEC-02-AUDIT-CHAIN-DECISIONS-2026-10-13.md` |
| Test infrastructure (teardown race) | New test-infrastructure item closed in practice, not in cause: bounded retry `4dc3862`; recovered 2 real occurrences; root cause **unproven** | `evidence-clean-snapshot-2026-10-13/4dc3862-harness-retry/` |
| PA-43 | Pilot re-reviewed; real check not started (no approved role / database list): `NEED NOT ESTABLISHED`; not closed | `DAII-PA43-WP-AUD-09-STATUS-2026-10-13.md` |
| PA-04/05 (N-02), WP-INV-10 | No new evidence; review scope split (code / test-evidence); `INDEPENDENT REVIEW PENDING` | `DAII-INDEPENDENT-REVIEW-SCOPE-AND-READINESS-2026-10-13.md` |
| PA-29 (F-INV-001 residual) | 410 contract locally verified (T-09 36 PASS); release blocked on the usage measurement (DEC-10) | `DAII-CARRIED-ITEMS-STATUS-2026-10-13.md` §1 |
| PA-20 (D-04 integrations) | Decision Company-scoped; implementation not authorised; unchanged risk | same, §2 |
| Dependencies | Audit re-run: 65 advisories, unchanged; T1 sized (22 changes / 9 additions), none applied (DEC-20 open) | same, §3 |
| PA-24 / PA-26 (capacity, hosting) | unchanged: targets unsigned, no staging host | same, §4–5 |
| PA-41 (LA-1) | unchanged: 3 of 10 sites wired, 7 unwired (DEC-19) | — |
No finding is closed by this update.
