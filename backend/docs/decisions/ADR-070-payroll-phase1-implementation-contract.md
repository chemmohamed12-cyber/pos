# ADR-070 — Payroll Phase 1: Implementation Contract

**Status:** Contract Design — CONDITIONAL / HOLD IMPLEMENTATION per CTO
Final Review (2026-09-20), pending resolution of a financial-integrity
semantic gap the corrected §13 transaction boundary exposed. **Resolved
in this revision (§5, §6, §9, §13-§15, §19 below) as Option A**, per the
CTO's own framing: `PayrollRun.status = 'posted'` means *posting intent
durably committed*, explicitly **not** *GL journal confirmed posted* —
made binding via a new, explicit reconciliation invariant (§6) built
entirely on the already-existing `FinancialEvent` entity
(`financial-event.entity.ts`), not a new mechanism. Built strictly from
`ADR-064` (Payroll Phase 0 Study), `ADR-067` (Payroll Policy, RATIFIED),
and `ADR-069` (Attendance Completion & Payroll Handoff, CLOSED). **No
policy is introduced, reopened, or reinterpreted here.** No code, schema,
migration, API, frontend, or seed change is authorized by this document.
Production remains HOLD.

## 1. Purpose / Scope

This contract converts `ADR-067`'s ratified decisions into a buildable
design: entities, state machines, invariants, service boundaries,
integration contracts, and acceptance criteria — the same role `ADR-065`
played for Attendance relative to `ADR-063`. It does not authorize
implementation by its own existence; per the CTO directive, implementation
begins only after this, `ADR-071`, and `ADR-072` are reviewed and approved
together.

**In scope:** Payroll Period/Run lifecycle, compensation data, Earnings→
Gross→Deductions→Net computation shape, Attendance-fact consumption and
day-type determination, Commission-result consumption, FA-01 approval,
GL posting via the existing Financial Event architecture, disbursement via
the existing Treasury pattern, corrections/immutability, permissions,
audit.

**Out of scope (see §20):** every item `ADR-067 §O` already named as a
Phase 1 non-goal, unchanged here.

## 2. Bounded Context

`payroll` is promoted out of `RESERVED_MODULE_CODES`
(`module-manifest.type.ts:177`) into `ModuleCode`/`V1_MODULE_CODES` — the
same mechanism `hr`/`accounting`/`procurement`/`manufacturing`/`attendance`
already went through (`ADR-024 §2.1` precedent, most recently `attendance`
per `ADR-065 §2`). New manifest `payroll.manifest.ts`, registered in
`manifests/index.ts`, own `@RequireModule('payroll')` gate, own
`payroll.*` permission namespace. Code lives under `domains/payroll/`
(`domain/`, `application/`, `infrastructure/`, `interface/`), matching
every other domain's layout.

## 3. Dependencies

| Dependency | Direction | Mechanism |
|---|---|---|
| HR (`Employee`) | Payroll → HR (read-only) | Direct module import (`HrModule`/`HrService`), same one-directional pattern Attendance already uses (`ADR-069 §4`) — `depends_on: ['hr']` |
| Attendance (approved facts) | Payroll → Attendance (read-only) | Direct module import (`AttendanceModule`/`AttendanceService`) **plus one new additive read method** (§9) — `depends_on: ['attendance']`. No new dependency in the other direction; Attendance is unchanged. |
| Commission (`ADR-071`, approved result) | Payroll → Commission (read-only) | Direct module import of a read-only query, mirroring the HR/Attendance pattern — `depends_on: ['commission']` |
| Accounting (GL posting) | Payroll → Accounting (event, not a direct call) | Payroll publishes a domain event via `EventBusService`; `FinancialEventService` (F03) subscribes and posts — the same boundary every other domain (Sales, Manufacturing, Procurement) already crosses into Accounting through. Payroll never calls `JournalEntryService` or `GLAccount` directly. |
| Accounting (period control) | Payroll → Accounting (indirect) | Enforced automatically inside `JournalEntryService.postJournal` (`journal-entry.service.ts:334`, calls `FiscalPeriodService.assertOpenForPosting`) — Payroll does not need its own period-control call; it inherits this for free by posting through F03. |
| Treasury (disbursement) | Payroll → Treasury | Extends the existing `FINANCE_TREASURY_CONTRACT` injection token (`finance.contract.ts`) with one new method, `cashOutForEmployee`, mirroring `cashOutForSupplier` exactly (same dependency-inversion pattern `SupplierPaymentService` already uses — no direct `TreasuryService` import, per the Foundation Law this codebase's lint (`no-restricted-imports`) already enforces against cross-domain imports). |
| FA-01 (`ApprovalEngineService`) | Payroll → Foundation | `registerRequestType('payroll_run_approval', …)`, `submit`/`decide`, identical usage shape to every existing consumer. |
| `ProcessEngineService` | Payroll → Foundation | Drives the `PayrollRun` lifecycle (§5) — no bespoke state machine. |
| `AuditService` / `NumberingService` / `EventBusService` | Payroll → Foundation | Reused exactly as every other domain uses them — no new mechanism. |

No other `domains/*` import exists. `hr`, `attendance`, and `commission`
have zero import back into `payroll` — the dependency graph is strictly
one-directional into Payroll, matching this codebase's own "declare what
you actually import" discipline (`ADR-065 §2`).

## 4. Domain Model (`domains/payroll/infrastructure/`, conceptual — no migration authorized)

- **PayrollPeriod** — `id, code, startDate, endDate, status ('open'|'closed'), createdAt`. Monthly in Phase 1 (`ADR-067 §A`), designed so a future frequency just adds a value to how periods are generated, not a schema change.
- **PayrollCompensation** — the effective-dated compensation record (`ADR-067 §B`): `id, employeeId, effectiveFrom, effectiveTo (nullable), status ('active'|'superseded'), createdByUserId, createdAt`. New row per change, never mutated in place — the same discipline `CustomerAssignment` and `ADR-068 §E`'s Commission Policy already use. Unique partial index `(employeeId)` where `effectiveTo IS NULL`, mirroring `AttendanceEmployeeMapping`'s own `(connectorId, deviceUserRef)` pattern.
- **PayrollEarningLine** — one or more rows per `PayrollCompensation`: `id, compensationId, componentCode ('basic' | other, catalog is Implementation detail per §21), amount`. Together these sum to Gross Pay (`ADR-067 §B`'s Earnings stage) — no single-figure salary column exists anywhere.
- **PayrollRun** — one per `(PayrollPeriod, populationScope)`: `id, payrollPeriodId, status (driven by `ProcessEngineService`, §5), approvalRequestId (nullable, FA-01), createdByUserId, calculatedAt, reviewedByUserId, reviewedAt, approvedAt, postedAt, disbursedAt (nullable, §9/§13).` **No `financialEventId` field** — corrected per CTO Final Review: no other domain entity in this codebase stores a forward reference to its own `FinancialEvent` (confirmed by inspection — `SalesInvoice`, `GoodsReceipt`, and every other Financial-Event-publishing entity holds none). The existing, already-proven join is the **reverse** direction: `FinancialEvent.sourceDomain='payroll'`, `sourceEntityType='PayrollRun'`, `sourceEntityId=<this row's id>` (`financial-event.entity.ts:26-33`) — reconciliation queries `FinancialEvent`, `PayrollRun` does not cache a pointer to it. This removes a field this contract had invented beyond precedent in its first draft.
- **PayrollRunLine** — one per employee per `PayrollRun`: `id, payrollRunId, employeeId, compensationSnapshot (jsonb — a copy of the `PayrollCompensation`/`PayrollEarningLine` values used, per the immutable-snapshot discipline `ADR-068 §F` already established for Commission), grossPay, totalDeductions, netPay, commissionAmount (nullable, from an Approved Commission Result reference, `ADR-067 §J`), overtimeAmount (always `0`/`null` in Phase 1, column reserved per `ADR-067 §D`'s extension point), calculationTimestamp.`
- **PayrollAttendanceDayClassification** — one row per employee per calendar day inside the run's period, per `ADR-067 §C`'s binding day-type control: `id, payrollRunLineId, calendarDate, attendanceStatus (Attendance's own status, copied — never re-derived later), dayType ('working'|'weekend'|'holiday'|'approved_leave'|'unclassified'), payImpact ('none'|'deduction'|'leave').` This is the concrete, auditable, per-day evidence that a deduction decision was never taken from `AttendanceDay.status` alone (§6, §9 below detail the determination rule and its fail-safe).
- **PayrollDeductionLine** — `id, payrollRunLineId, category ('system_derived'|'approved_external', `ADR-067 §G`'s closed taxonomy), type (coded, catalog is Implementation detail per §21), amount, sourceReference (nullable — an approval/request id for an `approved_external` deduction; never populated for a bare UI action per §G's own governance constraint).`
- **PayrollAdjustment** — populated only via a correction flow (`ADR-067 §M`): `id, originalPayrollRunLineId, kind ('adjustment'|'correction'|'recalculation'), reason, amountDelta, createdByUserId, createdAt, approvalRequestId (nullable, FA-01 where the correction policy requires it).`

All additive, new tables. No existing HR, Attendance, or Accounting table
is altered.

## 5. State Machines

`PayrollRun` is driven by `ProcessEngineService` (`ADR-008`) — the same
domain-neutral, row-locked engine `FiscalPeriod` already uses
(`process-definitions.ts`'s `FISCAL_PERIOD_PROCESS`), not a bespoke status
column with manual transition checks:

```
definition.key = 'payroll_run'
initialState   = 'draft'

draft      --calculate-->  calculated
calculated --review-->     reviewed
reviewed   --approve-->    approved   (FA-01 gate, §10)
approved   --post-->       posted     (terminal for PayrollRun — §18 governs
                                        everything after; NOT terminal for the
                                        GL side of this event — see below and §6)
```

**Binding semantic, per CTO Final Review (2026-09-20) — Option A:**
`PayrollRun.status = 'posted'` means **posting intent durably committed**
— the run has been finalized on the Payroll side and will never be
recalculated or reopened (§18). It does **not** mean, by itself, that the
GL journal exists or is balanced. That is a distinct, independently
tracked fact, owned entirely by `FinancialEvent.status` (§6). This is
Option A from the CTO's review, chosen because it is not a new pattern —
it is the exact shape every other domain in this codebase that crosses
into Accounting already uses (Sales, Manufacturing, Procurement none of
them wait for GL confirmation before finalizing their own document), so
choosing Option B (making `posted` wait for GL confirmation) would have
made Payroll the only domain in this codebase with that stronger,
inconsistent guarantee, at the cost of reintroducing exactly the kind of
cross-domain synchronous coupling the Transactional Outbox pattern exists
to avoid.

`transition()`'s own row lock (`FOR UPDATE` on the process instance,
`process-engine.service.ts:104`) is the concurrency guard preventing two
simultaneous `calculate`/`approve`/`post` calls on the same run — no new
locking mechanism is introduced.

**Explicit statement, per CTO review (2026-09-20): Approval is not
Posting.** `reviewed → approved` is the one and only human control point
— the FA-01 maker/checker decision (§10). `approved → posted` is **not**
a second human decision; it is the deterministic, automatic system
consequence of that decision, fired by the same `approval.request.
approved` event handler shape `FiscalPeriodService.onApprovalApproved` →
`applyApprovedPeriodTransition` (`fiscal-period.service.ts:461-467`) and
Attendance's own `onApprovalApproved` (`attendance.service.ts:531-545`,
`ADR-069 §1`) already use for every other FA-01-gated state transition in
this codebase. This is now stated explicitly, not left implicit: the
checker's approval decision *is* the control; `post` firing immediately
and automatically afterward is a reused, already-precedented pattern, not
a new one, and does not create a second, unreviewed path to a financial
posting — nothing can reach `posted` without first passing through the
one FA-01 gate at `approved`. §13 specifies exactly what "posting" does
and does not do inside that automatic transition.

## 6. Invariants

- A `PayrollRunLine` is never created for an `employeeId` `ADR-067 §I`
  excludes (a `Contractor`, per `Employee.employmentType`).
- No two `PayrollRun`s may exist for the same `(PayrollPeriod,
  populationScope)` with overlapping employee membership without an
  explicit superseding rule — enforced by a DB constraint at
  implementation time (§21 names the exact constraint shape as
  Implementation detail, not decided here).
- `PayrollAttendanceDayClassification.dayType = 'unclassified'` **must
  never** produce `payImpact = 'deduction'` — this is the fail-safe
  resolving `ADR-067 §C`'s Holiday Calendar escalation (§9, §21) without
  inventing calendar data: absence of a calendar answer defaults to "do
  not deduct," never to "assume working day."
- A `PayrollRunLine`'s `commissionAmount` may only be populated from an
  **Approved** Commission Result (`ADR-071`'s own immutable snapshot) —
  never computed, re-derived, or estimated by Payroll (`ADR-067 §J`).
- Once a `PayrollRun` reaches `posted`, no `PayrollRunLine` or
  `PayrollDeductionLine` row may be updated — only a new `PayrollAdjustment`
  row may reference it (`ADR-067 §M`).
- **Corrected per §13's transaction-boundary review:** the Financial
  Period open-check (`assertOpenForPosting`) does **not** gate
  `PayrollRun`'s own `approved → posted` transition — that transition is
  Payroll's own, synchronous, and completes before the journal is
  attempted (§13). The check instead gates the **journal**, inside the
  later, separate Financial Event Handler transaction
  (`journal-entry.service.ts:334`). The correct invariant is therefore: a
  `PayrollRun` **may reach `posted`** for a run whose period has since
  closed, but its GL journal will then be rejected at posting time (§14),
  surfaced for remediation — not silently blocked, not silently allowed
  through to a wrongly-open period.
- Every GL-posting Financial Event Payroll publishes carries a
  deterministic `idempotencyKey` derived from `(payrollRunId, 'posted')` —
  a redelivered event can never double-post (§12).
- **New, binding — the reconciliation invariant CTO Final Review requires,
  built entirely on the existing `FinancialEvent` entity, no new
  mechanism:**

  ```
  Every PayrollRun that reaches `posted`
  must have exactly one corresponding FinancialEvent row
  (sourceDomain='payroll', sourceEntityType='PayrollRun', sourceEntityId=<run id>),
  and that FinancialEvent must eventually resolve to
  POSTED, or to an explicitly remediable terminal state
  (REJECTED, IGNORED, or its underlying EventOutbox row reaching 'failed'
   without ever producing a FinancialEvent row at all) —
  never left indefinitely RECEIVED/MAPPED or the outbox row indefinitely 'pending'.
  ```

  "Exactly one" is guaranteed for free by `idempotencyKey`'s own
  `UNIQUE` constraint (`financial-event.entity.ts:35-37`) — a redelivery
  of the same outbox event can never create a second row. **A
  `PayrollRun.status = 'posted'` is never, by itself, evidence that GL
  posting succeeded — only `FinancialEvent.status = 'POSTED'` is.**
  §15 specifies the reconciliation query this invariant makes possible;
  §9/§13 specify disbursement's own dependency on it.

## 7. Service Boundaries

`PayrollService` (application layer) owns: compensation CRUD (via
`PayrollCompensation`/`PayrollEarningLine`, effective-dated writes only),
`PayrollPeriod` management, `PayrollRun` calculation orchestration (reads
Attendance + Commission, applies §9's day-type rule, writes
`PayrollRunLine`/`PayrollDeductionLine`/`PayrollAttendanceDayClassification`
inside one transaction), FA-01 submission, the `approved → posted`
handler (publishes the Financial Event, calls Treasury for disbursement),
and the correction/adjustment flow. It does **not** own GL account
resolution, journal balancing, or period-open checks — those remain F03's
(`FinancialEventService`/`JournalEntryService`) responsibility, invoked
only through the event boundary (§3).

## 8. Data Ownership

| Data | Owner | Payroll's access |
|---|---|---|
| `Employee` identity | HR | Read-only (`employeeId` reference) |
| `AttendanceDay` facts | Attendance | Read-only, via §9's new read method |
| Commission Result | Commission (`ADR-071`) | Read-only, approved results only |
| `PayrollPeriod`/`PayrollCompensation`/`PayrollRun`/`PayrollRunLine`/`PayrollDeductionLine`/`PayrollAttendanceDayClassification`/`PayrollAdjustment` | **Payroll** | Owns and writes |
| `GLAccount`/`JournalEntry` | Accounting | Payroll never writes directly — event-published only |
| `TreasuryAccount`/disbursement transaction | Treasury | Payroll calls the extended contract method only |

## 9. Events / Integration Contracts

**Inbound — Attendance:** `attendance.period.approved` (payload
`{batchId, periodStart, periodEnd}`, `attendance.service.ts:541`) signals
that a batch exists to consume, but — as `ADR-069`'s own review flagged —
carries no per-employee facts, and `AttendanceService` currently exposes
no batch-scoped read. **This contract specifies the required addition:**
an additive, read-only `AttendanceService.listApprovedDaysByBatch(batchId)`
method (returns `AttendanceDay[]` for that batch) — the same shape
`listDays(employeeId?)` already has, scoped by batch instead. This is the
one concrete gap `ADR-069 §5` named; nothing else about Attendance
changes.

**Day-type determination (`ADR-067 §C`, binding):** for each
`AttendanceDay` consumed, `PayrollService` classifies it via the
extension-point `PayrollCalendarPolicy` (weekend pattern + holiday list,
company-configured):

```
AttendanceDay.status
        │
        ├─ 'on_leave'      → dayType='approved_leave', payImpact='none'
        ├─ 'present'       → dayType='working',        payImpact='none'
        ├─ 'missing_punch' → dayType='working',         payImpact='none' (Phase 1: incomplete
        │                     punch data is a data-quality flag, never an automatic deduction —
        │                     no policy authorizes deducting pay for a missing punch alone)
        └─ 'absent'        → calendar lookup:
                                weekend?  → dayType='weekend',  payImpact='none'
                                holiday?  → dayType='holiday',  payImpact='none'
                                working?  → dayType='working',  payImpact='deduction'
                                unknown?  → dayType='unclassified', payImpact='none' (fail-safe, §6)
```

If `PayrollCalendarPolicy` is not configured for a given date, every
`'absent'` day for that date resolves to `unclassified`/`none` — Phase 1
never guesses a weekend pattern or a holiday list (§21).

**Inbound — Commission (`ADR-071`):** a read-only query for Approved
Commission Results within the `PayrollRun`'s period, scoped by
`employeeId` — exact method signature is `ADR-071`'s own deliverable,
consumed here only as "an approved, immutable result," per §6/§8.

**Outbound — Accounting:** `payroll.run.posted` (new topic, added to
`DOMAIN_OF_TOPIC` and a new handler in the Financial Event registry, same
registration shape as every existing handler in `finance-handlers.ts`) —
payload carries `payrollRunId`, `payrollPeriodId`, and the aggregate
Dr/Cr amounts; the handler resolves `wages_payable` via
`resolveControlAccount` (§16) and posts one balanced journal, landing a
`FinancialEvent` row keyed `sourceDomain='payroll'`,
`sourceEntityType='PayrollRun'`, `sourceEntityId=payrollRunId` — the
reconciliation join §6's invariant and §15 rely on (no `financialEventId`
cached on `PayrollRun` itself, §4).

**Outbound — Treasury (disbursement) — trigger, ownership, and gate made
explicit per CTO Final Review (2026-09-20):** disbursement is **not**
automatically cascaded from the Financial Event handler's success —
matching this codebase's own existing, proven precedent exactly:
`SupplierPaymentService.recordPayment` is never auto-triggered by a
Supplier Invoice's own GL posting; it is a **distinct, separately-invoked
action**, exposed through its own controller endpoint
(`supplier-payment.controller.ts:56`), invoked by a human at a time of
their choosing, referencing an already-posted invoice. Payroll disbursement
follows the identical shape, not a new one:

- **Trigger:** an explicit `PayrollService.disburse(payrollRunId)` action
  (own permission node, §10), invoked by an authorized user — never
  automatic.
- **Ownership:** Payroll *initiates* (owns the decision of when/whether to
  disburse a given run); Treasury *executes* (via the extended
  `cashOutForEmployee` contract method, §3) — the identical split
  `SupplierPaymentService`/Treasury already have; Payroll does not import
  `TreasuryService` directly, exactly as Procurement does not.
- **Gate:** `disburse()` must first query `FinancialEvent` by this run's
  `sourceEntityId` and refuse (fail-closed) unless `status = 'POSTED'` —
  a run whose Financial Event is still `RECEIVED`/`MAPPED`, or has
  resolved `REJECTED`/`IGNORED`, cannot be disbursed. This is the
  concrete mechanism that prevents "PayrollRun posted + GL never posted"
  from ever silently reaching an employee's bank account.
- **Idempotency/retry:** mirrors `SupplierPaymentService.recordPayment`'s
  own proven shape (`supplier-payment.service.ts:61-75`) — an advisory
  lock plus a remaining-balance/already-disbursed check, rejecting a
  second disbursement attempt for the same run with a `ConflictException`,
  not a new mechanism.

## 10. Authorization / SoD

Candidate `payroll.*` permission nodes (naming only, final list is
Implementation detail): `payroll`, `payroll.compensation.{view,create,edit}`,
`payroll.period.{view,create}`, `payroll.run.{view,create,calculate}`,
`payroll.run.approve` (FA-01 checker side), `payroll.run.disburse` (§9's
explicit, separately-invoked disbursement trigger — distinct from
approval, mirroring `supplier_payment.record`-shaped nodes elsewhere),
`payroll.adjustment.create`, `payroll.deduction.create` (governs the
`approved_external` category's own authorization boundary per `ADR-067
§G`). **No `payroll.run.post` node exists** — consistent with §5's
correction, `post` is not a separately human-invoked action, so there is
nothing for a distinct permission to gate; the FA-01 approval decision
(`payroll.run.approve`) is the one control point for the entire
`approved → posted` outcome. `payroll.run.disburse` is deliberately a
*different* node from `payroll.run.approve` — SoD may require the two to
be held by different actors, the same separation `ADR-064 §6` already
anticipated ("compensation data... likely needs its OWN narrower
visibility node"), now extended to disbursement. FA-01's own SoD
enforcement (`approval-engine.service.ts:231-234` — "the maker of an
approval request cannot approve or reject it") covers the `approve` step
automatically, zero new mechanism, exactly as `ADR-067 §L` requires.

## 11. Audit

Every state-changing `PayrollService` call records via `AuditService.
record` (`action`, `resource: 'payroll_run'|'payroll_compensation'|…`,
`before`/`after`) — compensation change, run calculate/review/approve/
post, deduction/adjustment creation. FA-01 decisions are audited
generically by `ApprovalEngineService.decide` itself, the same as every
other consumer — no gap, no duplication.

## 12. Idempotency

- `PayrollRun` numbering via `NumberingService.registerDocumentType`/
  `getNextNumber` (document type `payroll_run`), same pattern as every
  other numbered document in this codebase.
- The Financial Event `payroll.run.posted` carries a deterministic
  `idempotencyKey` (`payrollRunId` + action) — F03's own
  `UNIQUE(idempotencyKey)` constraint (`financial-event.service.ts:58`)
  guarantees a redelivered event never double-posts, with zero
  Payroll-specific dedup logic needed.
- `PayrollService.calculate` is safe to re-invoke on a `draft` run (an
  idempotent recompute, discarding prior draft lines) but is a no-op once
  the run has left `draft` — enforced by `ProcessEngineService.transition`
  only accepting `calculate` from `draft` (§5).

## 13. Transaction Boundaries

- Compensation writes (`PayrollCompensation` + `PayrollEarningLine`) are
  one transaction: close the prior row, insert the new one.
- `calculate` is one transaction: read Attendance + Commission, write
  every `PayrollRunLine`/`PayrollDeductionLine`/
  `PayrollAttendanceDayClassification` row, transition the process
  instance — all together or none, using `ProcessEngineService`'s own
  optional trailing `manager?` parameter to join the same transaction
  (`process-engine.service.ts:20-30`'s documented additive pattern), not a
  second nested transaction.
- **`approved → posted` — corrected per CTO review (2026-09-20): GL
  Journal Posting is NOT inside Payroll's own transaction.** The
  Transactional Outbox pattern (`EventBusService`, `ADR-012`) is, by
  design, exactly two separate transactions, never a distributed one:

  ```
  Payroll DB Transaction (one, atomic)
      • PayrollRun.status: approved → posted   (ProcessEngineService.transition)
      • EventOutbox row created: topic='payroll.run.posted', status='pending'
        (EventBusService.publish(manager, …) — writes using THIS SAME manager,
         event-bus.service.ts:40-48 — no handler is invoked synchronously here)
      • (no financialEventId write-back — PayrollRun caches nothing;
         reconciliation joins FinancialEvent.sourceEntityId → PayrollRun.id
         instead, §4/§6)
  COMMIT
      ↓ (separate, later — EventBusService.dispatchPending(), event-bus.service.ts:57-87)
  Financial Event Handler (registered in finance-handlers.ts, §16)
      • resolveControlAccount('wages_payable')
      • Journal Posting (its own transaction, JournalEntryService)
      • on success: outbox row → 'dispatched'
      • on failure: outbox row stays 'pending' for retry (up to MAX_ATTEMPTS,
        then 'failed' — event-bus.service.ts:76-84), and/or the handler itself
        publishes `accounting.financial_event.rejected`
        (financial-event.service.ts:346) for a definitive rejection
  ```

  **`PayrollRun` reaches its terminal `posted` state at COMMIT, before the
  journal has necessarily posted.** This is intentional and is the
  Transactional Outbox pattern working exactly as designed — the same
  eventually-consistent boundary every other domain (Sales, Manufacturing,
  Procurement) already crosses into Accounting through, not a new or
  weaker guarantee invented for Payroll. `PayrollRun.posted` means "the
  posting intent is durably recorded and cannot be lost or double-sent,"
  not "the journal is confirmed balanced in the ledger" — those are
  different, correctly separated guarantees. No partial Payroll mutation
  is possible (the three bullet points above are one atomic transaction);
  no duplicate journal is possible (the deterministic `idempotencyKey`,
  §12, makes redelivery a no-op); rejection/retry is handled entirely by
  the existing outbox/handler mechanism, not a new one.

  **Disbursement is a third, separate, later transaction, and a
  separate, explicitly human-invoked action (§9) — never automatic.**
  `PayrollService.disburse(payrollRunId)` first queries `FinancialEvent`
  (`sourceEntityType='PayrollRun'`, `sourceEntityId=payrollRunId`,
  `financial-event.service.ts:100`'s `getEvent`-shaped lookup) and refuses
  unless `status = 'POSTED'`, only then calling `cashOutForEmployee` (§3)
  — never triggered from inside the `approved → posted` transaction
  itself, and never assumed to have succeeded just because
  `PayrollRun.postedAt` is set (§6's invariant is precisely why this check
  is mandatory, not optional). Mirrors `SupplierPaymentService`'s own
  sequencing and its own separate-action shape (§9).

## 14. Failure Modes

- **FA-01 `submit` fails after a run reaches `calculated`/`reviewed`:**
  the process instance simply does not transition — no orphaned state is
  possible, since (unlike Attendance's pre-fix bug, commit `d76e22e`) no
  other row is stamped before the submit call succeeds. `PayrollRun`
  remains re-submittable.
- **Financial Event handler rejects the posting** (e.g. `wages_payable`
  unresolvable): per §13's corrected mechanism, `PayrollRun` has **already**
  reached its terminal `posted` state at commit time — this failure mode
  does **not** revert it, and does not need to. What fails is the
  *journal*, tracked independently via the outbox row's own status
  (`pending`/`failed`, `event-bus.service.ts:76-84`) and, on a definitive
  rejection, `accounting.financial_event.rejected`
  (`financial-event.service.ts:346`) — surfaced for admin remediation
  (add/activate the control account). The **same** outbox row is retried
  by the existing dispatch mechanism, up to `MAX_ATTEMPTS` — no
  re-publish, no second event, no partial GL state, matching F03's own
  fail-closed discipline (`resolveControlAccount` returning `null` is
  handled as rejection everywhere else in this codebase, e.g.
  `ap-adjustment.handler.ts:37-40`). Disbursement (§9, §13) never proceeds
  while the underlying event is not yet confirmed posted, regardless of
  `PayrollRun`'s own already-`posted` status — this is precisely why §9's
  `disburse()` gate checks the Financial Event's own status, not
  `PayrollRun.postedAt`. Until remediated, this run is exactly the state
  §6's invariant and §15's reconciliation query exist to surface: `posted`
  on the Payroll side, unresolved on the GL side — flagged, not hidden.
- **Treasury disbursement fails after posting:** `PayrollRun.postedAt` is
  already set (GL is correct — the liability is real regardless of
  disbursement timing); disbursement is retried independently, the same
  separation `SupplierPaymentService` already relies on (an unpaid
  approved invoice is a normal, expected intermediate state, not an
  error).

## 15. Retry / Reconciliation

Redelivery safety is inherited entirely from the existing Transactional
Outbox (`EventBusService`) and F03's `idempotencyKey` — no new retry
mechanism.

**Reconciliation, made concrete per CTO Final Review (2026-09-20)
(exact query shape is Implementation detail; the invariant it enforces is
not):** the query §6's invariant requires is a straightforward join, no
new table:

```
SELECT pr.id FROM payroll_runs pr
LEFT JOIN accounting_financial_events fe
  ON fe."sourceEntityType" = 'PayrollRun' AND fe."sourceEntityId" = pr.id
WHERE pr.status = 'posted'
  AND (fe.id IS NULL OR fe.status NOT IN ('POSTED'));
```

A non-empty result is, by definition, a `PayrollRun` that is `posted` on
the Payroll side with **no confirmed GL counterpart** — exactly the gap
CTO Final Review flagged, now a detectable, queryable, named condition
rather than an implicit possibility. `fe.id IS NULL` additionally catches
the case where the underlying `EventOutbox` row itself exhausted retries
and reached `'failed'` before a `FinancialEvent` row was ever created —
distinct from a `FinancialEvent` that was created and then `REJECTED`, but
caught by the same query. This report is Implementation detail to build
(a scheduled job, an admin dashboard query, or both), following the same
shape `ADR-064 §0` already cited as proven for other subledger-to-GL
reconciliations in this codebase — what is binding here is that the query
is possible and correct with zero new fields beyond what `FinancialEvent`
already has, not the exact delivery mechanism.

## 16. Financial Integration

Extends `ControlFunction` (`domain/control-function.ts`) with one new
value, `wages_payable` — the same "F02 only marks it" discipline every
prior addition (`grni`, `wip`) already followed, cited by its own ADR
comment. Posting shape, via the new `payroll.run.posted` handler in
`finance-handlers.ts`:

```
Dr  Salaries & Wages Expense (5201 — already templated, dormant, ifrs-sme.template.ts)
Cr  Wages Payable (resolveControlAccount('wages_payable'))
```

Disbursement (§9, §13): `Dr Wages Payable / Cr Treasury Account`, same
shape `SupplierPaymentService` already posts for AP. **No Tax/Social
Insurance control account is created in Phase 1** — `ADR-067 §E` ratified
the boundary, not the rates; there is nothing to post yet (§21).

## 17. Period Control

`PayrollPeriod` is Payroll's own concept (§4) — it is not the same row as
a Financial Period. **Precisely which layer enforces the closed-period
check (corrected per §6/§13): not `PayrollRun`'s own `approved → posted`
transition** (which does not check period status at all) **— the
journal**, when `JournalEntryService.postJournal` calls `FiscalPeriodService.
assertOpenForPosting(orgUnitId, businessDate)` (`journal-entry.service.ts:334`)
inside the later, separate Financial Event Handler transaction. A
`PayrollRun`'s GL journal cannot post into a closed Financial Period —
enforced for free, not reimplemented — but the `PayrollRun` record itself
can still reach `posted` first; §14 names the resulting failure mode
explicitly rather than assuming the two are gated together. Duplicate-run
prevention (§6) and no-direct-edit-of-a-posted-run (§18) are Payroll's own,
separate invariants layered on top, per `ADR-067 §N`.

## 18. Correction / Immutability

Post-`approved`/`posted`, no `PayrollRunLine`/`PayrollDeductionLine` row
is ever updated. A correction is always a new `PayrollAdjustment` row
(§4), typed `adjustment` (a standalone amount change, e.g. a missed
deduction applied going forward), `correction` (a fix to a specific,
identified error in a posted run, itself gated by FA-01 where the
correction policy requires it), or `recalculation` (a full re-run of a
period, producing a new `PayrollRun` that supersedes rather than
overwrites the original). Historical `PayrollRun`/`PayrollRunLine` rows
remain permanently queryable exactly as posted, matching `ADR-067 §M`.

## 19. E2E Acceptance Criteria

1. A `PayrollCompensation` change never rewrites a prior period's history
   — a `PayrollRunLine` for a past period still reflects the compensation
   that was effective then.
2. `calculate` on a `PayrollRun` correctly classifies every attendance day
   in-period per §9's table, including the `unclassified` fail-safe when
   `PayrollCalendarPolicy` has no entry for a date — proving no day is
   ever silently deducted without a resolved day type.
3. An `'on_leave'` day never reaches a `payImpact='deduction'` outcome,
   reconciling correctly with HR's approved `LeaveRequest` chain
   (`ADR-067 §F`).
4. A `PayrollRunLine`'s `commissionAmount` only ever reflects an *Approved*
   Commission Result — an unapproved/draft Commission Result is never
   readable by Payroll.
5. `PayrollRun` cannot skip a lifecycle state — attempting `post` from
   anything other than `approved` is rejected by `ProcessEngineService`
   itself.
6. FA-01 SoD is proven live on `PayrollRun` approval — the maker of the
   `calculate`/submit action cannot also `approve` it (same two-actor
   proof pattern `attendance-phase1.spec.ts:161-164` already established).
7. Posting is idempotent — redelivering the same `payroll.run.posted`
   event never produces a second journal entry.
8. Posting into a closed Financial Period is rejected before any journal
   line is written.
9. Attempting to write to a `posted` run's lines directly (bypassing the
   adjustment flow) is rejected; only a new `PayrollAdjustment` row is
   accepted.
10. A Contractor (`employmentType = 'contractor'`) never receives a
    `PayrollRunLine` in Employee Payroll Core.
11. Unauthorized users are blocked from every sensitive Payroll action,
    each behind its own permission node.
12. Full regression, clean build, live-database verification — same bar
    every prior phase in this program has met.
13. **New, per CTO Final Review:** a `PayrollRun` whose Financial Event is
    forced to `REJECTED` (e.g. by deactivating `wages_payable` mid-test)
    still reaches `posted` on the Payroll side (§5) — proving the two are
    genuinely decoupled, not just documented as such.
14. **New:** §15's reconciliation query correctly identifies that same run
    as a gap (`posted` + no `POSTED` `FinancialEvent`), and returns empty
    once the control account is reactivated and the outbox row's retry
    succeeds — proving detection and self-healing both work.
15. **New:** `PayrollService.disburse()` is rejected for a `PayrollRun`
    whose `FinancialEvent` is not `POSTED` (whether still pending or
    definitively rejected), and succeeds once it is — proving §9's gate is
    real, not documentation-only.

## 20. Non-Goals

Restated unchanged from `ADR-067 §O` — not reopened, not expanded:
Contractor Payroll; an automatic legal gratuity engine; automatic legal
overtime calculation; unapproved holiday policy assumptions; an advanced,
unapproved tax-law engine; an advanced bonus engine; a workforce
scheduling engine; Attendance device implementation; rebuilding
Attendance in any form; a Commission calculation engine (Payroll only
ever consumes `ADR-071`'s approved result).

## 21. §16 Escalations / Open Dependencies

Per `ADR-053 §16` — none of the following are invented, defaulted, or
estimated anywhere in this document:

- **Holiday Calendar source and weekend pattern** (`ADR-067 §C`) —
  unresolved. §9's `PayrollCalendarPolicy` is specified as an extension
  point with a safe `unclassified`/no-deduction fallback; it cannot
  compute a real weekend/holiday answer until this is supplied.
- **Tax bracket / social insurance rates** (`ADR-067 §E`) — unresolved.
  The `Payroll Calculation → Tax/Social Insurance Rules → Calculated
  Deduction` boundary (§16) is ready to receive them; no rate exists to
  post yet, so no tax/insurance `ControlFunction` is added in Phase 1
  either — that addition itself waits for the same ratification.
- **Overtime rate/multiplier and eligibility** (`ADR-067 §D`) —
  unresolved; `PayrollRunLine.overtimeAmount` is a reserved, always-zero
  column in Phase 1.
- **Gratuity/end-of-service calculation rule** (`ADR-067 §H`) —
  unresolved; no entity or extension point beyond "Phase 1 does not
  compute this" is proposed.
- **Leave encashment conversion rule** (`ADR-067 §F`) — unresolved; if it
  occurs, it is modeled as a manually-created `PayrollEarningLine` or
  `PayrollDeductionLine` entered as an *explicit, separately-approved*
  input (never an automatic balance-to-amount formula), per the ratified
  decision.
- **`PayrollEarningLine.componentCode` and
  `PayrollDeductionLine.type` catalogs** — the exact starting component/
  deduction-type lists are Implementation detail, not a business-policy
  gap; they will be enumerated when this contract is implemented, without
  requiring further CTO ratification, since `ADR-067 §B`/§G already fixed
  the *shape* (componentized Earnings; two-category Deductions).
- **Duplicate-run prevention's exact DB constraint shape** (§6) —
  Implementation detail (a unique index vs. an advisory lock vs. both),
  not a policy question.
- **Whether `Employee.employmentType = 'part_time'` needs its own
  proration rule** — not raised by `ADR-067`, not assumed here; Phase 1
  treats `full_time` and `part_time` identically unless a future decision
  says otherwise.

## 22. Implementation Sequence (proposed, not authorized)

Per the CTO directive, this section records the intended build order for
if/when implementation is separately authorized — it does **not** start
implementation itself:

1. Module registration + `PayrollPeriod`/`PayrollCompensation`/
   `PayrollEarningLine` (Foundation).
2. Attendance's additive `listApprovedDaysByBatch` read method (§9) — the
   one Attendance-side change this contract requires, additive and
   read-only.
3. `PayrollRun`/`PayrollRunLine` calculation, including §9's day-type
   determination and its fail-safe.
4. FA-01 lifecycle wiring (§5, §10).
5. Financial Event handler + `wages_payable` control function (§16).
6. §15's reconciliation query (report/job) — built alongside the handler,
   not deferred, since it is what makes §6's invariant observable.
7. `PayrollService.disburse()` + the extended Treasury contract (§3, §9),
   including its `FinancialEvent`-status gate.
8. Correction/adjustment flow (§18).
9. Frontend.

Each stage tested before the next begins, same discipline as every prior
phase. Production remains HOLD.
