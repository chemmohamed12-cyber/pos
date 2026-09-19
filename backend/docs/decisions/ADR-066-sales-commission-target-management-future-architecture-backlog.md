# ADR-066 — Sales Commission & Target Management: Future Architecture Requirements (Payroll Roadmap Backlog)

**Status: RECORDED — architecture/design backlog, not ratified business
policy, not an implementation contract.** This document captures a future
requirement in its correct place in the Payroll roadmap so it is not lost
and is not later built as a naive fixed-rate field. **No code, schema,
migration, API, frontend, or payroll calculation is authorized by this
document, and none is proposed as imminent.** Nothing here modifies HR
Phase 1 (`ADR-059`, CLOSED/PASS), Attendance (`ADR-062`/`ADR-063`/
`ADR-065`), or the Payroll Phase 0 study (`ADR-064`) — it is filed as a
sibling backlog item those documents' own eventual Phase 1 work will need
to account for, not a change to any of them.

Per instruction, every statement below is one of exactly four kinds,
labeled explicitly:

- **Verified Repository Fact** — confirmed by direct inspection just now,
  not carried over from an earlier study.
- **Future Requirement** — what the business has said it will eventually
  need, restated precisely, not expanded.
- **Proposed Architecture** — a shape/boundary worth recording so it isn't
  reinvented differently later, not a decision.
- **Business Policy Decision Required** — explicitly deferred; this
  document does not infer, default, or guess at any of these.

**ملخص تنفيذي (ar):** هذا توثيق معماري فقط لتسجيل متطلب مستقبلي (نظام
العمولات والأهداف البيعية) في مكانه الصحيح ضمن خارطة طريق الـPayroll، حتى
لا يُبنى لاحقًا كحقل نسبة ثابتة مبسّط. لا يوجد هنا أي تنفيذ: لا كود، لا
مخطط قاعدة بيانات، لا migration، لا API، لا واجهة، ولا أي حساب عمولات. لا
يُعاد فتح `ADR-059` (HR Phase 1) ولا يُعدَّل `ADR-064` (دراسة Payroll)؛
هذا مستند شقيق يُسجَّل بجانبهما.

## 0. Verified Repository Fact — current state

- **Zero commission concept exists anywhere.** A full-repository search
  for `commission` returns no matches at all — no entity, no field, no
  calculation, no terminology.
- **"Sales Rep" today is a raw `User` reference, not an HR `Employee`.**
  `CustomerAssignment.salesRepUserId` (`domains/crm/infrastructure/
  customer-assignment.entity.ts`) points directly at a `User` id. It has
  no relationship to HR's `Employee` aggregate (`ADR-059`) at all. This is
  precisely the gap point 1's own concern names: "Sales Rep must not
  become a disconnected duplicate employee identity" — today, it already
  effectively IS disconnected from `Employee`, one layer further removed
  than the request assumes. The one existing bridge is `Employee.userId`
  (`ADR-059` D2, nullable, manual-only linking) — a future Commission
  design resolving "which `Employee` earns this commission" would walk
  `CustomerAssignment.salesRepUserId` → `Employee.userId` in reverse, a
  real, already-available (if currently unused for this purpose) path,
  not a hypothetical one.
- **`CustomerAssignment` is already effective-dated** (`startDate`/
  `endDate`, `status: 'active' | 'ended'`, a new row per reassignment,
  never mutated in place) — the exact discipline point 7 asks a future
  Commission Policy to have. Worth reusing as the model, not reinventing.
- **No Sales Target, quota, or achievement-tracking concept exists
  anywhere.**
- **FA-01 (`ApprovalEngineService`) and `AuditService`** remain, as in
  every prior phase of this program, the only approval and audit
  mechanisms any future design in this area should reuse.
- **`ADR-064 §8`'s Payroll boundary is unchanged and directly analogous**:
  Payroll consumes an *approved result*, never raw source data, and never
  reconstructs a calculation itself. This document's point 8 is the same
  boundary shape applied to Commission instead of Attendance — not a new
  principle, the same one restated for a second future input.

## 1. Business chain — Future Requirement

The dependency chain to be recorded, exactly as specified:

```
HR Employee → Employee Code / Department → Sales Rep → Customer →
Sales Orders / Invoices → Accounting / Collections → Commission Engine →
Approved Commission → Payroll → GL
```

`Employee` remains the authoritative identity. "Sales Rep" is a *role a
given `Employee` plays*, never a second, parallel identity record. Per
§0's verified fact, today's `CustomerAssignment.salesRepUserId` → `User`
path would need to resolve through `Employee.userId` to reach the
authoritative `Employee` — this resolution is itself future design work,
not solved by this document.

## 2. Commission Management Center — Proposed Architecture

A dedicated future bounded context (working name: `commission`), separate
from `hr`, `attendance`, and the eventual `payroll` — the same "don't
merge distinct bounded contexts" discipline `ADR-062 §2` already applied
to Attendance vs. Payroll, extended to a third context here. Commission
policies are configurable rows, not hard-coded percentages — no specific
policy field/table shape is proposed here beyond "configurable, not
literal," per instruction. Candidate policy scopes to support (naming
only, not a schema): company/global default, sales team/group, sales
representative, customer, customer group/category, campaign/segment, and
other approved dimensions — recorded as named possibilities, not an
approved list.

## 3. Customer-level override — Future Requirement + Business Policy Decision Required

**Future Requirement (restated precisely):** a Sales Rep has a default
commission policy/rate. A customer assignment may optionally activate a
Customer Commission Override. If not activated, the Rep/default policy
remains effective. If activated, the customer-specific policy *can* take
precedence.

**Business Policy Decision Required:** the exact precedence hierarchy
(what "can take precedence" resolves to when both a Rep policy and an
active Customer override exist, and how a Customer-Group-level policy
would rank against either) is explicitly NOT decided here, per
instruction — recording the requirement is not the same as resolving it.

## 4. Commission basis — Future Requirement

The future engine must support a configurable calculation basis,
including at minimum: Gross Sales, Net Sales, Collected Amount. Every
applied policy must record which basis it used (this is restated again,
more concretely, in §7's snapshot requirement — not a separate
mechanism).

**Business Policy Decision Required:** which basis is a company's actual
policy, whether it varies by policy scope (§2), and the precise
definition of "Net" (net of what — returns? discounts? tax?) are not
decided or assumed here.

## 5. Target-driven commission — Future Requirement (example figures explicitly not policy)

Sales Representative targets and achievement-tiered commission rates are
a future requirement. The illustrative tiers in the request (`<50% → A,
50–<70% → B, 70–<90% → C, ≥90% → D`) are recorded here **only as an
example of the shape**, exactly as the instruction states — **these
thresholds and rates are not approved company policy** and must not be
treated as a default by any future implementation reading this document.

**Proposed Architecture (shape only):** the engine must eventually
support configurable target value, target period, achievement
percentage, multiple achievement tiers, a rate per tier, effective dates,
and a calculation method — named as the dimensions a Target/Tier model
will need, not as a schema.

**Business Policy Decision Required (explicitly deferred, per
instruction — "do not infer this now"):** whether an achieved tier's rate
applies to (a) the entire eligible amount, (b) only the amount within
that tier, or (c) an incremental/bonus model. This is not inferred,
defaulted, or leaned toward anywhere in this document.

## 6. Policy resolution — Proposed Architecture

A dedicated **Commission Rule Resolution Engine** — explicitly NOT an
`if customerRate else repRate` chain embedded in application code. Two
distinct questions it must answer, kept conceptually separate: *which
policy applies* (a resolution/matching step, structurally similar in kind
to how `ApprovalEngineService`'s own matrix-rule resolution picks the
right approval rule for a request — cited as a shape precedent, not code
to reuse directly, since the domains are unrelated) and, only once
resolved, *how much commission results*. The resolution model must
support explicit priority/specificity ranking and effective dates — both
named as required capabilities, with the actual ranking rules themselves
left to §3's deferred decision.

## 7. Historical integrity — Future Requirement

Commission policies must eventually be effective-dated (§0 already
identifies `CustomerAssignment`'s own effective-dating as the pattern to
follow — new row on change, `effectiveFrom`/`effectiveTo` or `startDate`/
`endDate`, never a mutated single row). A policy change must never
retroactively alter an already-calculated/approved commission result.
Every commission result must retain a snapshot of: applied policy,
applied rate, calculation basis, eligible amount, target/achievement
where applicable, source transactions, and the final commission amount —
the same "evidence, not a working copy" discipline `ADR-062 §3` already
established for Attendance's raw records, applied here to commission
results instead.

## 8. Payroll boundary — Future Requirement (mirrors ADR-064 §8's boundary)

Payroll consumes an **approved Commission Result/Statement** — it must
never independently reconstruct a sales calculation, exactly as `ADR-064
§8` already established that Payroll consumes Attendance's *facts*, never
raw punches. Future flow, as specified:

```
Sales / Accounting / Treasury → Commission Engine → Commission Statement
→ Approval → Payroll Earning → GL
```

The resulting commission amount must remain traceable back to its source
transactions and applied policy at all times (the same snapshot from §7
is what makes this traceability possible — not a second mechanism).

## 9. Target Management — Future Requirement

Sales Targets are recorded as their own future domain, not a field living
inside Commission — targets plausibly outlive and get referenced by more
than commission alone (e.g., a sales dashboard, a performance review)
even though this document does not scope any of that. Candidate future
target dimensions (named, not approved): Employee, Team, Period, Region,
Customer Group, Product Category.

**Business Policy Decision Required:** the exact scope, ownership
(commission's own module vs. a shared/foundational target concept), and
final dimension list are explicitly left open, per instruction.

## 10. Governance

Everything in §1–§9 is a **future architecture requirement / design
backlog item**, not ratified business policy and not an implementation
contract. Nothing here authorizes code, schema, migration, API, frontend,
or calculation work. When Payroll + Commission implementation is formally
authorized, the team builds from a dedicated Policy Decision Package
(same discipline as `ADR-060`/`ADR-063`) resolving every **Business
Policy Decision Required** item named above, followed by its own
Implementation Contract (same discipline as `ADR-061`/`ADR-065`) — never
from an invented default. HR Phase 1 (`ADR-059`) is not reopened. The
Attendance track (`ADR-062`/`ADR-063`/`ADR-065`) and the Payroll Phase 0
study (`ADR-064`) are unmodified by this filing. Production remains HOLD.
