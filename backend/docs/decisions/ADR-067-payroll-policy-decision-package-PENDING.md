# ADR-067 — Payroll: Policy Decision Package

**Status: PROPOSED — CTO decision pending. Analysis only.** No code,
migration, schema, API, frontend, permission, or calculation is authorized
by this document. Produced strictly from `ADR-064` (Payroll: Phase 0
Architecture Study, accepted baseline) plus the now-ratified `ADR-063`
(Attendance Policy Decision Package, RATIFIED 2026-09-19) — no new
repository investigation is made beyond what those two documents already
established. `ADR-059` (HR Phase 1, CLOSED/PASS) and `ADR-065` (Attendance
Phase 1 Implementation Contract) are not reopened by this document.

This document converts `ADR-064 §8`'s nine unresolved business-policy
items — plus one item `ADR-064 §5` identified as a hard Attendance-boundary
consequence that §8 did not itself enumerate as its own line (weekend/
holiday pay treatment) — into named, bounded options with real
consequences, the same discipline `ADR-052` (GRNI), `ADR-060`
(Manufacturing Costing), and `ADR-063` (Attendance) already used for this
codebase's prior CTO decision packages. **It does not choose an option in
any section below and makes no recommendation.**

**ملخص تنفيذي (ar):** هذه حزمة قرار للـCTO فقط — بدون أي تنفيذ وبدون أي
توصية ملزمة. تحوّل النقاط التسع في `ADR-064 §8` (بالإضافة إلى أثر مباشر
لقرار الإجازات الأسبوعية/العطلات الرسمية من `ADR-063 §7`) إلى خيارات
صريحة لكل نقطة مع نتائجها الحقيقية، دون اختيار أي خيار هنا. بمجرد صدور
قرار الـCTO في كل نقطة، يُكتب عقد تنفيذ Payroll Phase 1 استنادًا إليها
فقط — وليس قبل ذلك. لا يُعاد فتح `ADR-059` أو `ADR-065`.

---

## Reading guide — how each section is structured

Per the discipline `ADR-063` established, every section below strictly
separates three kinds of statement:

- **Verified Repository Fact** — established in `ADR-064` (or, where
  explicitly cited, `ADR-063`'s now-ratified table) by direct inspection.
  Nothing new is asserted here.
- **Proposed Option** — a bounded, named choice with its real consequence
  and cost/effort. Naming an option is not recommending it.
- **Business Policy Decision Required** — the literal question the CTO
  must answer. Nothing here defaults, infers, or silently picks an option.

## Reuse direction preserved from ADR-064 (unchanged, not re-litigated)

None of the ten decisions below reopen or alter these points — they are
carried forward from `ADR-064` as fixed design direction, regardless of
which options are chosen:

1. **`resolveControlAccount`** is the only GL control-account resolution
   mechanism any option below may invoke (Wages Payable, Payroll Tax/
   Social-Insurance Payable). No option proposes a hardcoded account
   reference or a parallel resolution mechanism.
2. **`TreasuryAccount` / `SupplierPaymentService`'s disbursement shape**
   is the only pattern any option below may follow for paying employees.
   No option proposes a second, parallel payment mechanism.
3. **FA-01 (`ApprovalEngineService`) and `AuditService`** are the only
   approval and audit mechanisms any option below may invoke.
4. **`PayrollProfile` stays off HR's `Employee` aggregate**, owned by
   Payroll and referencing `employeeId` only — mirrors how Attendance's
   device mappings stay off `Employee`. No option reopens this boundary.
5. **Payroll consumes Attendance's `attendance.period.approved` event
   facts, never raw punches** (`ADR-064 §0`, itself carrying forward
   `ADR-062 §8`). No option below proposes Payroll reading Attendance's
   raw records directly.

---

## 1. Pay Frequency & Period Alignment with Attendance

**Verified Repository Fact:** No pay-frequency or pay-period concept
exists anywhere in this codebase (`ADR-064 §0`). `ADR-064 §5` explicitly
flagged that "Payroll's own pay-period boundary is independent of, but
must align with, however Attendance's approval batches are scoped" as a
genuine open question neither side can silently assume of the other.
Attendance's own approval-batch period is caller-supplied (`periodStart`/
`periodEnd`, `ADR-065`) — it has no fixed frequency of its own to inherit.

### Option A — Single company-wide frequency (e.g. monthly)

Every employee is paid on the same cycle; `PayRun` periods are fixed at
this one frequency.

- **Consequence:** Simplest to build — one `PayRun` period definition,
  one alignment rule against Attendance's approval-batch period. Cannot
  express a business that pays some employee population (e.g. daily-wage
  labor) on a different cycle than salaried staff, if that need exists.

### Option B — Per-employee configurable frequency

`PayrollProfile` carries its own frequency (monthly/biweekly/other);
`PayRun` generation must group employees by frequency and independently
align each group's period against the correct Attendance approval
batches.

- **Consequence:** Matches real-world payroll systems more closely.
  Materially larger scope: `PayRun` can no longer assume "one period for
  everyone," and the Attendance-alignment question in §5 below multiplies
  per frequency rather than being answered once.

**Business Policy Decision Required:** Is pay frequency fixed company-wide
(A), or configurable per employee (B)? Either way, how must a `PayRun`
period line up against Attendance's approval-batch periods — must they be
identical date ranges, or may Payroll aggregate multiple approved
Attendance batches into one pay period?

---

## 2. Salary Structure

**Verified Repository Fact:** `Employee` (`ADR-059`, HR Phase 1, CLOSED)
has zero compensation fields. `ADR-064 §3` proposed `PayrollProfile` as
the new home for compensation data but deliberately left its internal
shape undefined pending this decision.

### Option A — Single base-salary figure

`PayrollProfile.baseSalary` is one number per employee. Any variable pay
(allowances, etc.) is out of scope until a later phase.

- **Consequence:** Fastest to build, matches this codebase's own "don't
  over-engineer V1" precedent noted elsewhere (`ADR-063 §4`'s Shift-model
  reasoning). Cannot represent a business whose compensation already
  includes fixed allowances (housing, transport) as separate, individually
  visible components from day one.

### Option B — Componentized salary (basic + allowances)

`PayrollProfile` decomposes pay into named components (basic, housing
allowance, transport allowance, etc.), each independently configurable
per employee.

- **Consequence:** Matches real payslip expectations and is very likely
  required once §5/§6 (tax/insurance) are resolved, since statutory
  calculations in many jurisdictions apply differently to "basic" vs.
  "allowance" amounts. Is itself new, undesigned scope: what the fixed
  component list is, whether components are configurable per-company or
  hardcoded, is not decided by choosing B alone.

**Business Policy Decision Required:** Is compensation a single base
figure in Phase 1 (A), or componentized (B)? If B, what is the initial
component list?

---

## 3. Overtime Pay Rate & Eligibility

**Verified Repository Fact:** `ADR-063 §2` is now ratified: Attendance
"calculates hours worked as a factual result only; no wage/overtime-pay
computation" — Attendance does **not** hand Payroll a separate
`overtimeHours` fact. `ADR-063 §5` (multi-punch handling) is ratified as
Option A, first-in/last-out span — so the one figure Attendance does hand
over is a single per-day hours-worked span, which may overstate actual
worked time on any day with an unpaid break. `ADR-064 §5` already named
this exact contingency: "If Attendance defers overtime entirely..., Payroll
would need to compute overtime eligibility/hours itself from raw
attendance days" — that contingency is now the confirmed, ratified state,
not a hypothetical.

### Option A — No overtime pay in Phase 1

Payroll pays the componentized/base salary (§2) regardless of hours
worked beyond a standard day; no overtime amount is calculated at all.

- **Consequence:** Zero invented threshold or rate. Cleanest possible
  Phase 1 scope. An employee routinely working beyond standard hours earns
  nothing extra for it under this option — a real compensation-policy gap
  if that scenario exists in the business today.

### Option B — Payroll computes overtime from the hours-worked span

Payroll applies its own configured daily/weekly threshold to the
hours-worked figure Attendance already hands over, and its own rate/
multiplier, to compute an overtime amount.

- **Consequence:** Delivers the capability without waiting on a future
  Attendance revision. Requires deciding the threshold, the rate/
  multiplier, and employment-type eligibility (is a `contractor`, per
  `ADR-059`'s `EmploymentType`, eligible at all?) — none of which has any
  existing precedent in this codebase to derive a default from. Because
  the underlying span (§ above) can overstate hours on days with unpaid
  breaks, any overtime computed from it inherits that same imprecision
  unless Attendance's multi-punch handling is revisited later (a change
  to `ADR-063 §5`, out of scope for this document).

**Business Policy Decision Required:** Does Payroll compute overtime pay
at all in Phase 1 (B), or is it deferred entirely (A)? If B, what
threshold, what rate/multiplier, and which employment types are eligible?

---

## 4. Weekend / Holiday Pay Treatment

**Verified Repository Fact:** `ADR-063 §7` is ratified as Option B —
holiday/weekend calendar awareness is **deferred**. Attendance has no
concept of a non-working day; every day without a punch and without an
approved `LeaveRequest` is classified `absent`/`missing_punch`, including
every weekend day, with no calendar to say otherwise. `ADR-064 §5`
specifically warned: "a payroll run that incorrectly treats every Friday
as an unpaid absence would be immediately, visibly wrong." This is not a
hypothetical risk — it is the literal, current, ratified state of the
Attendance facts Payroll would consume today.

### Option A — Payroll builds and owns its own minimal working-day calendar

Independent of Attendance, `PayrollProfile` (or a company-wide setting)
defines a weekend pattern and holiday list; Payroll excludes those dates
from its own pay-impact calculation regardless of what Attendance's raw
day-status says.

- **Consequence:** Solves the correctness problem without waiting on or
  reopening `ADR-063 §7`. Creates a second calendar concept alongside
  whatever Attendance (or another domain) might independently build later
  — `ADR-064 §7` already flagged this exact duplication risk in a
  different context ("does a calendar belong to Attendance specifically,
  or is it a shared/foundational concept") and this option does not
  resolve that question, it just answers it narrowly for Payroll alone.

### Option B — Payroll treats every non-leave, non-punch day as unpaid absence

No calendar anywhere; Payroll takes Attendance's `absent`/`missing_punch`
days literally, including weekends and holidays.

- **Consequence:** Zero new scope, fully consistent with `ADR-063 §7`'s
  deferral. Produces the exact visibly-wrong outcome `ADR-064 §5` warned
  about — every employee's pay would be reduced for every weekend day
  worked or not, unless HR/Attendance corrects every single weekend day
  manually (a large, recurring manual-correction burden, structurally
  identical to the burden `ADR-063 §3`'s Option A would have created for
  leave, which is why that item was ratified as automatic reconciliation
  instead).

### Option C — Defer overtime *and* absence-based pay reduction entirely; pay the fixed salary regardless of attendance in Phase 1

Payroll ignores Attendance facts for pay-impact purposes in Phase 1; the
`attendance.period.approved` event is consumed only for record-keeping/
display, not for reducing pay. Absence-based deductions become a later
phase's decision.

- **Consequence:** Sidesteps the calendar problem entirely by not needing
  one yet. Means "Payroll consumes Attendance results" (the entire premise
  of §5 of `ADR-064` and of this brief's own Attendance→Payroll contract
  requirement) has no actual pay consequence in Phase 1 — worth naming
  explicitly as an option because it is a real, valid scope-narrowing
  choice, not because it is being suggested as preferable.

**Business Policy Decision Required:** Does Payroll build its own minimal
working-day calendar to correctly exclude weekends/holidays from
attendance-driven pay impact (A), accept Attendance's literal day status
including weekends as unpaid absence (B), or defer attendance-based pay
impact entirely in Phase 1 (C)?

**Dependency note:** This decision is only relevant if §7 below (deduction
types) includes any absence-based deduction. If Option C above is chosen,
§7's absence-deduction question is moot for Phase 1.

---

## 5. Statutory Income Tax Withholding

**Verified Repository Fact:** No tax-bracket, tax-rate, or withholding
concept exists anywhere in this codebase (`ADR-064 §0`, confirmed by a
targeted search for `socialInsurance|incomeTax|taxBracket|statutory`,
zero hits). `ADR-064 §0` explicitly notes this codebase's Arabic/Egypt-
facing context makes this a real, not theoretical, obligation.

### Option A — In scope for Phase 1

Payroll implements Egyptian income-tax withholding brackets/mechanics as
part of the initial calculation.

- **Consequence:** A complete, statutorily-compliant Phase 1 payroll
  output. Requires sourcing and encoding the actual current tax brackets/
  rules as an explicit, separately-verified input — not something this
  document, or any prior study in this program, has done or may infer.

### Option B — Deferred; Phase 1 computes gross pay only

Payroll computes and disburses gross pay; statutory withholding is a
later phase.

- **Consequence:** Materially smaller, faster Phase 1 scope. A Phase 1
  "payroll" that does not withhold statutory tax is not a product a real
  Egyptian business could actually run its payroll through end-to-end —
  worth being explicit that this option produces a calculation engine and
  disbursement pipeline proof-of-concept, not a compliant payroll system,
  until a later phase closes this gap.

**Business Policy Decision Required:** Is statutory income-tax withholding
in scope for Phase 1 (A — and if so, what are the actual current brackets/
rules, sourced from where), or deferred (B)?

---

## 6. Social Insurance Contributions

**Verified Repository Fact:** Same as §5 — zero existing concept,
confirmed absent by the same search. `ADR-064 §4` named
`social_insurance_payable` only as a *candidate control-function name*,
explicitly not authorized for creation.

### Option A — In scope for Phase 1

Payroll computes both employer and employee social-insurance contribution
amounts as part of the calculation, posting the employer share as an
expense and both shares' liability via `resolveControlAccount`.

- **Consequence:** Statutorily complete. Requires the actual current
  contribution rates/rules and the employer/employee split as an explicit
  sourced input, exactly as §5.

### Option B — Deferred

Social insurance is not computed in Phase 1; only gross pay (and, if §5
Option A, income tax) is calculated.

- **Consequence:** Same trade-off as §5 Option B — smaller Phase 1 scope,
  same compliance gap until a later phase.

**Business Policy Decision Required:** Is social insurance in scope for
Phase 1 (A — and if so, what are the current employer/employee
contribution rates), or deferred (B)?

**Dependency note:** §5 and §6 are independent decisions (a business could
reasonably resolve tax first and insurance later, or vice versa), but if
either is deferred, §2's componentized-salary question (if Option B was
chosen there) still stands on its own — component decomposition is not
contingent on whether tax/insurance is computed against those components
yet.

---

## 7. End-of-Service Benefits / Gratuity

**Verified Repository Fact:** No concept of end-of-service benefit,
gratuity, or severance exists anywhere in this codebase. `ADR-064 §8`
names this as "a real, legally significant concept in many Egyptian
employment contexts" without assuming its applicability.

### Option A — In scope for Phase 1

Payroll (or a Payroll-adjacent process) computes and can disburse an
end-of-service benefit at termination, integrated with HR's existing
`Employee` termination flow (`ADR-059` D3).

- **Consequence:** Complete coverage of a legally significant obligation.
  Requires defining the actual calculation rule (tenure-based? salary-
  based? both?) as a new, sourced business input — not inferable from
  anything currently in this codebase.

### Option B — Deferred entirely

No end-of-service benefit calculation exists in Phase 1; if the business
needs to pay one, it is handled manually outside the system for now.

- **Consequence:** Smaller Phase 1 scope. A real compensation obligation
  remains system-invisible until a later phase.

**Business Policy Decision Required:** Is end-of-service benefit/gratuity
calculation in scope for Phase 1 (A — and if so, what is the calculation
rule), or deferred (B)?

---

## 8. Leave Encashment

**Verified Repository Fact:** HR's `LeaveRequest` (`ADR-059`, CLOSED)
tracks approved leave but has no concept of encashment (converting unused
leave to a payroll amount). `ADR-064 §8` flags that if this is in scope,
it creates a **third** cross-context dependency — Payroll → HR's
`LeaveRequest` directly, distinct from and in addition to the Payroll →
Attendance dependency §1–§4 above already establish. `ADR-064` is explicit
that this must not be conflated with the Attendance-only dependencies.

### Option A — In scope for Phase 1

Payroll reads HR's approved/unused `LeaveRequest` balance and can convert
it to a payroll amount under some rule.

- **Consequence:** Completes a real compensation scenario some businesses
  require. Adds the third cross-context read `ADR-064` flagged, and
  requires defining the conversion rule (per-day rate basis, eligible
  leave types, timing/trigger) as new, undecided design.

### Option B — Deferred

No leave-encashment capability exists in Phase 1; unused leave has no
payroll consequence.

- **Consequence:** Avoids the third dependency and its undesigned
  conversion rule entirely for now. A real capability gap if the business
  practices leave encashment.

**Business Policy Decision Required:** Is leave encashment in scope for
Phase 1 (A — and if so, what is the conversion rule), or deferred (B)?

---

## 9. Deduction / Allowance Types

**Verified Repository Fact:** No deduction/allowance concept (loans,
advances, transportation, etc.) exists anywhere in this codebase.
`ADR-064 §8` names this as an open list, not assumed to exist.

### Option A — No configurable deductions/allowances beyond §2's salary structure in Phase 1

Pay equals whatever §2 resolves to (plus/minus §3/§5/§6/§7/§8 if in
scope), full stop — no loan repayments, advances, or other recurring
adjustments.

- **Consequence:** Smallest possible scope; fastest to ship. Cannot
  represent common real-world adjustments (an active salary-advance
  repayment, a recurring transportation deduction) if the business needs
  them from day one.

### Option B — A configurable deduction/allowance type list

`PayrollProfile` or `PayRun` supports a named, extensible list of
recurring adjustment types, each with its own amount/rule.

- **Consequence:** Matches real payroll needs more closely. The type list
  itself, and whether each type is a flat amount, a percentage, or a
  scheduled repayment (e.g. an advance with a balance that decrements each
  period), is new, undesigned scope — not resolved by choosing B alone.

**Business Policy Decision Required:** Are configurable deductions/
allowances in scope for Phase 1 (B — and if so, what is the initial type
list and how is each type calculated), or is Phase 1 salary-only (A)?

---

## 10. Payroll Population Scope

**Verified Repository Fact:** `Employee.employmentType`
(`full_time | part_time | contractor`, `ADR-059`) exists today with no
payroll consequence of any kind currently. `ADR-064 §8` names this as "a
real architecture-boundary question, not a detail" — a `contractor` may
functionally be a vendor already served by the existing Supplier Payment/
AP mechanics (`ADR-064 §0`'s cited `SupplierPaymentService`).

### Option A — All employment types go through Payroll

Every `Employee` regardless of `employmentType` is a `PayrollProfile`
candidate and flows through the same `PayRun`/disbursement pipeline.

- **Consequence:** One uniform pipeline, simplest mental model. May not
  match how contractors are actually engaged/paid today if that already
  happens through Procurement/AP — could create two parallel payment
  paths for the same person if a contractor is *also* set up as a
  Supplier elsewhere.

### Option B — Contractors are excluded from Payroll; handled via existing Supplier/AP mechanics

Only `full_time`/`part_time` employees get a `PayrollProfile`; contractor
compensation continues (or begins) flowing through Procurement's existing
Supplier Payment pipeline, unchanged by this document.

- **Consequence:** Avoids inventing a second payment path for a population
  already served by a proven mechanism. Requires an explicit, if simple,
  scope rule at every point Payroll enumerates its employee population
  (`PayRun` generation, reporting, etc.) to exclude contractors correctly.

**Business Policy Decision Required:** Does Payroll's population include
every `EmploymentType` (A), or are contractors explicitly out of scope for
Payroll and left to existing Supplier/AP mechanics (B)?

---

## Dependencies between decisions (summary)

- **§1 (pay frequency)** determines how many independent period-alignment
  problems §3/§4's attendance-consumption logic must solve — one if
  Option A, potentially several if Option B.
- **§2 (salary structure)**, if resolved as componentized (Option B), is a
  practical prerequisite for §5/§6 (tax/insurance) to be encoded
  correctly, since statutory rules commonly apply differently to
  different components — not a hard blocker, but a strong sequencing
  consideration.
- **§3 (overtime)** is only computable at all once §1 (`ADR-063 §5`,
  ratified) already fixed "hours worked" as a first-in/last-out span —
  this is not a new dependency, it is already resolved fact, restated
  here because §3's own consequence text depends on it.
- **§4 (weekend/holiday treatment)** is only material if §9 (deductions)
  includes any absence-based deduction; if §4 Option C is chosen, this
  entire question is moot for Phase 1 regardless of what §9 decides.
- **§8 (leave encashment)**, if resolved as in-scope, is the only decision
  in this package that creates a dependency on HR's `LeaveRequest` beyond
  what `ADR-063 §3` already established for Attendance — named explicitly
  per `ADR-064 §8`'s own instruction not to conflate it with the
  Attendance-only dependencies (§3/§4 above).
- **§10 (population scope)** is independent of every other decision here
  — it constrains *who* goes through the pipeline the other nine
  decisions define, not *what* the pipeline computes.

## What this document does not do

- It does not choose an option in any of the ten sections above.
- It does not authorize any code, migration, schema, API, frontend,
  permission, or calculation.
- It does not treat `ADR-064` as superseded — it remains the factual
  baseline this decision package is built strictly from.
- It does not reopen or alter `ADR-059` (HR Phase 1) or `ADR-065`
  (Attendance Phase 1) in any way.
- It does not source or estimate any actual tax bracket, insurance rate,
  or statutory figure — §5/§6/§7 name that these must be sourced, they do
  not supply a number.
- It does not assume Commission's (`ADR-066`) own timeline or design —
  Commission's own policy items are the subject of a separate, sibling
  decision package (`ADR-068`), not this document.

## Next step

Once decisions are issued for §1–§10 above, the next and only next
deliverable is the **Payroll Phase 1 Implementation Contract**, built
strictly from those ratified decisions plus `ADR-064`'s verified findings
— and that contract will itself stop for approval before any
implementation begins, exactly as `ADR-059` preceded HR Phase 1, `ADR-061`
preceded the Manufacturing implementation contract, and `ADR-065` preceded
Attendance Phase 1. No implementation, migration, schema, API, frontend,
or calculation work is proposed as following automatically from this
document or from the eventual contract's mere existence. Production
remains HOLD.
