# DAII — HR & Accounting Integration Assessment (Team 3 Independent Product Audit) — 2026-10-11

Deliverable 6 of 6. Scope requested: the current HR, attendance, targets/performance, commissions, payroll, Accounting and Treasury workflows; integration gaps; and the proposed scope needed for a coherent end-to-end HR solution. Independent and read-only: no product code, schema, UI, permission or configuration changed; no database-backed test run by Team 3; no production or hosting access. Finding IDs (`PA-xx`) are defined in `DAII-PRODUCT-RISK-AND-TECHNICAL-DEBT-REGISTER-2026-10-11.md`; capability rows (`H-xx`, `A-xx`) in `DAII-PRODUCT-CAPABILITY-MATRIX-2026-10-11.md`.

**Baseline.** Audit cutoff 2026-10-11, source read at HEAD `b591d1f`; evidence baseline `a6002fa`. The N-02 and LA-1 Layer 2 changes made after `a6002fa` do not touch the HR, payroll, commission, attendance, treasury or payroll-posting code assessed here (`git diff a6002fa HEAD` lists none of those files except the installation-audit controller and two schedulers, which are not part of these workflows). **Evidence classes** are those of the register (clean-snapshot, working-tree, dated walkthrough, static reading, first-hand). Statements marked **CONFIRMED-BY-READING** are exact about the code and need a runtime demonstration before being quoted as observed behaviour.

## 1. Executive summary

1. The HR-to-pay chain exists end to end as **separate, well-structured services joined by read contracts and events**: employees → approved attendance batches → payroll calculation ← approved commission results ← sales events; payroll approval by a second person; automatic posting event; GL entry through the Financial Event Engine; human-triggered disbursement through Treasury gated on a confirmed GL posting. The design discipline (maker ≠ checker, immutability after posting, adjustment records, a reconciliation query for "posted without GL") is good.
2. **The chain does not yet reconcile to the ledger.** Three confirmed-by-reading problems sit on the payroll-to-accounting seam: the disbursement posts no GL entry (PA-34), the posting amount excludes commission that is paid in cash (PA-35), and payroll money is summed with floating-point arithmetic (PA-36). The one end-to-end spec that covers the chain asserts line amounts and journal *balance*, not journal *amount* or any post-disbursement ledger state, and is BLOCKED (PA-17), so no existing test would catch these.
3. **The chain is not yet a statutory HR solution.** No overtime, income tax, social insurance or payslip (PA-16); attendance and leave have no financial effect (PA-37); the HR master lacks contracts, documents, leave types/balances, shifts and the holiday calendar (PA-40); commission is not reversed on void/return (PA-38).
4. **Evidence is strongest at the primitives** (treasury, payments, numbering, audit append concurrency — clean-snapshot `a6002fa`), and **weakest exactly where HR meets Accounting** (no clean-snapshot evidence for any HR/payroll/commission/attendance domain; their evidence is per-domain specs and the first-hand working-tree runs of 2026-09).
5. A new data-integrity finding affects every domain that audits inside transactions, including payroll: a rolled-back audit write permanently breaks hash-chain verification (PA-33).
6. **Proposed scope** (§7) groups the work into seven packages ordered by dependency; the first three (ledger correctness, test net, policy decisions) are prerequisites for the rest, and nothing requires a rewrite.

## 2. Workflow map as implemented

```
HR:         Employee (status history, manager, user link) ─ Department ─ Leave request (approval)
                │                                                    │ isApprovedLeaveDate
Attendance:  Connector/Mapping ─ raw punch / Excel / biometric daily facts ─ derived Day ─ Correction ─ Approval batch
                │ approved days only (read contract)
Targets:    Target (draft → approval)  ──────────────┐  (approved target for date)
                                                      ▼
Sales:      Invoice posted / Collection remitted ──► Commission Result (flat | target-tiered) ─ Approval batch ─ Adjustment (manual)
                                                      │ approved results only (read contract)
Payroll:    Period ─ Compensation (earning lines) ─► Calculate (gross + commission − deductions[=0]) ─ Review ─ Submit
                                                      │ approval engine (maker ≠ checker) ─► approved → posted (automatic)
                                                      ▼ publishes payroll.run.posted {totalGross, totalNet, employeeCount}
Accounting: Financial Event Engine ─ handlePayrollRunPosted ─► Dr Salaries & Wages (5201) / Cr Wages Payable (control function)
                                                      │ FinancialEvent.status = POSTED gates disbursement
Treasury:   Disburse (human action, own permission) ─► cashOutForEmployee per line (netPay)  [NO_EMIT: no GL event]
```
Every box above is in `src/domains/{hr,attendance,targets,commission,payroll,treasury}` or `src/domains/accounting/application/financial-events`. Payroll, commission and attendance import each other's concrete services (payroll → hr, attendance, commission; commission → hr, targets; attendance → hr; targets → hr): seven of the 19 contract-bypassing imports in the architecture graph (PA-28). The imports are behaviourally correct today; they make the chain harder to change in pieces.

## 3. Domain-by-domain assessment

### 3.1 HR (employees, departments, leave)
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | Employees with status history, termination, manager assignment, user link; departments as org units; leave requests with approval and cancel; `isApprovedLeaveDate` read contract | `hr.service.ts` (methods listed), 3 entities, 3 frontend pages | Partly — `hr-phase1.spec`, 1 isolation spec; not clean-snapshot |
| Not implemented (charter Wave 2) | Contracts, employee documents, HR operations, leave types, balances/entitlements, shifts/schedules, loans/advances, end-of-service, performance reviews | charter §5; entity listing | Not assessed (PA-40) |
| Gap to payroll | Payroll reads `listEmployees` and filters `status === 'active'` and non-contractor; no contract dates, no grade, no bank/payment instrument | `payroll.service.ts` `calculate` | Confirmed by reading |

### 3.2 Attendance
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | Connector and employee mapping with open/close; manual punch; Excel and biometric daily-summary import with preview, unmapped-record queues, history; derived day, correction requests, approval batches (approved days feed payroll) | `attendance.service.ts` (~25 methods), 8 entities, 5 frontend pages | Partly; local-time handling fixed `54d8818` |
| Financial effect | None in practice: days are copied into payroll classification rows; absent/missing-punch → `unclassified`, no deduction; approved leave → label `approved_leave`, no effect (PA-37) | `payroll.service.ts` `classifyDay`; E2E spec lines ~190–195 | Confirmed by reading |
| Missing | Shift/schedule, holiday calendar, overtime hours, lateness rules | ADR-067 §C (holiday calendar open `ADR-053 §16`) | PA-16, PA-37 |
| Timezone | Business-date class open (PA-14) | commits `3ef67f4`, `54d8818`, `f2d15fa` | Suspected, fix present, unverified |

### 3.3 Targets and performance
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | Sales targets per employee and period with approval; `getApprovedTargetForDate` consumed by commission for target-tiered policies | `target.service.ts`, 1 entity, 1 page | Partly |
| Not implemented | Any non-sales performance management (reviews, goals, appraisal cycles, rating-driven pay) | search; entity listing | Not assessed (PA-40). No specification found |
| Integration risk | The commission target date is derived from `eventDate.toISOString().slice(0,10)` (UTC date) | `commission.service.ts:305` | PA-14 |

### 3.4 Commission
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | Policies (flat, target-tiered), tiers, results from `finance.invoice.posted` and `collection.remitted`, approval batches (maker ≠ checker), manual adjustments, `listApprovedCommissionResults` for payroll | `commission.service.ts`, 5 entities, 3 pages | Partly; Commission regression failure of 2026-09-21 (first-hand) followed by fix `f2d15fa`, no recorded clean re-run (PA-14) |
| Reversal | No subscription to invoice void, sales return, return credit; correction by manual adjustment only (PA-38) | `commission.service.ts` ~96–132 | Suspected |
| GL | Commission posts nothing itself (by design, ADR-072) and is **also absent from the payroll posting amount** (PA-35) | `payroll.service.ts` ~452–480 | Confirmed by reading |
| Basis | `net_sales` basis not buildable; flat/gross sales is the available case | ADR-071 §21 (cited by the spec) | per documents |

### 3.5 Payroll
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | Periods, compensation (earning lines), calculation (idempotent recompute while draft), review, submit, approval via the approval engine, automatic approved→posted with an outbox event, reconciliation-gap query, disbursement with advisory lock and duplicate guard, adjustments (no mutation after posting), a dedicated permission node per action, 4 frontend pages | `payroll.service.ts`, `payroll.controller.ts` | Partly — `payroll-phase1.spec`, integrated spec BLOCKED |
| Not implemented | Overtime, income tax, social insurance, other statutory deductions, payslip, payment batch file, employee bank details | class doc (ADR-067 §D/§E), search | PA-16 |
| Arithmetic | JavaScript `Number` sums and `toFixed(2)` throughout | `payroll.service.ts` | PA-36 |
| Dimensions | The posting carries no org unit / cost centre allocation of salary expense | event payload | PA-35 / A-16 |

### 3.6 Accounting (as it receives HR data)
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | One event path to the ledger (16 event types), balanced-journal enforcement in SQL, fiscal-period posting gate, control-function accounts (`wages_payable` exists), reconciliations (AR, AP, GRNI, inventory, WIP, fixed assets, cash/bank), month-end closing with approvals and snapshots | READ | R1–R10 oracle PASS CS:`a6002fa` for covered flows (payroll is not in R1–R10) |
| Payroll posting | `handlePayrollRunPosted`: Dr 5201 / Cr Wages Payable for `totalGross`; rejects with a reason if the control account is missing or inactive (tested in the BLOCKED spec's recovery case) | handler | Partly |
| Missing | Disbursement posting (PA-34); commission expense/liability (PA-35); tax and insurance payable accounts (PA-16); a wages-payable reconciliation in the sub-ledger suite and in the closing audit (no reference to `wages_payable` outside the handler and the control-function list) | grep | Confirmed by reading |
| Month-end | Payroll is not a closing-audit exception category; a posted-but-not-GL-confirmed run is detectable only through the payroll `reconciliation-gaps` endpoint | `closing-audit.service.ts` has no payroll reference | Confirmed by reading |

### 3.7 Treasury (as it receives payroll cash)
| Aspect | Finding | Evidence | Verification |
|---|---|---|---|
| Implemented | Accounts, cash in/out, transfers, limits, balances verified under concurrency (A-12); `cashOutForEmployee` records employee and run references | `treasury.service.ts` | Verified for balance integrity (T-05/T-14/T-16 CS:`a6002fa`) — payroll-specific cash-out is not part of those tests |
| Payroll leg | Hard-wired `NO_EMIT`: no `treasury.cash.recorded` event, hence no GL entry for payroll cash-out (PA-34) | `treasury.service.ts` ~32, ~381–390, ~734–755 | Confirmed by reading |
| Missing | Batch payment instruction/bank file, employee payment details, partial disbursement/rejection and re-issue, bank statement matching (PA-09) | search | PA-09 |
| Reconciliation | The cash/bank reconciliation compares GL to the treasury ledger and would expose PA-34 only if the treasury account is GL-mapped and the run is executed | `cash-bank-reconciliation.service.ts` | Inferred |

## 4. Integration-point matrix

| # | Hop | Mechanism | Status | Evidence | Gap / finding |
|---|---|---|---|---|---|
| I-1 | Employee ↔ attendance identity | `AttendanceEmployeeMapping` (connector id → employee) with open/close dates | Implemented, partly verified | `attendance.service.ts#createMapping` | unmapped queues exist; ownership of punch-id changes undocumented |
| I-2 | Leave → attendance day status | `isApprovedLeaveDate` (concrete import attendance → hr) | Implemented | `hr.service.ts:499` | no leave type/balance (PA-40) |
| I-3 | Attendance → payroll | approved batches via `listApprovalBatches` / `listApprovedDaysByBatch` (concrete import) | Implemented; effect informational only | `payroll.service.ts` `calculate` | PA-37 |
| I-4 | Target → commission | `getApprovedTargetForDate` (concrete import) | Implemented | `commission.service.ts:305` | UTC date derivation (PA-14) |
| I-5 | Sales → commission | subscriptions to `finance.invoice.posted`, `collection.remitted` | Implemented | `commission.service.ts` ~117–131 | no reversal on void/return (PA-38) |
| I-6 | Commission → payroll | `listApprovedCommissionResults` (concrete import), approved only | Implemented | `payroll.service.ts` ~305 | cut-off between in-flight adjustment and posted run described in ADR-072, not tested (PA-17) |
| I-7 | HR → payroll population | `listEmployees` filter active, non-contractor | Implemented | `calculate` | no contract/grade/payment data |
| I-8 | Payroll → approval engine | FA-01 request, SoD matrix rule, `onApprovalApproved` | Implemented; maker ≠ checker asserted in the BLOCKED spec | spec ~187–193 | spec BLOCKED |
| I-9 | Payroll → GL | `payroll.run.posted` event → handler → journal | Implemented | handler | amount excludes commission (PA-35); no cost-centre (A-16) |
| I-10 | GL confirmation → disbursement gate | `FinancialEvent.status = POSTED` check | Implemented | `disburse` | — |
| I-11 | Payroll → treasury cash-out | `cashOutForEmployee` per line | Implemented | `disburse` | no payment instrument; floating-point sums (PA-36) |
| I-12 | Treasury cash-out → GL | none | **Absent** | `NO_EMIT`; no publish in `disburse` | PA-34 |
| I-13 | Payroll/commission → month-end close | none | **Absent** | `closing-audit.service.ts` | PA-34/35/32 |
| I-14 | Business date across modules | `utcBusinessDate` helper in sub-ledger path; other conventions elsewhere | Partly | `3ef67f4` | PA-14 |
| I-15 | Authorization (salary data, approval, disbursement) | permission nodes `payroll.*`, approval matrix | Implemented | controller | field-level salary visibility and company/department scope UNVERIFIED |
| I-16 | Audit | `AuditService.record` in every action | Implemented | services | hash-chain breakage after rollback (PA-33) |
| I-17 | Company isolation | Company-routed managers, isolation specs for hr, attendance, payroll, commission, targets | Implemented | capability matrix (PASS rows) | WT-class evidence; LA-1 Layer 2 for background paths PARTIAL (PA-41) |

## 5. Confirmed defects versus suspected risks (HR/Accounting seam)

| Confirmed (tested) | Confirmed by reading (needs runtime demonstration) | Suspected / unverified |
|---|---|---|
| PA-33 audit chain after rollback (T-22, WT) | PA-34 disbursement without GL leg; PA-35 commission excluded from posting; PA-36 float arithmetic; PA-37 attendance has no effect; PA-39 default account 5299 | PA-38 commission not reversed; PA-14 timezone class (fix present, unverified); item I-15 salary visibility scope; cash/bank reconciliation exposing PA-34 |

## 6. Verification status of the chain

| Check | Status |
|---|---|
| Integrated Attendance → Payroll → Commission → GL E2E | **BLOCKED** (regression not clean at 2026-09-21; resume unrecorded) |
| Canonical serial regression of the four affected suites after `f2d15fa` | **NOT RUN / not recorded** |
| Journal amount equals sum of run lines | **NOT TESTED** (spec asserts balance and line count only) |
| Wages Payable cleared and bank GL credited after disbursement | **NOT TESTED** |
| Cash/bank reconciliation after a payroll cycle | **NOT TESTED** |
| Payroll in the R1–R10 oracle | **NOT COVERED** |
| Payroll/commission/attendance clean-snapshot evidence | **NONE** (only per-domain specs and first-hand WT runs) |
| Browser acceptance of HR/payroll/commission/attendance pages | **NOT ASSESSED** (no automated UI tests, PA-23) |

Nothing in this table is treated as a pass.

## 7. Proposed scope for a coherent end-to-end HR solution

Proposal only; nothing is authorised by this document and no implementation has begun. Sizes are relative (S/M/L). Every package ends with a verification step on a clean snapshot of a named commit.

| Pkg | Content | Findings | Depends on | Size | Acceptance (summary) |
|---|---|---|---|---|---|
| **HRX-0 Decisions and contracts (Phase 0, no code)** | Statutory payroll scope and effective dating (overtime, tax, insurance); holiday/working-day calendar ownership; absence and leave pay rules; payslip content and access; commission reversal policy; commission expense/liability accounts; wages-payable, tax-payable and insurance-payable accounts and the disbursement posting; business-date rule (UTC vs Cairo); payment batch/bank-file approach; cost-centre allocation of payroll expense; HR master contract (contracts, documents, leave types/balances, shifts) | PA-16, 34, 35, 37, 38, 40, 14 | CTO policy | S–M | Written ERP Integration Contract per ADR-053 §2; CTO sign-off |
| **HRX-1 Ledger correctness (payroll ↔ accounting ↔ treasury)** | Disbursement GL entry through the Financial Event path with idempotency and a gap detector; posting amount per contract (gross + commission, later tax/insurance split); decimal-safe arithmetic; cost-centre allocation; wages-payable reconciliation added to the sub-ledger suite and the closing audit | PA-34, 35, 36, A-16 | HRX-0 | M | Journal amounts = sum of run lines = cash paid; Wages Payable zero after full disbursement; cash/bank reconciliation clean; payroll added to R1–R10; idempotent re-run |
| **HRX-2 Integrity primitives** | Audit chain fix for rolled-back writes; F03 retry re-verification on HEAD; timezone rule applied through one helper | PA-33, 13, 14 | CTO authorisation / decision | M | T-22 PASS; F03 verification PASS; fixtures at 23:30–03:30 Cairo; serial regression clean |
| **HRX-3 Test net** | Chain test (HR → attendance → payroll → commission → GL → treasury) with numeric oracle extended; payroll in the oracle; browser E2E for payroll, commission, attendance, HR pages; permissions matrix tests | PA-17, 23, 03 | HRX-1 for the new assertions | M | Integrated spec extended and PASS on a pinned commit; UI checks recorded |
| **HRX-4 HR master completion** | Contracts, employee documents, leave types and balances, shifts/schedules, holiday calendar | PA-40, 37 | HRX-0 | L | Lifecycle and isolation specs; HR pages; audit trail |
| **HRX-5 Time-to-pay rules and statutory computation** | Absence/leave/lateness/overtime rules from HRX-0; income tax and social insurance with effective-dated tables; tax/insurance liabilities in the ledger; payslip document with numbering, access and print/export | PA-16, 37 | HRX-0, HRX-1, HRX-4 | L | Golden fixtures by rule; GL liabilities; payslip access tests; run reproducible from a snapshot of inputs |
| **HRX-6 Commission integrity** | Reversal on void/return/credit (or reviewed queue); GL recognition of commission expense and liability; payroll cut-off interaction tests | PA-38, 35 | HRX-0, HRX-1 | M | Void/return scenarios reverse or queue; cut-off cases pass |
| **HRX-7 Treasury and month-end** | Payment batch instruction, rejection/re-issue, bank-statement matching for payroll payments (shared with PA-09), closing-audit exception category for payroll | PA-09, 34 | HRX-1 | M | Batch lifecycle tests; statement matching fixture; closing audit lists unposted/undisbursed runs |

**Ordering.** HRX-0 first (decisions unlock everything); HRX-1 and HRX-2 next and in parallel (they remove the confirmed defects and are small relative to the risk); HRX-3 beside them; HRX-4 and HRX-5 then HRX-6 and HRX-7. Phase 0 contains HRX-0 only. Phase 1 contains HRX-1…HRX-7 for HR plus the Accounting work packages in the roadmap input; the Phase 1 HR exit criteria are those of the roadmap input §5.2.

**Out of proposed scope (Phase 2 candidates, unspecified today):** recruiting and onboarding, employee self-service, performance-review cycles, training, benefits administration, expense claims, time-sheets for project costing.

## 8. Unresolved questions

1. Which jurisdiction(s) and which statutory rules apply (overtime, tax, insurance, end-of-service)? Who is the business owner who signs the rate tables?
2. Is the intended GL shape for payroll exactly gross-plus-commission at posting and `Dr Wages Payable / Cr Bank` at disbursement (ADR-070/072), and which account carries commission expense?
3. Was the omission of the disbursement GL leg (`NO_EMIT`) an intended deferral or a defect? The code comment says the effect was "already posted" — which does not match the handler.
4. Has the Commission regression been re-run clean since `f2d15fa`? If yes, where is the evidence?
5. Should absence, lateness and unpaid leave reduce pay in Phase 1, or does attendance stay informational?
6. Is Cairo or UTC the business-date rule?
7. Is commission to be reversed automatically on void/return, or reviewed?
8. Who may see salary data (per company, per department, per role)? The permission nodes exist; field-level scope is not verified.
9. How are employees paid (bank transfer file, cash, wallet)? No payment-instrument data exists.
10. Must payroll expense be allocated to departments/cost centres in the ledger?
11. Are contracts and documents required inside DAII in Phase 1, or are they Phase 2?
12. Does the audit-chain fix (PA-33) need to repair existing Companies' chains, or only prevent new breaks?

## 9. Limitations

Static reading and existing reports only; no new test execution, no browser, no hosting. The runtime consequences of PA-34/PA-35/PA-36 are derived from exact code facts and need a read-only demonstration on a disposable Company in an authorised cluster window. Payroll, commission and attendance have no clean-snapshot evidence; the first-hand 2026-09 runs are working-tree class. Charter and ADR texts are cited as written; Team 3 did not assess whether they remain the CTO's intent. No parity with any reference payroll product is claimed.
