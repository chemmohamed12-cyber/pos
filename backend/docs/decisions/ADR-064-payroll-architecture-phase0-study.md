# ADR-064 — Payroll: Phase 0 Architecture Study

**Status:** Proposed (Phase 0 — study/design only), prepared in parallel
with the Attendance ratification track per explicit instruction. **Not**
a Payroll implementation, **not** a reopening of HR Phase 1 (ADR-059,
CLOSED/PASS), and **not** a substitute for the Attendance Phase 1
Implementation Contract (currently blocked pending ratification of
`ADR-063`'s nine decisions). No code, migration, schema, API, frontend, or
calculation is authorized by this document. Every fact below is from
direct inspection of the current repository.

**Governance for this document:** Resolve → Study → Document → Verify →
STOP — identical discipline to `ADR-062`. This study does not assume the
outcome of any of `ADR-063`'s nine pending decisions; wherever this
document's own conclusions depend on one of them, that dependency is
named explicitly (§5) rather than guessed past.

## 0. Current State — VERIFIED / INFERRED / UNVERIFIED

**VERIFIED (direct repository inspection):**

- **Zero payroll code, tables, or services exist anywhere.** A
  full-repository search for `payroll|salary|wage|gross_pay|net_pay|
  pay_slip|deduction` returns no domain logic — the only real hit is the
  IFRS-SME default chart-of-accounts **template** seeding a decorative
  `5201 — Salaries & Wages` expense account (`ifrs-sme.template.ts`).
  Nothing posts to it, reads it, or resolves it as a control account —
  it exists purely as a standard chart-of-accounts line item a business
  could manually journal against today, with zero automation behind it.
- **`payroll` is already a reserved-but-unbuilt module code**
  (`RESERVED_MODULE_CODES`, confirmed in `ADR-062 §0`) — unlike
  `attendance`, which isn't reserved at all, Payroll's eventual promotion
  out of the reserved list already has a designated slot (`ADR-024 §2.1`
  precedent, same mechanism `hr`/`accounting`/`procurement` were promoted
  through).
- **A proven, directly-reusable GL control-account mechanism exists**:
  `resolveControlAccount` (`HandlerContext`, used by every Financial Event
  handler — confirmed live in `goods-receipt.handler.ts` for GRNI). A
  chart-of-accounts row is tagged with a `controlFunction` (e.g. `'grni'`,
  `'ap'`); a handler resolves the account by function, never by a
  hardcoded id or code. **This is the exact mechanism Payroll's own
  control accounts (Wages Payable, Payroll Tax/Social-Insurance Payable)
  should use** — no new "find the right GL account" mechanism is needed.
- **`TreasuryAccount`/`SupplierPaymentService` establish a proven
  disbursement pattern** (`domains/treasury`, `domains/procurement/
  application/supplier-payment.service.ts`) — a payment against a
  Treasury account, already integrated with GL. Payroll disbursement
  (paying employees) is the same *shape* of problem procurement already
  solved for paying suppliers; this study proposes following that
  precedent rather than inventing a parallel disbursement mechanism.
- **The `Employee` aggregate (ADR-059, HR Phase 1, CLOSED)** has zero
  compensation-related fields — no salary, no bank account, no tax
  identifier, no social-insurance number. All of this is genuinely new
  ground for Payroll; this study does not propose adding any of it to
  `Employee` itself without an explicit boundary decision (§2).
- **No statutory/tax concept of any kind exists anywhere** — confirmed by
  a targeted search for `socialInsurance|incomeTax|taxBracket|statutory`
  (zero hits). This matters specifically because Daii's UI/business
  context is Arabic/Egypt-facing (per every other domain's own Arabic
  terminology seeding observed throughout this codebase) — Egyptian
  payroll carries real statutory obligations (income tax withholding,
  social insurance contributions) that are not optional features to
  design around later; this study does not assume their specific rates,
  brackets, or mechanics (§9, escalated).
- **FA-01 (`ApprovalEngineService`) and `AuditService`** are, as in every
  prior phase of this program, the only approval and audit mechanisms
  this study proposes reusing — no new mechanism for either.
- **`ADR-062 §8`'s Payroll boundary is a fixed, already-accepted
  constraint, not reopened here**: Attendance hands Payroll *facts* only
  (hours present, late minutes, absence days) via an `attendance.period.
  approved` domain event (`EventBusService`, same subscription pattern
  `FiscalPeriodService` already uses) — never a computed wage, never raw
  device data.

**INFERRED:** none material beyond what is stated as VERIFIED above.

**UNVERIFIED (explicitly flagged, not assumed):** any specific payroll
frequency, tax regime, social-insurance rate, end-of-service/gratuity
policy, or leave-encashment rule the business actually needs. None are
named in the request, and none are assumed anywhere in this document.

## 1. Gap Matrix

| Area | State | Note |
|---|---|---|
| Payroll domain (any) | NOT VERIFIED / does not exist | Full greenfield |
| `payroll` module code | VERIFIED, reserved (not built) | Ready for promotion when contract is ratified |
| GL control-account mechanism | VERIFIED, reusable | `resolveControlAccount` — GRNI/AP precedent |
| Disbursement mechanism | VERIFIED, reusable | `TreasuryAccount` + `SupplierPaymentService` pattern |
| Employee compensation data | NOT VERIFIED / does not exist | Genuinely new fields, boundary undecided (§2) |
| Statutory tax/insurance | NOT VERIFIED / does not exist | Escalated, not assumed (§9) |
| Attendance → Payroll input | BLOCKED | Depends on `ADR-063` ratification (§5) |
| FA-01 / Audit | VERIFIED, reusable | No new mechanism |

## 2. Proposed bounded context / data boundary

Payroll is its own bounded context, downstream of both HR and Attendance,
per the pipeline `ADR-062`'s own diagram already established:

```
HR (Employee identity)  ─┐
                          ├─→ Payroll Engine → Disbursement (Treasury) → GL
Attendance (Approved Results) ─┘
```

Payroll depends on HR for `employeeId` identity (same plain-uuid
convention every other domain uses) and, separately, needs its own new
**compensation data** (base salary, pay frequency, bank details) that
does not belong on HR's `Employee` aggregate itself — mirroring exactly
how `ADR-062 §5` kept device/employee mapping OFF the `Employee` entity
rather than folding a foreign concept into HR's own aggregate. Proposed:
a `PayrollProfile` (one per employee, owned by Payroll, referencing
`employeeId`) holds compensation data — HR remains unaware of it, exactly
as HR remains unaware of Attendance's device mappings today.

## 3. Payroll domain model (conceptual — no schema authorized)

- **PayrollProfile** — `employeeId`, base salary, pay frequency, bank/
  disbursement details. Every specific field beyond "some compensation
  amount exists" is dependent on §9's unresolved policy (e.g., is salary
  a single base figure, or does it decompose into allowances/components
  from day one? — not assumed).
- **PayRun** — one per pay period per (some population — all employees?
  a department? — itself a §9 item), aggregating each employee's
  attendance-derived facts (§5) into a draft calculation, gated by FA-01
  before disbursement (mirrors `ADR-062 §4`'s own approval-batch gate for
  Attendance, and `ADR-051`'s Month-End Closing gate — the same
  "nothing downstream happens until approved" discipline this codebase
  already uses three times).
- **Payslip** — the per-employee, per-period output of an approved
  `PayRun` — the artifact Payroll actually owes the employee, analogous
  in spirit to Sales' own `Invoice` as "the approved, final document a
  process produces."
- **What this model deliberately does NOT define**: any wage formula, any
  tax bracket, any deduction/allowance type, any overtime rate. Per
  instruction, none of that is invented here — see §9.

## 4. GL / Financial integration boundary

Reuses `resolveControlAccount` unchanged. Candidate control functions
(naming only, not authorized for creation): `wages_payable`,
`payroll_tax_payable` (or `social_insurance_payable` — naming itself is a
policy question, §9). A `PayRun`'s approval publishes a Financial Event
the same way `goods_receipt.posted` does today — Dr Salaries & Wages
Expense (the already-templated `5201` account, now finally given a real
poster) / Cr Wages Payable — with disbursement itself following the
`SupplierPaymentService` shape (Dr Wages Payable / Cr Treasury Account),
never a parallel or invented posting mechanism.

## 5. Explicit dependencies on the Attendance contract (ADR-062/063)

This is the section the current instruction specifically asked this study
to identify. Every one of these is a **hard blocker** on Payroll's own
detailed design, not just Attendance's:

- **Payroll cannot define what "hours worked" means for pay purposes**
  until `ADR-063 §5` (multi-punch handling) is ratified — first-in/
  last-out vs. segment-based changes the actual number Payroll would be
  handed.
- **Payroll cannot decide whether it needs its own overtime-pay
  computation, or can simply consume an `overtimeHours` fact,** until
  `ADR-063 §2` (overtime) is ratified. If Attendance defers overtime
  entirely (Option A there), Payroll would need to compute overtime
  eligibility/hours itself from raw attendance days — a materially larger
  scope than if Attendance already hands it a fact.
- **Payroll cannot assume "absent = unpaid" is correctly distinguishable
  from "on approved leave = paid"** until `ADR-063 §3` (leave
  reconciliation) is ratified — this directly determines whether a given
  day reduces pay or not, which is the single most consequential
  Attendance fact Payroll will ever consume.
- **Payroll cannot rely on holidays/weekends being correctly excluded from
  "absence"** until `ADR-063 §7` is ratified — a payroll run that
  incorrectly treats every Friday as an unpaid absence would be
  immediately, visibly wrong.
- **Payroll's own pay-period boundary is independent of, but must align
  with, however Attendance's approval batches are scoped** — `ADR-062 §4`
  did not assume Payroll's own period definition, and this study likewise
  does not assume Attendance's batches will automatically align with
  whatever pay frequency §9 eventually decides. This alignment itself is
  a genuine open question for the eventual Payroll contract, not
  something either side can silently assume of the other.
- **D-ATT1 (module boundary) has no direct effect on Payroll's own
  design** — whether Attendance is `attendance.*` or `hr.attendance.*`
  changes only where Payroll's event subscription points, not what data
  it receives.

**Practical consequence:** the Payroll Phase 1 Implementation Contract
cannot itself be written in detail until `ADR-063` is ratified — this
study can proceed (boundary, GL mechanism, disbursement pattern, module
promotion path) because none of that depends on which options are chosen,
but the actual shape of "what Attendance hands Payroll" does.

## 6. Permissions / Audit / SoD

No new mechanism. Candidate nodes (naming only): `payroll.profile.
{view,create,edit}`, `payroll.run.create`, `payroll.run.approve` (FA-01
checker side, maker/checker split identical in shape to HR's leave
requests and the proposed Attendance approval batch), `payroll.
disbursement.create`. Compensation data (`PayrollProfile`) is exactly the
kind of sensitive field-set that likely needs its OWN narrower visibility
node distinct from general HR visibility — an open design question for
the eventual contract, not decided here.

## 7. Migration impact (for the eventual contract — not authorized now)

Entirely additive: `PayrollProfile`, `PayRun`, `Payslip`, and whatever
deduction/allowance tables §9 resolves. Promotes `payroll` out of
`RESERVED_MODULE_CODES` (the same mechanism `hr` itself went through) —
no existing table is altered. The dormant `5201 Salaries & Wages` account
in the chart-of-accounts template requires no migration — it already
exists; it simply becomes postable once a real poster exists.

## 8. Required business-policy decisions — escalated, not assumed

Per instruction, none of these are decided here:

- **Pay frequency** — monthly, biweekly, or configurable per employee?
- **Salary structure** — single base figure, or components (basic +
  allowances) from day one?
- **Overtime pay rate** — once Attendance hands over overtime hours
  (contingent on `ADR-063 §2`), what rate/multiplier applies, and does it
  vary by employment type?
- **Statutory tax withholding** — Egyptian income tax brackets/mechanics;
  not assumed, not estimated.
- **Social insurance** — employer/employee contribution rates and
  mechanics; not assumed.
- **End-of-service benefits / gratuity** — a real, legally significant
  concept in many Egyptian employment contexts; whether it is in scope
  for Phase 1 at all is itself open.
- **Leave encashment** — does unused approved leave (HR's own
  `LeaveRequest`, `ADR-059`) ever convert to a payroll amount? Not
  assumed; note this creates a THIRD cross-context dependency (Payroll →
  HR's `LeaveRequest`, not just → Attendance) if the answer is yes.
  **Named, deliberately not decided, and deliberately not conflated with
  §5's Attendance-only dependencies.**
- **Deduction/allowance types** — loans, advances, transportation, other
  recurring adjustments — none assumed to exist.
- **Payroll population scope** — does every `EmploymentType` (full_time/
  part_time/contractor, per `ADR-059`) go through Payroll, or are
  contractors handled outside it entirely (e.g., via existing Supplier
  Payment/AP mechanics instead, since a contractor may functionally be a
  vendor)? This is a real architecture-boundary question, not a detail.

## 9. E2E acceptance scenarios (for the eventual contract)

1. A `PayrollProfile` is created for an employee with compensation data,
   independent of and without modifying HR's own `Employee` aggregate.
2. A `PayRun` correctly consumes an `attendance.period.approved` event's
   facts (once `ADR-063` is ratified and Attendance Phase 1 ships) rather
   than reading raw attendance data directly.
3. A `PayRun` is submitted, gated by FA-01 (maker/checker enforced live,
   same SoD proof pattern used in every prior phase), and only posts to
   GL once approved.
4. GL posting resolves Wages Payable via `resolveControlAccount` — no
   hardcoded account reference anywhere in the posting handler.
5. Disbursement follows the Treasury/Payment pattern already proven for
   Supplier Payments — no parallel payment mechanism.
6. Unauthorized users are blocked from every sensitive Payroll action,
   each behind its own permission node.
7. Full regression / clean build / live verification — same bar as every
   prior phase.

## 10. Explicit Non-Goals

- No payroll calculation, tax computation, or salary structure invented.
- No modification to HR Phase 1, `Employee`, or `ADR-059`.
- No modification to Attendance's own `ADR-062`/`ADR-063` — this study
  reads their boundary, never edits it.
- No schema, migration, API, or frontend code.
- No assumption about which `ADR-063` options will be ratified — §5's
  dependencies are named, not pre-resolved.

## 11. Implementation phases (proposed, not authorized)

1. **Payroll Phase 0b** (this document) — architecture study, complete.
2. **Payroll Policy Decision Package** — the §8 items converted into
   bounded options with consequences, same discipline as `ADR-063`, once
   the business is ready to resolve them (not blocked on Attendance).
3. **Payroll Phase 1 Implementation Contract** — cannot be finalized in
   detail until `ADR-063` is ratified and the Attendance Phase 1 contract
   exists (§5's hard dependencies), even though the Policy Decision
   Package (step 2) itself is not blocked on that.
4. **Payroll Phase 1 Implementation** — same tested-as-you-build,
   phase-gated discipline as every prior phase.

---

**No code, migration, schema, or frontend change was made to produce this
study.** HR Phase 1 (`ADR-059`) is not reopened. Attendance's `ADR-062`/
`ADR-063` are read-only inputs, not modified. Production remains HOLD.
This document stops at STUDY/VERIFY.
