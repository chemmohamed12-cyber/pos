# Integrated Attendance → Payroll → Commission → GL: E2E Verification Specification

**Status: SPECIFICATION ONLY — not executed, not authorized for execution
yet.** Written by the Manufacturing session per CTO assignment
(2026-09-20), while Attendance Frontend and Payroll/Commission
implementation are actively being built by other, dedicated sessions. This
document defines *what* must be checked and *how*, so the integrated E2E
can run immediately once those sessions land, without a second
design/discovery cycle. It does not implement anything, and per the CTO's
explicit instruction it is **not to be executed while the downstream
Payroll/Commission APIs are still changing**.

Built strictly from `ADR-067` (Payroll Policy, RATIFIED), `ADR-068`
(Commission & Target Policy, RATIFIED), `ADR-069` (Attendance Completion &
Payroll Handoff, CLOSED), `ADR-070` (Payroll Phase 1 Implementation
Contract), `ADR-071` (Commission & Target Phase 1 Implementation
Contract), `ADR-072` (the Integrated E2E Contract these two meet through),
and direct, live verification of the current Attendance/Manufacturing/
Accounting source this session. No policy is reopened, reinterpreted, or
guessed here — every checkpoint below traces to one of those documents or
to source code read directly this session, and every checkpoint whose
concrete shape (an exact endpoint path, permission-node name, or field)
does not yet exist in committed, stable source is marked
**UNVERIFIED — resolve during implementation/E2E preparation**, never
invented.

---

## 1. Objective

Prove, on live PostgreSQL, that the two chains `ADR-072` specifies on
paper are also true in the running system:

```
Chain A: Employee → Sales Rep → Customer → Invoice/Collection →
         Commission Policy → Commission Result → Approval →
         Payroll → GL

Chain B: Employee → Attendance (Biometric Daily Summary) → Day Type →
         Payroll Pay Impact
```

and that the point where both chains converge — `PayrollRun` consuming
Attendance facts and Commission results, then posting exactly one GL
journal via the existing Financial Event architecture — behaves exactly
as `ADR-070 §6/§13`'s corrected semantics require: `PayrollRun.status =
'posted'` is **not** evidence the GL journal exists; only
`FinancialEvent.status = 'POSTED'` is.

## 2. Scope

**In scope:** the full chain from a Biometric Daily Summary import and a
Sales invoice/collection, through Attendance approval and Commission
approval, through Payroll calculation/review/approval/posting, to a
balanced GL journal — verified via direct API calls and direct PostgreSQL
queries (never inferred from an HTTP 200 alone, matching this program's
own established verification discipline, e.g. `work-order.spec.ts`,
`wip-reconciliation.spec.ts`).

**Out of scope (per the CTO's explicit boundary, §17 below):**

- Any F03 GL-posting **concurrency remediation**. This specification
  verifies the chain's **normal, single-threaded** posting path only. The
  known deadlock (`F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`, commit
  `b5a9a85`) is a separate, already-escalated, unremediated §16 item — see
  §17.
- Anything `ADR-070 §20` / `ADR-071 §20` / `ADR-072 §20` already named as
  a non-goal (Contractor payroll, automatic tax/gratuity/overtime
  engines, Region/Product/Campaign/Territory Target dimensions, a
  `CustomerGroup` entity, etc.).
- Attendance Frontend UX verification (owned by the Attendance session)
  and Payroll/Commission Frontend (not yet built).
- Any change to Manufacturing, WIP, or Manufacturing valuation/
  reconciliation — this specification's only interaction with
  Manufacturing is the negative check in §16 (Manufacturing must not
  create a second GL entry point).

## 3. Preconditions

Before this specification can be **executed** (not merely read), all of
the following must independently be true — each is currently either
confirmed or explicitly flagged:

| Precondition | Status as of this writing |
|---|---|
| Attendance biometric import (AC-No., Daily Summary, facts, approval) | **VERIFIED — committed.** `9d43a1a`, `49938c7`, `45e595e`. 15/15 biometric tests, 20 suites / 181 backend tests passing (per `9d43a1a`'s own commit evidence — not independently re-run by this session). |
| `AttendanceService.listApprovedDaysByBatch(batchId)` (`ADR-070 §9`'s required additive read method) | **VERIFIED — present in source**, `attendance.service.ts:671-673`, confirmed by direct read this session (currently part of the Payroll session's in-progress, uncommitted work). |
| `payroll` module, entities, `PayrollService` | **IN PROGRESS, uncommitted** (`backend/src/domains/payroll/`, `payroll.manifest.ts` exist on disk as of this writing). **UNVERIFIED** — not stable; this specification does not rely on its current shape, only on `ADR-070`'s contract. |
| `commission`/`targets` modules | **NOT YET PRESENT** as of this writing (no `backend/src/domains/commission/` or `.../targets/` directory found). **UNVERIFIED.** |
| Manufacturing (Work Orders, WIP, GL split) | **VERIFIED — CLOSED.** Phases 1–3 PASS, commits `3b5c634`/`246d718`/`7079eae`. Referenced only for the negative check in §16. |
| F03 GL posting (`journal-entry.service.ts`, `financial-event.service.ts`) | **VERIFIED — stable, understood, and has one KNOWN, unremediated concurrency defect.** See §17. |
| A `wages_payable` `ControlFunction` value and an active, postable GL account carrying it | **UNVERIFIED** — `ADR-070 §16` specifies the addition; not confirmed present in the current chart of accounts as of this writing. Must be confirmed (or seeded, per whatever migration the Payroll implementation ships) before Chain A/B §19 item 3 can execute. |
| A live PostgreSQL dev database, reachable the same way every prior live-DB spec in this program already connects (`AppModule` via `Test.createTestingModule`) | **VERIFIED** — this session's own Manufacturing/F03 work used this exact connection path successfully throughout. |

**This specification must not be executed until every row above reads
VERIFIED.** As of this writing, three do not.

## 4. Test Data

Fresh, dedicated fixtures only — never shared/pre-existing rows — matching
this program's own established discipline (every live spec written this
session used a `${Date.now()}-${random}` suffix to avoid collision with
concurrent test runs or other sessions' own fixtures). Proposed shapes
below; exact creation calls depend on each domain's final, stable API
(most fields UNVERIFIED for Payroll/Commission specifically, per §3).

- **One `Employee`** (HR, already-stable API), `employmentType = 'full_time'`, linked to a fresh `User`.
- **One `AttendanceEmployeeMapping`** (AC-No. ↔ this Employee), via `POST /attendance/mappings` (VERIFIED route, `attendance.controller.ts:106`).
- **One `Customer`** (CRM, already-stable API) with a `CustomerAssignment.salesRepUserId` = the Employee's linked `User`.
- **One `CommissionPolicy`**, `scope='customer'`, `scopeRefId=<that Customer's id>`, `basis='gross_sales'`, `rateModel='flat'` — the unambiguous, ratified-and-buildable case `ADR-071 §21` itself names as available today (flat/gross, not `net_sales`, not `customer_group`). Creation endpoint: **UNVERIFIED**.
- **One `PayrollCompensation`** for the Employee with at least one `PayrollEarningLine` (`componentCode='basic'`). Creation endpoint: **UNVERIFIED**.
- **A Biometric Daily Attendance Summary workbook** covering a short period (e.g. 5 calendar days) spanning the three Chain B cases (§19 item 4): one normal present day, one genuine unexplained absence on a day this test explicitly configures as a working day (`PayrollCalendarPolicy` — see the flag below), and one absence on a date deliberately left unconfigured in `PayrollCalendarPolicy` (proving the `unclassified` fail-safe).
- **One approved `LeaveRequest`** (HR, already-stable API) covering one further day in the same period, to prove the `on_leave` path.
- **A `PayrollCalendarPolicy` configuration** for the test period, distinguishing at least one explicit working day from at least one explicitly-left-unconfigured day. **UNVERIFIED** — `ADR-070 §21` leaves this entire mechanism as an open, unresolved §16 escalation (no holiday-calendar source is ratified); this specification can only test the `unclassified` fail-safe path, never a real weekend/holiday resolution, until that escalation closes.
- **One Sales Order → Invoice, posted**, against the fixture Customer, sized so its `gross_sales` commission is a clean, easily-verified number (e.g. an invoice total chosen so the flat rate produces a round figure).

## 5. Exact Execution Sequence

```
1.  Create Employee (HR) + linked User.
2.  Create AttendanceEmployeeMapping (AC-No. ↔ Employee).
3.  Import Biometric Daily Summary covering the test period (§4) —
    template → preview → confirm, exactly as `attendance.controller.ts`
    already exposes (VERIFIED routes, §6).
4.  Confirm AttendanceDay rows derive correctly per case (present /
    absent-working / absent-unclassified / on_leave) — §6/§8 checkpoints.
5.  Submit + approve the AttendanceApprovalBatch (FA-01) covering the
    period.
6.  Create Customer + CustomerAssignment(salesRepUserId = Employee's User).
7.  Create the CommissionPolicy (customer-scope, flat, gross_sales).
8.  Post the Sales Invoice against that Customer.
9.  Confirm the Commission Resolution Engine produced exactly one
    CommissionResult, correctly reflecting the Customer-level policy
    (not a Sales-Rep default) — `ADR-072 §19` item 1.
10. Submit + approve the CommissionApprovalBatch (FA-01, distinct
    approver from whoever triggered the calculation).
11. Create PayrollPeriod + PayrollCompensation (+ PayrollEarningLine)
    for the Employee.
12. Create + calculate() the PayrollRun for that period.
13. Confirm PayrollRunLine.commissionAmount reflects the approved
    CommissionResult, and PayrollAttendanceDayClassification correctly
    reflects every day from step 4 — `ADR-072 §19` item 2 and item 4.
14. review() → approve() the PayrollRun (FA-01, distinct approver from
    the calculate()/review() actor).
15. Confirm the automatic approved→posted transition (ADR-070 §5) fires
    without a second human action, and PayrollRun.status = 'posted'
    immediately at that transaction's commit.
16. Confirm (separately, after step 15, allowing for the async
    dispatch) that a FinancialEvent row exists
    (sourceDomain='payroll', sourceEntityType='PayrollRun',
    sourceEntityId=<this run's id>) and resolves POSTED under normal,
    single-threaded execution (§17's boundary — this step is NOT run
    concurrently with any other GL posting).
17. Query the GL journal directly: exactly one balanced entry,
    Dr Salaries & Wages Expense / Cr Wages Payable
    (`resolveControlAccount('wages_payable')`), traceable back through
    PayrollRunLine → CommissionResult → the Invoice from step 8.
18. Attempt PayrollService.disburse(runId) — must succeed only because
    step 16 resolved POSTED (§14 negative-case variant below tests the
    reverse).
19. Repeat steps 11–18 as a SECOND run, this time deliberately
    deactivating the `wages_payable` control account before step 15/16,
    to exercise the REJECTED path (§18's failure/recovery scenarios) —
    confirms PayrollRun still reaches 'posted' (ADR-070 §5/§6), the
    reconciliation query (§9 below) flags it, and disburse() is refused
    — then reactivate the account and confirm the outbox retry
    self-heals (`ADR-072 §19` items 7–8).
20. Create a CommissionAdjustment against the Chain-A CommissionResult
    AFTER step 15 (the run already posted) — confirm it does NOT alter
    the posted PayrollRunLine/journal, and is only visible in whatever
    the "first eligible not-yet-posted run" resolves to (`ADR-072 §14`).
```

Every numbered step below in §6–§16 maps back to one or more of these
sequence steps.

## 6. API Checkpoints

Grouped by domain. **VERIFIED** entries are confirmed present, by exact
path, from this session's own direct reading of committed source.
**UNVERIFIED** entries reference the contract's own named service method
(the checkpoint's *identity* is fixed by the ADR even though its REST
shape is not yet built) — these must be resolved against real source
before execution, never assumed.

**Attendance (VERIFIED, all from `attendance.controller.ts`, committed):**

| Checkpoint | Method + Path |
|---|---|
| Create AC-No. mapping | `POST /attendance/mappings` |
| Biometric template | `GET /attendance/biometric-import-template` |
| Biometric preview (no write) | `POST /attendance/biometric-import/preview` |
| Biometric confirm import | `POST /attendance/biometric-import` |
| Unmapped AC-No. rows | `GET /attendance/biometric-import/unmapped` |
| Import history | `GET /attendance/biometric-import/history` |
| Biometric facts (source, audit) | `GET /attendance/biometric-facts?employeeId=` |
| Derived days | `GET /attendance/days?employeeId=` |
| Submit approval batch | `POST /attendance/approval-batches` |
| List approval batches | `GET /attendance/approval-batches` |
| Decide (approve/reject) — generic FA-01 route, both batches and corrections | `POST /attendance/approvals/:requestId/decide` |
| Day correction | `POST /attendance/days/:id/correct` |

**Payroll — UNVERIFIED, named by `ADR-070`'s own service boundary (§7),
not yet a committed REST surface:**

| Checkpoint | ADR-070 reference |
|---|---|
| Compensation create/edit | `PayrollService` compensation CRUD, §7 |
| Period create | `PayrollPeriod` management, §7 |
| Run create + `calculate()` | §5, §7, §9 (day-type table), §13 |
| Run `review()` | §5 |
| Run FA-01 submit (`approve` transition's maker side) | §10 |
| FA-01 decide (checker side) — likely the same generic `/approvals/:requestId/decide` shape every other FA-01 consumer in this codebase uses (Attendance, and presumably Manufacturing-adjacent domains where applicable) — **UNVERIFIED, not assumed** | §5, §10 |
| `disburse(payrollRunId)` | §9, own permission node `payroll.run.disburse` (candidate name, §10) |
| Adjustment/correction create | §18 |
| §15's reconciliation query, exposed as an endpoint or report | §15 (query shape given verbatim in the ADR — see §9 below — but no endpoint is named) |

**Commission/Targets — UNVERIFIED, no domain code exists yet as of this
writing:**

| Checkpoint | ADR-071 reference |
|---|---|
| `Target` create + FA-01 submit/approve | §4, §6, §10 |
| `CommissionPolicy`/`CommissionTier` create | §5, §8 |
| Commission calculation trigger (event-driven, not a direct endpoint — subscribes to `finance.invoice.posted`/`collection.recorded`/`collection.remitted`, §9) | §9 |
| `CommissionApprovalBatch` submit + FA-01 decide | §6, §10 |
| `listApprovedCommissionResults(employeeId, periodStart, periodEnd)` — Payroll's own read contract into Commission | §9 (this exact method name is fixed by the ADR; whether it is exposed as a direct service call — the contract's own stated shape, "direct module import of a read-only query," §3 — or also as an HTTP route is **UNVERIFIED**) |
| Adjustment/correction create | §18 |

**Accounting/GL (VERIFIED, this session's own direct reading, Manufacturing/RCA work):**

| Checkpoint | Location |
|---|---|
| Financial Event list/get | `GET /accounting/financial-events`, `general-ledger.controller.ts:368` (existing, confirmed this session while building Manufacturing's own Financial Events UI) |
| Redrive a REJECTED event | `POST /accounting/financial-events/:id/redrive` |
| GL account resolution | `GLAccountService.resolveControlAccount` (not a direct endpoint — invoked inside Financial Event handlers only) |

## 7. PostgreSQL Checkpoints

Direct queries, not inferred from HTTP status — matching this program's
own established discipline. Table names below are **VERIFIED** where the
domain is committed (Attendance, Accounting); **UNVERIFIED, contract-named
only** where the domain (Payroll/Commission/Targets) is still in progress
— the ADRs name these tables (`ADR-070 §4`, `ADR-071 §4/§5`) but their
exact Postgres column/table names are Implementation detail not yet fixed.

```sql
-- Attendance (VERIFIED tables)
SELECT * FROM attendance_biometric_daily_facts WHERE "deviceUserRef" = $1;
SELECT * FROM attendance_days WHERE "employeeId" = $1 ORDER BY "calendarDate";
SELECT * FROM attendance_approval_batches WHERE id = $1;

-- Payroll (UNVERIFIED — contract names only, ADR-070 §4)
SELECT * FROM payroll_runs WHERE id = $1;                       -- table name UNVERIFIED
SELECT * FROM payroll_run_lines WHERE "payrollRunId" = $1;       -- table name UNVERIFIED
SELECT * FROM payroll_attendance_day_classifications WHERE ...; -- table name UNVERIFIED

-- Commission (UNVERIFIED — contract names only, ADR-071 §5)
SELECT * FROM commission_results WHERE id = $1;                 -- table name UNVERIFIED
SELECT * FROM commission_approval_batches WHERE id = $1;        -- table name UNVERIFIED

-- The one query given VERBATIM by ADR-070 §15 itself — reproduced exactly,
-- not re-derived, pending confirmation that the shipped Payroll migration
-- uses these exact column names:
SELECT pr.id FROM payroll_runs pr
LEFT JOIN accounting_financial_events fe
  ON fe."sourceEntityType" = 'PayrollRun' AND fe."sourceEntityId" = pr.id
WHERE pr.status = 'posted'
  AND (fe.id IS NULL OR fe.status NOT IN ('POSTED'));

-- Accounting/GL (VERIFIED — this session's own direct use, e.g.
-- wip-reconciliation.spec.ts, work-order-phase3-e2e.spec.ts)
SELECT * FROM accounting_financial_events WHERE "sourceDomain" = 'payroll' AND "sourceEntityId" = $1;
SELECT jl.*, a."controlFunction" FROM accounting_journal_lines jl
  JOIN accounting_gl_accounts a ON a.id = jl."accountId"
  WHERE jl."journalEntryId" = $1;
SELECT * FROM accounting_gl_accounts WHERE "controlFunction" = 'wages_payable'; -- UNVERIFIED: this ControlFunction value/account must be confirmed present (§3)
```

## 8. Expected State Transitions

All three `ProcessEngineService`-driven state machines, per `ADR-072 §5`
(restated from `ADR-070 §5`/`ADR-071 §6`, VERIFIED as the CONTRACT — the
actual `ProcessDefinition` registration is UNVERIFIED until Payroll/
Commission are committed):

```
Target:                  draft → pending_approval → approved | rejected
CommissionApprovalBatch: draft → submitted → approved | rejected
PayrollRun:               draft → calculated → reviewed → approved → posted
                           (approved → posted is AUTOMATIC, ADR-070 §5 —
                            not a second human action; verify this fires
                            without any additional API call between
                            approve() and PayrollRun.status='posted')
```

**Attendance (VERIFIED, current `AttendanceDayStatus`, `attendance-day-status.ts`):**
`present | absent | on_leave | missing_punch` — exactly four values, no
`late`/`early_departure`/`holiday` (ratified `ADR-063 §1:C`/`§7:B`,
unchanged).

**Day-type classification (contract table, `ADR-070 §9`, UNVERIFIED
until Payroll's own enum/column values are committed):**
`working | weekend | holiday | approved_leave | unclassified`, with
`payImpact ∈ {none, deduction, leave}`.

## 9. Financial Assertions

1. Exactly one `FinancialEvent` row per posted `PayrollRun`
   (`sourceDomain='payroll'`, `sourceEntityType='PayrollRun'`,
   `sourceEntityId=<runId>`) — never zero, never more than one, per
   `ADR-070 §6`'s reconciliation invariant, given verbatim as the SQL in
   §7 above.
2. When that event resolves `POSTED`: exactly one journal entry, its
   `Σdebit = Σcredit` (the same direct-SQL balance check every prior live
   spec in this program uses, never an application-layer sum), touching
   only `Salaries & Wages Expense` (debit) and the `wages_payable`
   control account (credit) — no other account, no P&L account beyond
   the one named, matching Manufacturing's own "asset/expense
   reclassification only, no surprise accounts" verification style
   (`work-order-phase3-e2e.spec.ts`, Items 7/8).
3. `PayrollRun.status = 'posted'` **must not**, by itself, be treated as
   proof of #1/#2 — the specification's own test harness must query
   `FinancialEvent` independently and never assume `postedAt` being set
   implies GL success (`ADR-070 §6`, `ADR-072 §6`'s restated invariant —
   this is the single most important assertion in this entire
   specification, given it is the exact P0 gap the CTO's own Final
   Review on `ADR-070` corrected).
4. Commission produces **zero** GL entries anywhere, ever
   (`ADR-071 §16`) — a direct, negative-result query
   (`SELECT COUNT(*) FROM accounting_financial_events WHERE "sourceDomain" = 'commission'`)
   should always return `0`.
5. Attendance produces **zero** GL entries anywhere, ever (`ADR-062 §8`,
   restated `ADR-072 §6`) — same negative-result-query pattern.

## 10. Idempotency Assertions

1. Redelivering the `payroll.run.posted` outbox event never produces a
   second `FinancialEvent` row (F03's own `UNIQUE(idempotencyKey)`,
   inherited for free, `ADR-070 §12`) — verify via
   `SELECT COUNT(*) FROM accounting_financial_events WHERE "idempotencyKey" = $1`
   staying `1` after a forced redelivery attempt.
2. Re-invoking `PayrollService.disburse(runId)` a second time for an
   already-disbursed run is rejected (`ConflictException`, mirroring
   `SupplierPaymentService.recordPayment`'s own proven advisory-lock/
   already-paid guard, `ADR-070 §9`).
3. Re-invoking `calculate()` on a `draft` run is a safe, idempotent
   recompute (discards prior draft lines); attempting it on a
   non-`draft` run is rejected by `ProcessEngineService.transition`
   itself, never reaching application code (`ADR-070 §12`).
4. Commission's own calculation dedup key (`ADR-071 §12`) correctly
   distinguishes an Invoice-triggered calculation from a
   Collection-triggered one against the *same* invoice — a redelivery of
   either alone is a no-op; the two are never conflated as "the same
   event." Exact key shape is **UNVERIFIED** (Implementation detail per
   the ADR itself) — this assertion tests the *invariant*, not a
   specific column.

## 11. SoD Assertions

1. Attendance: the maker of the approval-batch submission cannot also
   approve it — already proven live (`attendance-phase1.spec.ts:161-164`,
   VERIFIED, cited by `ADR-070 §19` item 6 as the reused pattern).
2. Payroll: the actor who ran `calculate()`/`review()` cannot also
   `approve()` the same `PayrollRun` (`ADR-070 §19` item 6) —
   **UNVERIFIED until Payroll's FA-01 wiring is committed**, but the
   assertion itself is fixed by the ADR and does not change.
3. Commission: the maker of a `CommissionApprovalBatch`/`Target`
   submission cannot also approve it (`ADR-071 §19` item 7) —
   **UNVERIFIED until Commission is committed.**
4. Disbursement (`payroll.run.disburse`) is gated by its own,
   *separate* permission node from `payroll.run.approve` — SoD may
   require different actors to hold the two (`ADR-070 §10`) — verify a
   user holding only `payroll.run.approve` cannot call `disburse()`.
5. FA-01's own generic maker≠checker enforcement
   (`approval-engine.service.ts:231-234`, VERIFIED, already the
   mechanism every domain in this chain reuses) is the single underlying
   guarantee behind #1–#3 — this specification does not test a new SoD
   mechanism per domain, only that each domain correctly registered its
   approval type through it.

## 12. Period-Control Assertions

1. A `PayrollRun`'s `approved → posted` transition performs **no**
   Financial-Period check at all (`ADR-070 §6/§17`, corrected) — verify
   a run posts (Payroll-side) even when its business date falls in a
   closed Financial Period.
2. The **journal** for that same run is then rejected inside the
   separate Financial Event Handler transaction
   (`FiscalPeriodService.assertOpenForPosting`,
   `journal-entry.service.ts:334`, VERIFIED mechanism, this session's
   own direct reading) — confirm the resulting `FinancialEvent.status =
   'REJECTED'`, and that §7's reconciliation query flags this exact run.
3. `PayrollPeriod` (Payroll's own concept), `CommissionApprovalBatch`'s
   period, and the Financial Period are three independent concepts,
   never merged (`ADR-072 §17`) — verify no code path conflates
   `PayrollPeriod.status='closed'` with `assertOpenForPosting`'s own,
   separate Financial Period check.

## 13. Correction Assertions

1. Post-`posted`, no direct `UPDATE` to a `PayrollRunLine`/
   `PayrollDeductionLine` row succeeds through the service layer — only
   a new `PayrollAdjustment` row is accepted (`ADR-070 §18/§19` item 9).
2. A `CommissionAdjustment` created after its originating
   `CommissionResult`'s consuming `PayrollRun` already posted does
   **not** alter that run's `PayrollRunLine`/journal — verify byte-for-
   byte (or at minimum, value-for-value on every financial column)
   before/after the adjustment is created, the same "snapshot the row
   before and after" technique `49938c7`'s own Attendance verification
   already used for `LeaveRequest` immutability.
3. That same adjustment is visible only in whichever run the "first
   eligible not-yet-posted run" resolves to (`ADR-072 §14/§18`) — never
   silently blended into a recalculation of the already-posted run.
4. A `CommissionResult` field, once written, is never updated by any
   code path — only a `CommissionAdjustment` row may reference it
   (`ADR-071 §7/§18`).
5. `AttendanceDay` corrections already follow the split-authority rule
   `ADR-063 §8:C` ratified (batch-status-dependent) — **VERIFIED,
   already shipped**, `attendance.service.ts`'s `correctDay`; this
   specification's job is only to confirm a *corrected* day still
   produces the expected downstream Payroll classification once
   re-consumed by a later run, not to re-verify the correction mechanism
   itself (already covered by `attendance-phase1.spec.ts`).

## 14. Attendance → Payroll Boundary Assertions

1. Payroll reads Attendance **exclusively** through
   `listApprovedDaysByBatch(batchId)` (`ADR-070 §9`, VERIFIED present in
   source, `attendance.service.ts:671-673`) — never a raw
   `AttendanceRawRecord`/`AttendanceBiometricDailyFact` read
   (`ADR-062 §8`'s facts-only boundary, restated `ADR-072 §6`).
2. The day-type determination table (`ADR-070 §9`) is applied exactly:
   `on_leave → approved_leave/none`; `present → working/none`;
   `missing_punch → working/none` (Phase 1: never an automatic
   deduction); `absent` → calendar lookup (`weekend/holiday/working` per
   configured `PayrollCalendarPolicy`, or `unclassified/none` if
   unconfigured — the mandatory fail-safe, `ADR-070 §6`).
3. **Case A** (per the original CTO directive this session's earlier
   Manufacturing/RCA work also referenced): `Absent=True` with blank
   Clock In/Out produces zero `AttendanceRawRecord` rows and
   `AttendanceDay.status='absent'` — already **VERIFIED, shipped**,
   `49938c7`'s own explicit DB-level assertion. This specification's
   job is only to confirm that same day, once consumed by Payroll, lands
   correctly as `dayType='working', payImpact='deduction'` (if the date
   is a configured working day) or `unclassified/none` (if not) — never
   silently defaulting to a deduction without a resolved day type.
4. **Case B**: `Absent=True` + an Approved `LeaveRequest` resolves to
   `AttendanceDay.status='on_leave'` with the `LeaveRequest` itself
   byte-unmodified — already **VERIFIED, shipped**, `49938c7`. This
   specification confirms Payroll then classifies that day
   `dayType='approved_leave', payImpact='none'` — never a deduction.
5. **Case C**: Clock In/Out + Late/Early/OT Time remain opaque source
   facts on `AttendanceBiometricDailyFact`, never fed into `deriveDay`
   and never presented by Payroll as an automatic amount — confirm
   `PayrollRunLine` has no column populated from `lateValue`/
   `earlyValue`/`otTimeValue` directly (`overtimeAmount` stays `0`/`null`
   in Phase 1 regardless of any `otTimeValue` present on the source fact,
   per `ADR-070 §21`'s explicit non-goal).

## 15. Commission → Payroll Boundary Assertions

1. Payroll reads Commission **exclusively** through
   `listApprovedCommissionResults(employeeId, periodStart, periodEnd)`
   (`ADR-071 §9`) — never `CommissionPolicy`/`CommissionTier`/`Target`
   directly (`ADR-071 §8`).
2. That read returns **only** results whose batch is `approved` — never
   `pending_approval`/`rejected` (`ADR-072 §19` item 8).
3. A `CommissionResult` approved *after* the consuming `PayrollRun`'s own
   `calculate()` already ran is **not** retroactively pulled in
   (`ADR-072 §5/§6`) — it becomes eligible only for the next run that has
   not yet calculated.
4. Customer-level policy resolves ahead of Sales-Rep-level for the same
   transaction (`ADR-071 §9` precedence, `ADR-072 §19` item 1) — the
   Customer-Group tier is architecturally present but **known-inert**
   pending the CRM Customer-Group dependency (`ADR-071 §3/§21`) — this
   specification does not attempt to test the Customer-Group tier at
   all, since nothing can resolve against it yet.

## 16. Payroll → GL Boundary Assertions

1. Exactly one GL entry point exists for this entire chain: Payroll's
   `payroll.run.posted` Financial Event (`ADR-070 §16`, `ADR-072 §16`) —
   verified negatively via §9 assertions 4/5 above (Commission/
   Attendance post nothing).
2. **Manufacturing interaction (the one negative check this
   specification owes per the CTO directive's explicit item):**
   Manufacturing's own GL posting (`manufacturing.work_order.*` Financial
   Events, verified this session in Phase 3) uses the **same**
   `resolveControlAccount`/`JournalEntryService` boundary Payroll uses —
   confirm, via a simple query, that no `manufacturing.*`-sourced
   `FinancialEvent` or journal entry exists that was produced by any
   code path other than `WorkOrderService`'s own already-verified
   handlers (i.e., Payroll/Commission never construct a Manufacturing-
   looking event, and Manufacturing never bypasses the Financial Event
   boundary the way the pre-`ADR-061` `assembleProduct` legacy path once
   did, per Manufacturing's own Phase 1–3 closure). This is a sanity
   check that the *pattern* is followed identically across every domain
   touching GL, not a new Manufacturing test.
3. Disbursement (`Dr Wages Payable / Cr Treasury`) only proceeds once
   `FinancialEvent.status = 'POSTED'` (`ADR-070 §9/§13`) — never on
   `PayrollRun.postedAt` alone (§9 assertion 3, restated as the
   disbursement-specific gate).

## 17. F03 Concurrency Evidence Boundary

**This specification verifies the NORMAL, single-threaded GL posting
path only.** Every step in §5 that touches GL posting (steps 15–19)
must be executed **one at a time, sequentially, with no other live-DB
test suite running concurrently against the same database** — the exact
opposite of the conditions that reproduced the deadlock documented in
`F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md` (commit `b5a9a85`).

- **Concurrent GL posting is explicitly excluded from this
  specification's PASS criteria.** The known deadlock
  (`JournalEntryService.createEntry`/`postEntry` acquiring the
  `numbering_sequences` and `audit_records` global locks in
  inconsistent relative order, confirmed domain-agnostic — not specific
  to Manufacturing, not specific to `wages_payable`) can, in principle,
  affect a `payroll.run.posted` journal exactly as it affected
  Manufacturing's own journals. **This is not hidden.** If this
  specification's own execution — even run single-threaded — happens to
  overlap with some *other*, unrelated concurrent GL-posting activity in
  the shared dev database (another session's own live tests, for
  instance) and a deadlock is observed, it must be recorded as **the
  existing F03 escalation reproducing again**, cross-referenced to the
  RCA document, never treated as a new defect, never worked around
  (no serial-only execution presented as a production fix, no
  Payroll-specific retry, no suppressed/ignored rejection, no rewriting
  of the resulting `REJECTED` `FinancialEvent`), and never used as
  grounds to mark this specification's own PASS criteria as failed —
  §19 item 2 below states this explicitly.
- **No remediation action from `F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md`
  (§7's Options A/B/C) is in scope for this specification or for whoever
  executes it.** That remains a separate, open §16 item awaiting a CTO
  remediation decision.

## 18. Failure/Recovery Scenarios

1. **`wages_payable` control account deactivated before a run posts**
   (§5 step 19): `PayrollRun` still reaches `posted`
   (Payroll-side, unconditional per `ADR-070 §5`); its `FinancialEvent`
   resolves `REJECTED`; §7's reconciliation query flags it;
   `disburse()` is refused (`ADR-072 §19` item 7). Reactivating the
   account and allowing the outbox retry (`EventBusService.
   dispatchPending`, `MAX_ATTEMPTS=5`) to fire again must resolve the
   event to `POSTED`, clear the reconciliation flag, and permit
   `disburse()` to then succeed (`ADR-072 §19` item 8) — the
   self-healing proof.
2. **FA-01 submit fails mid-flow** (network/validation error after a run
   reaches `calculated`/`reviewed` but before `submit()` completes): the
   process instance does not transition; no orphaned stamp survives
   (`ADR-070 §14`, mirroring the already-fixed Attendance bug pattern
   from commit `d76e22e`, cited by the ADR as the proven recovery
   shape — **UNVERIFIED whether Payroll's own implementation actually
   follows this**, must be confirmed, not assumed, once committed).
3. **Treasury disbursement fails after GL posting succeeds:**
   `PayrollRun.postedAt` and the `FinancialEvent` both remain correct
   (the liability is real); disbursement is independently retried later
   — the same accepted "unpaid approved invoice is a normal intermediate
   state" pattern `SupplierPaymentService` already relies on
   (`ADR-070 §14`).
4. **Sales Rep unresolvable** (`CustomerAssignment.salesRepUserId` with
   no linked `Employee`): no `CommissionResult` is created; surfaced for
   admin remediation (link the `User`↔`Employee`), never a silently
   zeroed/wrong result (`ADR-071 §14`).
5. **A concurrent GL-posting deadlock occurs during this
   specification's own execution** (should not happen under §17's
   sequential-execution discipline, but if it does): record it exactly
   as §17 states — the existing F03 escalation, not a new finding, not
   worked around.

## 19. PASS Criteria

1. Every checkpoint in §9–§16 above is individually confirmed true by
   direct API call and/or direct PostgreSQL query — never inferred from
   an HTTP 200 status alone.
2. **A concurrency-class GL deadlock, if observed during execution, does
   NOT by itself fail this specification** — per §17, it is recorded as
   the pre-existing F03 escalation and the affected step is re-run
   sequentially (isolated from whatever concurrent activity triggered
   it) to confirm the underlying business logic is correct once the
   transient failure is out of the picture. What **would** fail this
   specification is: a duplicate journal, a duplicate `FinancialEvent`,
   an unbalanced journal, a wrong account, or any of §9–§16's assertions
   failing for a reason *other than* the known, already-escalated
   deadlock.
3. All three preconditions currently marked **UNVERIFIED** in §3 (the
   `payroll`/`commission`/`targets` domains reaching committed, stable
   state; the `wages_payable` control account existing) are confirmed
   VERIFIED before this specification's own execution begins.
4. Full regression (whatever the current authoritative suite/test count
   is at execution time — not fixed here, since Payroll/Commission will
   add their own suites) passes under `--runInBand` (this program's own
   established canonical, deterministic mode for live-DB-heavy suites,
   per `F03_GL_POSTING_CONCURRENCY_DEADLOCK_RCA.md §3`'s own precedent).
5. Frontend typecheck and production build remain clean (whatever
   frontend exists for Payroll/Commission at execution time).

## 20. Explicit Non-Goals

- **No F03 remediation** — Options A/B/C from the RCA remain unauthorized
  and untouched (§17).
- **No new policy decision** — every commission rate, tax rule, overtime
  rule, holiday calendar, or gratuity rule left open by `ADR-067 §O` /
  `ADR-068`'s own non-goals / `ADR-070 §20/§21` / `ADR-071 §20/§21`
  remains open; this specification tests only the ratified, buildable
  subset each contract itself named as available today.
- **No `CustomerGroup` entity, no Customer-Group commission resolution**
  — blocked on a CRM dependency neither `ADR-071` nor this document
  invents a workaround for.
- **No Manufacturing enhancement, no WIP/reconciliation change** — the
  only Manufacturing interaction is the negative sanity check in §16
  item 2.
- **No frontend build** for Payroll/Commission — this is a backend/API/DB
  verification specification; frontend verification is each
  implementing session's own responsibility once its UI exists.
- **No live browser evidence** — consistent with this program's own
  established, honest practice (Manufacturing Phase 2/3's own reports):
  if credentials are unavailable at execution time, that is disclosed as
  an Evidence Gap, never fabricated.
- **This document does not authorize its own execution.** Per §3, at
  least three preconditions are not yet met. Execution begins only once
  a session — this one or another — confirms every §3 row VERIFIED and
  is explicitly directed to run it.

---

## Appendix — Traceability

Every numbered assertion in §9–§16 cites the exact ADR section it derives
from; nothing in this document states a requirement not already ratified
in `ADR-067`–`ADR-072`. Where this document could not confirm an exact
API/DB shape against currently-committed source, it says so explicitly
(**UNVERIFIED**) rather than inventing one — per direct instruction, this
is a contract for verification, not a second implementation design.
