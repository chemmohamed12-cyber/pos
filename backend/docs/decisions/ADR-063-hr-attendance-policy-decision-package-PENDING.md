# ADR-063 — HR Attendance & Biometric Integration: Policy Decision Package

**Status: PROPOSED — CTO decision pending. Analysis only.** No code,
migration, schema, API, frontend, permission, or calculation is authorized
by this document, and none is proposed as imminent. Produced strictly from
`ADR-062` (HR Attendance & Biometric Integration Foundation — Phase 0
Study, accepted baseline, commit `0077d6d`) — no new investigation, no
new claim about the repository is made here that `ADR-062` did not
already establish. `ADR-059` / HR Phase 1 (CLOSED/PASS) is not reopened.
Production remains HOLD.

This document converts `ADR-062 §11`'s nine unresolved items — eight
business-policy questions plus one architecture-boundary question
(`D-ATT1`) — into named, bounded options with real consequences, the same
discipline `ADR-052` (GRNI) and `ADR-060` (Manufacturing Costing) already
used for this codebase's prior CTO decision packages. **It does not choose
an option in any section below and makes no recommendation.**

**ملخص تنفيذي (ar):** هذه حزمة قرار للـCTO فقط — بدون أي تنفيذ وبدون أي
توصية ملزمة. تحوّل النقاط التسع غير المحسومة في `ADR-062 §11` إلى خيارات
صريحة لكل نقطة مع نتائجها الحقيقية، دون اختيار أي خيار هنا. بمجرد صدور
قرار الـCTO في كل نقطة، يُكتب عقد تنفيذ Attendance Phase 1 استنادًا إليها
فقط — وليس قبل ذلك. لا يُعاد فتح `ADR-059` أو HR Phase 1.

---

## Reading guide — how each section is structured

Per instruction, every section below strictly separates three kinds of
statement, labeled explicitly so none can be mistaken for another:

- **Verified Repository Fact** — established in `ADR-062` by direct
  inspection. Nothing new is asserted here; this document does not re-open
  the codebase to check anything `ADR-062` did not already check.
- **Proposed Option** — a bounded, named choice with its real consequence
  and cost/effort. Naming an option is not recommending it.
- **Business Policy Decision Required** — the literal question the CTO
  must answer. Nothing here defaults, infers, or silently picks an option.

## Reuse direction preserved from ADR-062 (unchanged, not re-litigated)

None of the nine decisions below reopen or alter these three points —
they are carried forward from `ADR-062` as fixed design direction,
regardless of which options are chosen:

1. **`foundation/integrations`** (connector registry, generic connector/
   credential/mapping/sync-log entities, one adapter interface per
   connector type) is the template for the device adapter and the
   employee/device mapping model. No parallel mechanism is proposed by
   any option below.
2. **FA-01 (`ApprovalEngineService`)** is the only approval mechanism any
   option below may invoke. No option in this package proposes a second,
   Attendance-specific approval engine.
3. **`AuditService`** is the only audit trail mechanism any option below
   may invoke. No option in this package proposes a second, parallel
   audit log.

---

## D-ATT1 — Attendance Module Boundary (architecture, not business policy)

**Verified Repository Fact:** `RESERVED_MODULE_CODES` (`module-manifest.
type.ts`) does not include `attendance`; it currently lists `manufacturing,
pos, projects, assets, operations, payroll`. `hr` is already its own
entitled, built module (`ADR-029`/`ADR-059`) with its own manifest and
permission root (`hr.*`).

### Option A — New top-level module (`attendance`)

Its own module manifest, its own entitlement gate (`@RequireModule
('attendance')`), its own permission root (`attendance.*`, exactly as
named in `ADR-062 §9`'s candidate nodes).

- **Consequence:** Matches `ADR-062 §2`'s own stated boundary — "Attendance
  is its own bounded context," structurally enforced, not just
  conceptually described. Allows Attendance to be entitled/licensed
  independently of `hr` (e.g. sold, bundled, or disabled separately) —
  relevant if Attendance is ever priced or rolled out on a different
  schedule than core HR. Requires reserving the module code, writing a new
  manifest, and wiring a second entitlement check that HR's own pages
  don't currently need to duplicate.
- **Cost/effort:** Low-to-moderate, entirely structural (manifest +
  registry entry) — no different in kind from how `hr` itself was
  promoted out of `RESERVED_MODULE_CODES` per `ADR-029`.

### Option B — Sub-domain under the existing `hr` module

No new module manifest or entitlement gate. Permission nodes are
`hr.attendance.*` instead of `attendance.*`; Attendance code lives under
`domains/hr/` (or a clearly separated `domains/hr-attendance/` folder
still gated by `@RequireModule('hr')`).

- **Consequence:** Faster to wire — reuses `hr`'s existing entitlement
  check with zero new registry entries. Blurs the bounded-context
  separation `ADR-062 §2` explicitly established (Attendance depending on
  HR only for `employeeId` resolution, never sharing internals) —
  Attendance would now also share HR's *module-level* on/off switch,
  which is a coarser coupling than the plain-uuid dependency `ADR-062`
  proposed. Complicates a future licensing/module split if Attendance is
  ever priced separately from HR.
- **Cost/effort:** Lowest of the two options, but the saving is entirely
  in wiring, not in the actual domain code either option would otherwise
  need.

**Business Policy Decision Required:** Is Attendance its own top-level,
independently-entitled module (Option A), or a sub-domain riding on HR's
existing module gate (Option B)?

**Dependency note:** This decision determines the *namespace* every
permission node in `ADR-062 §9` is written under (`attendance.*` vs.
`hr.attendance.*`) — it does not change what those nodes do, and no other
decision in this package depends on which option is chosen here.

---

## 1. Late / Early-Departure Thresholds

**Verified Repository Fact:** No shift, schedule, or working-hours concept
exists anywhere in this codebase today (`ADR-062 §0`). `Employee.
employmentType` (`full_time | part_time | contractor`, `ADR-059`) exists,
but carries no hours/schedule data. `ADR-062 §4` left `AttendanceDay.
status`'s `late`/`early_departure` values explicitly undefined — the
study defined only the *slot*, never the rule.

### Option A — Single global threshold

One grace-period value (e.g. "N minutes") applied identically to every
employee, regardless of department, shift, or employment type.

- **Consequence:** Immediately buildable with zero other decisions
  resolved first. Cannot express any real-world variation (a night-shift
  worker and a day-shift worker are held to the same clock), which is a
  real limitation if the business has more than one working pattern.

### Option B — Per-shift/per-department configurable threshold

Grace period is configured per shift (or per department), and `AttendanceDay`
resolves against whichever shift/department the employee belongs to.

- **Consequence:** Accurate, but has a hard dependency on the Shift Model
  decision (§4 below) being resolved and built first — this option cannot
  be implemented on its own.

### Option C — No lateness tracking in Phase 1

`AttendanceDay.status` only distinguishes `present | absent | missing_punch
| on_leave | holiday`. `late`/`early_departure` are not computed at all in
Phase 1; the values remain reserved for a later Attendance sub-phase.

- **Consequence:** Zero invented policy, zero risk of getting a threshold
  wrong before the business has weighed in. Keeps the Foundation/Import
  phases (`ADR-062 §14`, Phase 1a/1b) fully decoupled from any lateness
  policy at all. Defers a capability the business may want visible from
  day one.

**Business Policy Decision Required:** Is a lateness/early-departure
threshold needed in Phase 1 at all (C = no), and if yes, is it one global
value (A) or does it require the Shift Model (B, contingent on §4)?

---

## 2. Overtime Definition and Eligibility

**Verified Repository Fact:** No wage, hourly-rate, or payroll concept
exists anywhere in this codebase (confirmed absent in `ADR-062 §0`'s
search). `ADR-062 §8` already established that Attendance hands Payroll
*facts* (hours, late minutes, absence days) and never a computed wage or
rate — that boundary is fixed and not reopened here; this decision is only
about whether Attendance itself labels certain hours "overtime" as a fact.

### Option A — Attendance does not compute overtime at all

Attendance records total hours worked per day only. "Overtime" as a
concept does not exist in Attendance; it is entirely Payroll's own future
computation once wage rules exist (Wave 3).

- **Consequence:** Cleanest possible adherence to the `ADR-062 §8`
  facts-only boundary — Attendance carries zero opinion about what counts
  as extra time. No HR-facing "overtime hours" visibility exists until
  Payroll is built.

### Option B — Attendance computes and labels overtime hours (not pay)

A configured daily/weekly hours threshold (e.g. "> 8h/day") causes
`AttendanceDay` to record an `overtimeHours` fact — never a rate, never an
amount.

- **Consequence:** Gives HR visibility into overtime hours before Payroll
  exists (e.g. for a manager-facing report). Requires deciding the
  threshold now, and requires deciding employment-type eligibility (is a
  `contractor`, per `ADR-059`'s `EmploymentType`, overtime-eligible at
  all?) — both are real business-policy questions with no existing
  precedent anywhere in this codebase to derive a default from.

**Business Policy Decision Required:** Does Attendance compute an
"overtime hours" fact at all in Phase 1 (B), or is the entire concept
deferred to Payroll (A)? If B, what threshold and which employment types
are eligible?

**Dependency note:** If Option B is chosen, the resulting hours figure is
directly affected by whichever option is chosen in §3 (multi-punch
handling) below — a day's "total hours worked" is not well-defined until
that question is answered.

---

## 3. Absence Classification vs. Approved Leave

**Verified Repository Fact:** `LeaveRequest` (`ADR-059`, HR Phase 1,
CLOSED/PASS) already exists with its own `submitted`/`approved` status and
its own FA-01 workflow. Nothing today links a `LeaveRequest`'s date range
to Attendance — `ADR-062` deliberately did not assume this link without an
explicit decision (§11's own wording).

### Option A — No automatic reconciliation

Attendance and `LeaveRequest` remain fully independent. A day with an
approved leave but zero punches is classified `missing_punch` (or
`absent`) by Attendance exactly like any other unexplained gap, unless a
human manually corrects it (§9 below governs who may do that correction).

- **Consequence:** Zero new coupling between the two bounded contexts.
  Real operational cost: every single approved-leave day would need a
  manual correction to avoid showing as an anomaly — for any business with
  routine leave usage, this is a lot of manual correction traffic from day
  one.

### Option B — Attendance reads approved `LeaveRequest` records

Attendance queries HR's approved `LeaveRequest` rows for the employee/date
range and automatically classifies matching days as `on_leave` instead of
`absent`/`missing_punch`.

- **Consequence:** Correct, low-friction outcome — matches what any HR
  user would expect to see. Formally deepens Attendance's dependency on HR
  beyond the plain-`employeeId`-reference boundary `ADR-062 §2`
  established (a read into HR's own `LeaveRequest` table/query, not just
  an id lookup). This is the same *direction* of dependency `ADR-062`
  already accepted (Attendance → HR, never reversed), but a wider surface
  of it — worth its own explicit sign-off rather than being bundled
  silently into "of course they should agree."

**Business Policy Decision Required:** Does Attendance automatically
reconcile against approved `LeaveRequest` records (B), or do the two
systems stay fully independent with manual correction as the only bridge
(A)?

---

## 4. Shift Model

**Verified Repository Fact:** No shift, schedule, or roster concept exists
anywhere in this codebase today. `ADR-062 §4` left `AttendanceDay.shiftId`
as an explicitly optional, undecided field — the slot exists in the
conceptual model; nothing populates or interprets it.

### Option A — No shift model in Phase 1

Every employee is implicitly assumed to follow one standard, unconfigured
working pattern. `shiftId` is not used. Any policy that would otherwise
vary by shift (§1's lateness threshold, for instance) uses one global rule
for everyone.

- **Consequence:** Fastest to build; matches this codebase's own
  established "don't over-engineer V1" precedent (`BillOfMaterial`'s
  deliberate no-versioning simplicity and `Product.unit`'s deliberate
  non-UoM-engine simplicity, both real, shipped precedents in this
  codebase). Cannot represent a business with actual shift variation
  (night shift, rotating roster) from day one.

### Option B — A minimal Shift entity

A `Shift` (name, start time, end time, applicable days) is introduced and
assigned to employees; `AttendanceDay` resolves against the employee's
assigned shift.

- **Consequence:** Correctly models real shift variation, but is itself
  new, undesigned scope: does `Shift` belong to HR (an `Employee`
  attribute) or to Attendance? Is assignment a single current value, or a
  dated history (mirroring the `effectiveFrom`/`effectiveTo` pattern
  `ADR-062 §6` already proposed for device/employee mapping, for the same
  "don't lose history when it changes" reason)? These are open sub-designs,
  not a simple flag to flip on.

**Business Policy Decision Required:** Is a Shift model in scope for
Phase 1 (B) or deferred entirely (A)? If B, does Attendance or HR own the
`Shift` concept, and is assignment single-value or dated-history?

**Dependency note:** §1 (lateness threshold) Option B is contingent on
this decision. Choosing "no shift model" here effectively forecloses §1's
Option B for Phase 1.

---

## 5. Multi-Punch-Per-Day Handling

**Verified Repository Fact:** `ADR-062 §3` defines `punchType` (`in | out |
unknown`) per individual raw punch. Nothing in `ADR-062` defines what
happens when more than one in/out pair occurs on a single day (e.g. a
lunch-break clock-out/in) — the raw model preserves every punch, but the
*derivation* rule into `AttendanceDay.checkIn`/`checkOut` was left open.

### Option A — First-in / last-out only

`AttendanceDay.checkIn` = the day's earliest punch; `checkOut` = the day's
latest punch. Every punch in between is preserved at the raw-record layer
(never discarded, per `ADR-062 §3`'s write-once discipline) but does not
affect the derived day.

- **Consequence:** Simplest, matches how many basic attendance systems
  report by default. Overstates hours worked on any day with an unpaid
  break, since the full first-to-last span is counted as if it were all
  working time.

### Option B — Full multi-segment tracking

Every in/out pair is preserved as a discrete segment within the day; total
worked hours = the sum of segment durations, correctly excluding gaps
between segments (e.g. a lunch break).

- **Consequence:** Accurate hours computation, but requires defining what
  constitutes a segment boundary — is every in/out pair a segment
  regardless of gap length, or only gaps exceeding some minimum duration?
  This sub-question is itself undecided and would need its own answer.

**Business Policy Decision Required:** Does a day's worked-hours
computation use the simple first-in/last-out span (A), or full segment
tracking that excludes gaps (B)? If B, what defines a segment boundary?

**Dependency note:** Directly affects §2 (overtime hours), if that
decision selects Option B there — "hours worked" is not a well-defined
number until this question is answered.

---

## 6. Rounding Rules

**Verified Repository Fact:** No time-rounding convention exists anywhere
in this codebase. The closest analogous precedent — monetary rounding in
Accounting — uses currency-scale decimal rounding, which is not a
transferable convention for clock-time rounding; this study does not treat
it as one.

### Option A — No rounding

Every downstream computation uses exact punch timestamps (to the second or
minute, as recorded).

- **Consequence:** Simplest, most literally defensible in a dispute (no
  invented adjustment to a raw fact). Produces minute-level "noise" in
  reports that most operational attendance systems avoid surfacing
  directly to end users.

### Option B — Rounded to a fixed grid

Timestamps round to the nearest configured interval (e.g. 5, 10, or 15
minutes), with a further, separate choice of rounding **direction**:
always in the employee's favor, always in the employer's favor, or nearest
(mathematical) rounding.

- **Consequence:** Matches common real-world attendance-system behavior
  and produces cleaner reports. Both the grid size and the rounding
  direction are genuine, disputable policy choices with real downstream
  cost implications once Payroll consumes these hours — neither can be
  defaulted without explicit sign-off.

**Business Policy Decision Required:** Is time rounded at all (B) or kept
exact (A)? If B, what grid size, and which rounding direction?

---

## 7. Holiday / Weekend Calendar

**Verified Repository Fact:** `ADR-062 §0`/`§11` explicitly flagged this as
**unverified** — no holiday/weekend/working-calendar concept was found
during that study's search. This is stated precisely as "not found," not
as a confirmed absence across the entire codebase; this document does not
overclaim beyond what `ADR-062` actually established.

### Option A — Attendance builds and owns a minimal Calendar

A list of holiday dates plus a configured weekend pattern (e.g. Friday/
Saturday), scoped entirely within Attendance, used only to classify
`AttendanceDay.status` as `holiday` rather than `absent`/`missing_punch`
on those dates.

- **Consequence:** Addresses a real, basic-correctness gap — without it,
  every non-punch day (including every weekend) would otherwise need to be
  individually reconciled as if it were an anomaly. Introduces a new
  ownership question of its own kind: does a calendar belong to
  Attendance specifically, or is it a shared/foundational concept other
  domains might also eventually want (Manufacturing scheduling, Fiscal
  Period close) — worth checking before building a second one elsewhere,
  though no such existing calendar was found in this study's scope.

### Option B — Defer entirely

No holiday/weekend awareness in Phase 1. Every non-punch day is either
`missing_punch` or reconciled only via approved `LeaveRequest` (§3 above,
if that option is chosen).

- **Consequence:** Lowest build effort, but operationally risky in a way
  the other deferrable items (e.g. §2's overtime) are not: an employee
  showing as an unexplained gap every single Friday/Saturday from day one
  is a visible, immediate wrong-looking result, not a quietly-missing
  nice-to-have.

**Business Policy Decision Required:** Is a holiday/weekend calendar in
scope for Phase 1 (A), and if so, does Attendance own it outright, or
should its ownership be checked against other domains first? Or is it
explicitly deferred (B), accepting the resulting weekend/holiday noise
until it lands?

---

## 8. Correction Authority (Direct vs. FA-01-Gated)

**Verified Repository Fact:** `ADR-059` (HR Phase 1) itself established
two proven, different patterns for sensitive HR actions: employee
termination (D3) is direct and permission-gated, with no FA-01 involved;
leave requests use full FA-01 maker/checker approval. Both patterns are
live and working in this codebase today. `ADR-062 §9` listed `attendance.
correction.create` as its own candidate permission node without
committing to whether it is FA-01-gated.

### Option A — Direct, permission-gated correction

Mirrors `ADR-059` D3 (termination). A single authorized role may amend an
`AttendanceDay` directly; the mandatory audit trail (`AuditService`,
required regardless of which option is chosen, per `ADR-062 §3`'s
traceability requirement) is the only control — no second-approver gate.

- **Consequence:** Fastest for HR admins to fix routine, low-stakes
  data-entry errors (a single wrong punch). Weaker control once this data
  feeds Payroll — an unreviewed correction could silently understate or
  overstate hours feeding pay, with no second set of eyes before it takes
  effect.

### Option B — FA-01-gated correction

Mirrors `ADR-059`'s `LeaveRequest` pattern exactly. Every correction is a
maker request requiring a second user's approval via the existing engine
before it takes effect — zero new mechanism, per this package's preserved
reuse direction.

- **Consequence:** Strongest control, consistent with this codebase's own
  established instinct that a financially-consequential correction earns
  a second reviewer. Adds review friction to what may often be a trivial,
  obviously-correct fix.

### Option C — Threshold-based split

Corrections to an `AttendanceDay` that has **not yet** been included in an
approved batch (`ADR-062 §4`'s FA-01 gate) are direct (Option A);
corrections that would reopen an **already-approved** day require FA-01
re-approval (Option B) — a state the system can derive cleanly from
`ADR-062 §4`'s own approval-batch model, since "has this day's batch
already been approved" is already a well-defined fact in that design.

- **Consequence:** The most operationally sensible split — protects the
  data that actually matters (already-signed-off results Payroll will
  rely on) without adding friction to routine pre-approval fixes. Still a
  real decision, not a default: it requires explicitly defining the
  before/after-approval boundary as the trigger, which is a design choice
  this document names but does not adopt on the CTO's behalf.

**Business Policy Decision Required:** Is `AttendanceDay` correction
direct-only (A), FA-01-gated always (B), or split by whether the day has
already been through an approved batch (C)?

---

## Dependencies between decisions (summary)

- **D-ATT1** only affects permission-node namespacing; it constrains
  nothing else in this package.
- **§1 (lateness) Option B** requires **§4 (shift model) Option B**.
- **§2 (overtime hours)**, if built at all, requires an answer to **§5
  (multi-punch handling)** first — "hours worked" is not defined until
  segment-vs-span is chosen.
- **§3 (leave reconciliation)** and **§7 (holiday calendar)** jointly
  determine what "absent"/"missing_punch" actually means in practice —
  deciding one without the other leaves a visible gap in day
  classification.
- **§8 (correction authority)** is independent of every other decision
  here except that its Option C is only cleanly implementable because
  `ADR-062 §4`'s approval-batch model already exists as written.

## What this document does not do

- It does not choose an option in any of the nine sections above.
- It does not authorize any code, migration, schema, API, frontend,
  permission, or calculation.
- It does not treat `ADR-062` as superseded — it remains the factual
  baseline this decision package is built strictly from.
- It does not reopen or alter `ADR-059` / HR Phase 1 in any way.
- It does not assume Payroll's (Wave 3) own timeline or design — every
  option above that touches the Attendance/Payroll boundary preserves
  `ADR-062 §8`'s "facts only, never a computed wage" boundary unchanged.

## Next step

Per the CTO's explicit instruction, this package stops here for
ratification. Once decisions are issued for D-ATT1 and §1–§8 above, the
next and only next deliverable is the **Attendance Phase 1 Implementation
Contract**, built strictly from those ratified decisions plus `ADR-062`'s
verified findings — and that contract will itself stop for approval before
any implementation begins, exactly as `ADR-059` preceded HR Phase 1 and
`ADR-061` preceded the Manufacturing implementation contract. No
implementation, migration, schema, API, frontend, or calculation work is
proposed as following automatically from this document or from the
eventual contract's mere existence. Production remains HOLD.
