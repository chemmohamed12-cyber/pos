# ADR-067 — Payroll: Policy Decision Package

**Status: RATIFIED (2026-09-19).** All ten original decisions below
(§1–§10) plus six additional binding architectural points the CTO directed
beyond the original scope (§J–§O) have been resolved via the "CTO
DIRECTIVE — ADR-067 Payroll Policy Decision Package" message, issued after
`ADR-068` (Commission & Target) was ratified (commit `1d57782`) and
Attendance was formally closed as **COMPLETE / VERIFIED / HANDOFF-READY
FOR PAYROLL**. This document's original options-analysis body (§1–§10) is
kept intact, unmodified, below the fold, as the historical record of what
was weighed and why — the same "supersede via new content, never rewrite
the analysis" discipline `ADR-052`/`ADR-060`/`ADR-063`/`ADR-068` already
used. **Every decision below is now closed and is not to be reopened or
reinterpreted** except through the escalation categories `ADR-053 §16`
already defines — and one item (the Holiday Calendar's actual data/rules,
§C below) is itself explicitly recorded as such an escalation rather than
invented. The resulting deliverable is the **Payroll Phase 1
Implementation Contract**, not yet written — production remains HOLD; **no
implementation, schema, or migration proceeds from this document alone.**

## RATIFIED DECISIONS (2026-09-19)

Each item is tagged with its governance status, per the CTO's own
classification requirement: **Ratified** (a closed policy choice),
**Deferred** (explicitly out of Phase 1, not rejected), **Extension
Point** (Phase 1 architecture must accommodate it later without a
rebuild, but does not implement it now), or **Escalation** (cannot be
resolved from ratified architecture alone; recorded as open per `ADR-053
§16`, not invented).

| # | Topic | Status | Ratified Direction |
|---|---|---|---|
| **§1 → §A** | Pay Frequency | **Ratified** | Monthly in Phase 1 (closest to original Option A), via an explicit `Payroll Period` (Start/End/Status/Payroll Run) model designed to extend to other frequencies later without rebuilding the bounded context |
| **§2 → §B** | Salary Structure | **Ratified** | Componentized (original Option B): explicit `Earnings → Gross Pay → Deductions → Net Pay` pipeline, never a single figure; effective-dated |
| **§C** | Attendance Interpretation & Day-Type Determination | **Ratified** (architecture) / **Escalation** (Holiday Calendar data) | `AttendanceDay.status = absent` never auto-implies a deduction; Payroll independently determines Working Day / Weekend / Holiday / Approved Leave / Actual Absence before any financial treatment. The Holiday Calendar's actual source/rules remain unresolved — escalated, not invented |
| **§3 → §D** | Overtime | **Ratified** (deferred) + **Extension Point** | No overtime rate, multiplier, or auto-approval invented in Phase 1 (original Option A); architecture must be able to consume a future Approved Overtime Result |
| **§5/§6 → §E** | Tax / Social Insurance | **Extension Point** (boundary ratified) / **Escalation** (rates) | `Payroll Calculation → Tax/Social Insurance Rules → Calculated Deduction` boundary is ratified now, swappable without rebuilding Payroll Core; actual rates/brackets remain Policy Data / Future Configuration, not hardcoded, not invented |
| **§8 → §F** | Leave & Leave Encashment | **Ratified** | `HR LeaveRequest → Approved Leave → Attendance → Payroll Treatment` is the sole authority; Payroll never reinterprets `LeaveRequest` from scratch; encashment, if it occurs, is only an explicit, separately-approved payroll input — never an automatic inference from a leave balance |
| **§9 → §G** | Deductions | **Ratified** | Two-category taxonomy: **System-derived** (tax, social insurance, approved attendance-related deductions) vs. **Approved External/Business** (from an approved administrative source); no deduction may be created from a bare UI action without an authorization/audit/control boundary |
| **§7 → §H** | Gratuity / End-of-Service | **Deferred** + **Extension Point** | No automatic legal calculation engine in Phase 1 unless an approved policy exists later; an architectural extension point must be preserved |
| **§10 → §I** | Contractors / Population Scope | **Ratified** | Contractors are excluded from Employee Payroll Core in Phase 1 (original Option B); no mixing Contractor Settlement with Employee Payroll; a future separate integration/bounded context is possible, not built now |
| **§J** | Commission → Payroll Boundary | **Ratified** | Payroll consumes only an Approved Commission Result/Statement (per ratified `ADR-068 §G`); it never reconstructs commission from Sales/Customer data |
| **§K** | Payroll → GL / Accounting Integration | **Ratified** (boundary) | `Payroll Result → Accounting Event → Control Accounts → Journal`, via the existing Financial Event/`resolveControlAccount` architecture only; idempotency, balanced posting, audit trail, period control, and retry/reconciliation safety are all binding requirements; no new Chart of Accounts |
| **§L** | Payroll Approval / SoD | **Ratified** | Lifecycle at minimum: `Draft → Calculated → Reviewed → Approved → Posted`; FA-01 (`ApprovalEngineService`) reused, not a new engine; SoD enforced wherever policy requires actor separation |
| **§M** | Immutability & Corrections | **Ratified** | No overwrite of an approved/posted Payroll Result; corrections are an `Adjustment`, `Correction`, or `Recalculation Run` depending on state, each fully audited; historical payroll remains traceable |
| **§N** | Payroll Period Control | **Ratified** | No duplicate Payroll Run for the same Employee + Period without explicit policy; no posting into a closed accounting period; no direct edit of an approved/posted run; must integrate with the existing Financial Period control |
| **§O** | Payroll Phase 1 Non-Goals | **Ratified** (explicit exclusion list) | See §O below — sixteen named capabilities are explicitly out of Phase 1 scope, recorded as extension points, not rejections |

**Original status line (superseded by the ratification above, kept for
the record):** *"PROPOSED — CTO decision pending. Analysis only."* No
code, migration, schema, API, frontend, permission, or calculation was
authorized by this document at the time it was written, produced strictly
from `ADR-064` plus the then-newly-ratified `ADR-063` — no new repository
investigation was made beyond what those two documents already
established. `ADR-059` (HR Phase 1, CLOSED/PASS) and `ADR-065` (Attendance
Phase 1 Implementation Contract) were not reopened by this document, and
remain not reopened now.

**ملخص تنفيذي (ar):** تم اعتماد جميع القرارات (§1–§10 الأصلية بالإضافة
إلى ستة نقاط معمارية ملزمة إضافية §J–§O) من قبل الـCTO. النص الأصلي
(تحليل الخيارات دون توصية) محفوظ دون تعديل كسجل تاريخي. أبرز القرارات:
Payroll شهريًا في Phase 1 مع نموذج Payroll Period قابل للتوسع؛ فصل
Earnings/Gross/Deductions/Net بدل رقم واحد؛ Payroll يحدد بشكل مستقل نوع
اليوم (عمل/عطلة أسبوعية/عطلة رسمية/إجازة معتمدة/غياب فعلي) قبل أي معالجة
مالية — مع بقاء تفاصيل تقويم العطلات الرسمية كنقطة تصعيد غير محسومة؛
Overtime وGratuity كـextension points بدون قواعد قانونية مخترعة؛ حدود
واضحة لـTax/Social Insurance كـboundary فقط دون نسب؛ Contractors خارج
الـPayroll Core؛ Commission يُستهلك كنتيجة معتمدة فقط؛ وربط Payroll
بالـGL عبر البنية المحاسبية الموجودة فقط. **لا يوجد أي كود أو migration
أو schema مصرّح به بموجب هذا المستند** — الخطوة التالية فقط هي عقد
تنفيذ Payroll Phase 1، وهو لم يُكتب بعد.

---

## §A — Pay Frequency & Payroll Period Model (ratifies §1)

Phase 1 is **Monthly Payroll**, company-wide (closest to the original §1
Option A). Every Payroll Run is tied to an explicit period:

```
Payroll Period
→ Start Date
→ End Date
→ Status
→ Payroll Run
```

The design must remain extensible to other frequencies later **without
rebuilding the Payroll bounded context** — this is a binding non-
functional requirement on the eventual Implementation Contract's schema,
not a Phase 1 feature to build now. How a Payroll Period aligns against
Attendance's approval-batch periods (the open question §1's original
analysis raised) is resolved by §C below: Payroll independently
determines pay-impact per day, so it does not need the two period
boundaries to be identical, only for Payroll to be able to correctly
attribute each Attendance day within whatever Payroll Period it falls in.

## §B — Salary Structure (ratifies §2)

Compensation is **componentized**, never a single figure (closest to the
original §2 Option B), structured as an explicit pipeline:

```
Earnings
    ↓
Gross Pay
    ↓
Deductions
    ↓
Net Pay
```

Salary structure is **effective-dated** — a salary change never rewrites
the prior period's history, following the same effective-dating
discipline already established for `CustomerAssignment` (`ADR-066 §0`)
and required of Commission/Target policy (`ADR-068 §E`). The exact
Earnings component list (basic, allowances, etc.) is Implementation
Contract detail, not fixed here — this ratification fixes the *shape*
(Earnings/Gross/Deductions/Net as distinct, addressable stages), not the
component catalog.

## §C — Attendance Interpretation & Day-Type Determination (ratifies §4; binding Payroll control, not UI behavior)

Attendance hands Payroll approved facts/results only (per `ADR-064
§0`/`ADR-067`'s preserved reuse direction) — Attendance's role stops
there. **`AttendanceDay.status = absent` does not automatically mean
deduction or unpaid absence.** Payroll is independently responsible for
determining, before any financial treatment is decided:

```
Working Day?
Weekend?
Holiday?
Approved Leave?
Actual Absence?
```

only after which Payroll may decide the financial consequence, if any.
This is a **binding Payroll control**, explicitly not a display/UI-layer
concern — the determination must happen in Payroll's own calculation
logic, not be inferred by a screen presenting Attendance's raw status as
if it were already a pay decision.

**Escalation, not invented:** the original §4 analysis offered "Payroll
owns a minimal calendar" as Option A — that architectural shape is now
ratified (Payroll must have day-type awareness), but the calendar's
actual content — which dates are holidays, which weekday(s) constitute
the weekend — is **not decided by this document** and is recorded here as
an open item per `ADR-053 §16`'s escalation category, not defaulted or
guessed. The Implementation Contract cannot fully specify this piece
until that source/policy is supplied.

## §D — Overtime (ratifies §3; deferred + extension point)

Phase 1 does **not** invent an overtime rate, multiplier, or legal rule,
and does **not** build an engine that assumes one — no statutory rate, no
automatic overtime approval, matching the original §3 Option A's
"deferred" consequence exactly. The Payroll architecture must nonetheless
be **capable of consuming a future Approved Overtime Result** — the same
"approved result only, never a raw recomputation" boundary shape this
program has now used three times (Attendance → Payroll facts, Commission
Result → Payroll, and this) — without assuming what produces that result
or when. No overtime calculation exists anywhere in Phase 1's actual
scope.

## §E — Tax / Social Insurance Boundary (ratifies §5 and §6 together; boundary ratified, rates escalated)

No tax bracket, social-insurance rate, or statutory rule is invented in
this or any prior document in this program. What **is** ratified now is
the architectural boundary itself:

```
Payroll Calculation
        ↓
Tax / Social Insurance Rules
        ↓
Calculated Deduction
```

These rules must be **changeable without rebuilding Payroll Core** — i.e.
the Implementation Contract must design this as a pluggable rules
boundary, not inline calculation logic baked into the core engine. Any
rate or threshold not yet approved remains **Policy Data / Future
Configuration**, never hardcoded logic — this is a binding constraint on
how the eventual contract's schema must shape this boundary, even though
the actual Egyptian tax/insurance figures themselves remain unsourced and
unratified, exactly as `ADR-064 §8` already flagged.

## §F — Leave & Leave Encashment (ratifies §8)

Approved Leave is the sole official source for leave treatment inside
Payroll, via the existing chain:

```
HR LeaveRequest
      ↓
Approved Leave
      ↓
Attendance
      ↓
Payroll Treatment
```

**Payroll must never reinterpret `LeaveRequest` from scratch** — it
consumes the already-approved leave fact exactly as Attendance itself
already does (`ADR-063 §3`, ratified). Leave Encashment, if it occurs in
Phase 1 at all, must be an **explicit, separately-approved payroll
input** — never an automatic system-computed inference from a leave
balance. This resolves the original §8 analysis's Option A/B framing with
a third, more constrained shape neither option fully named: encashment is
not blanket in-scope with an automatic conversion rule (Option A), nor
fully deferred (Option B) — it may occur, but only as a manually-
initiated, individually-approved amount, never a formula Payroll derives
on its own.

## §G — Deductions Taxonomy (ratifies §9)

Deductions/allowances are configurable (original §9 Option B), split into
exactly two categories:

- **System-derived** — tax, social insurance, and approved attendance-
  related deductions (e.g. whatever §C's day-type determination and §D/§E
  eventually produce as a pay-impacting fact).
- **Approved External / Business deductions** — deductions originating
  from an approved administrative source (e.g. a loan repayment, an
  advance), not system-computed.

**No deduction may be created from a bare UI action** without an
authorization/audit/control boundary around it — this is a binding
governance constraint on the eventual Implementation Contract's
permission and audit design, not merely a data-modeling note.

## §H — Gratuity / End-of-Service (ratifies §7; deferred + extension point)

Phase 1 does **not** include an automatic legal gratuity/end-of-service
calculation engine unless and until an approved policy exists for it
(matches the original §7 Option B's deferred consequence). An appropriate
**architectural extension point** must be preserved so this capability
can be added later without a structural rebuild — no specific mechanism
for that extension point is prescribed here.

## §I — Contractors / Payroll Population Scope (ratifies §10)

Contractors are excluded from the Employee Payroll Core in Phase 1
(original §10 Option B, ratified as-is) — Contractor Settlement is never
mixed with Employee Payroll. A separate integration or bounded context
for contractor settlement may be built later if needed; nothing of that
kind is built now.

## §J — Commission → Payroll Boundary (new; ratifies and restates ADR-068 §G for Payroll's own document)

Commission's architecture is Ratified in `ADR-068`. Payroll **never**
recomputes a commission from Sales data. The mandatory path is:

```
Sales
 ↓
Invoice / Collection
 ↓
Commission Resolution
 ↓
Immutable Commission Result
 ↓
Commission Approval
 ↓
Payroll
 ↓
GL
```

Payroll consumes an **Approved Commission Result / Statement** only — it
does not read Sales Orders or Customers to reconstruct a commission. This
is not a new decision; it restates `ADR-068 §G`'s already-ratified
boundary as binding on Payroll's own Implementation Contract as well, so
that document does not need to re-derive it from `ADR-068` independently.

## §K — Payroll → GL / Accounting Integration (new; ratified boundary)

Payroll must produce an accounting result postable to GL strictly through
the existing Financial Event / Posting architecture — it never mutates GL
directly outside that mechanism. The required chain:

```
Payroll Result
→ Accounting Event
→ Control Accounts
→ Journal
```

using the existing `resolveControlAccount` mechanism (`ADR-064 §0`/§4,
confirmed live and reusable) — **no new Chart of Accounts is invented**;
the dormant `5201 Salaries & Wages` template line, and whatever control-
function-tagged accounts already exist or are added the same way, are the
only accounts involved. The following are binding, non-negotiable
properties of that posting, matching every prior Financial Event handler
in this codebase:

- **Idempotency** — reprocessing the same Payroll Result must never
  double-post.
- **Balanced posting** — every journal entry balances, no exception.
- **Audit trail** — via the existing `AuditService`, no parallel log.
- **Period control** — integrates with the existing Financial Period
  mechanism (see §N below).
- **Retry/reconciliation safety** — a failed post must be safely
  retryable without corrupting state, the same discipline the currently-
  committed `submitApprovalBatch` fix (commit `d76e22e`) already
  established for Attendance's own approval-batch/GL-adjacent flow.

## §L — Payroll Approval / SoD (new; ratified)

A Payroll Run must **not** move directly to `Posted` merely upon
calculation. The lifecycle is, at minimum:

```
Draft
→ Calculated
→ Reviewed
→ Approved
→ Posted
```

with permission separation such that the same actor cannot bypass an
approval boundary where policy requires separation of duties. **FA-01
(`ApprovalEngineService`) is reused** — no new approval engine is built,
consistent with every prior phase of this program (HR leave requests,
Attendance approval batches, and now Payroll Runs all share the one
mechanism).

## §M — Immutability & Corrections (new; ratified)

After a Payroll Run is Approved/Posted, **its result may never be
overwritten.** Any later correction must be one of:

```
Adjustment
Correction
Recalculation Run
```

depending on the situation, each with a complete audit trail. Historical
Payroll data must remain fully traceable at all times — the same
"evidence, not a working copy" discipline `ADR-062 §3` established for
Attendance's raw records and `ADR-068 §F` established for Commission
Results, applied here to Payroll Results as the third instance of the
same pattern in this program.

## §N — Payroll Period Control (new; ratified)

Payroll must integrate with the **existing Financial Period control**
mechanism, not a parallel one. Binding constraints:

- No duplicate Payroll Run for the same Employee + Period without an
  explicit, clearly-defined policy permitting it.
- No posting into a **closed** accounting period.
- No direct edit of an approved/posted run — only the §M correction paths
  apply.

## §O — Payroll Phase 1 — Explicit Non-Goals

The following are explicitly **out of Phase 1 scope** — recorded as
extension points or deferred capabilities, not rejected outright, exactly
matching this program's existing convention for naming a boundary without
foreclosing it permanently:

- Contractor Payroll (§I)
- Automatic legal gratuity engine (§H)
- Automatic legal overtime calculation (§D)
- Unapproved holiday policy assumptions (§C)
- An advanced, unapproved tax-law engine (§E)
- An advanced bonus engine
- A workforce scheduling engine
- Attendance device implementation
- Rebuilding Attendance in any form
- A Commission calculation engine (Payroll only ever consumes `ADR-068`'s
  approved result, per §J)

## Dependency & Conflict Review

- **`ADR-059` (HR Phase 1, CLOSED/PASS):** not reopened. §B's effective-
  dated compensation model and §F's `LeaveRequest` consumption both read
  HR's existing aggregates without modification.
- **Attendance closure (`ADR-062`/`ADR-063`/`ADR-065`, now COMPLETE /
  VERIFIED / HANDOFF-READY FOR PAYROLL):** not reopened. §C's day-type
  determination consumes Attendance's approved facts (`attendance.period.
  approved`) exactly as `ADR-064 §0` already established — Payroll adds
  its own financial interpretation on top, it does not ask Attendance to
  change what it hands over.
- **`ADR-064` (Payroll Phase 0 Study):** this document is `ADR-064 §11`'s
  own Step 2 (Payroll Policy Decision Package), now complete. §K/§J both
  directly implement mechanisms `ADR-064 §0`/§4 already identified as
  reusable (`resolveControlAccount`, the Treasury/`SupplierPaymentService`
  disbursement shape) — no conflict, no new mechanism invented.
- **`ADR-068` (Commission & Target, RATIFIED, commit `1d57782`):** §J
  restates, does not alter, `ADR-068 §G`'s Payroll-consumption boundary.
  No conflict.
- **Accounting / Financial Period:** §K/§N bind Payroll to the existing
  Financial Event and Financial Period mechanisms without proposing any
  change to either — Payroll is a new *poster* into that architecture,
  not a modification of it.
- **Treasury / GL:** §K's disbursement shape (referenced via `ADR-064
  §0`'s already-cited `TreasuryAccount`/`SupplierPaymentService` pattern)
  and control-account resolution are both reused unchanged — no new
  disbursement or GL-write mechanism is proposed.
- **No conflict found between any decision above and any other ADR in
  this program.**

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
