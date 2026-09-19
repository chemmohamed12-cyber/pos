# ADR-068 — Sales Commission & Target Management: Policy Decision Package

**Status: RATIFIED (2026-09-19).** All five decisions below (§1–§5) have
been resolved by the CTO, via the "CTO Directive — Payroll + Commission &
Target Policy Resolution" message. This document's original
options-analysis body is kept intact, unmodified, below the fold, as the
historical record of what was weighed and why — the same "supersede via
new content, never rewrite the analysis" discipline `ADR-052`/`ADR-060`/
`ADR-063` already used. **These five decisions, plus the additional
binding specifications in §§A–H below, are now closed and are not to be
reopened or reinterpreted** except through the escalation categories
`ADR-053 §16` already defines. The resulting deliverable is the
**Commission & Target Phase 1 Implementation Contract**, not yet written —
production remains HOLD; **no implementation proceeds from this document
alone.**

## RATIFIED DECISIONS (2026-09-19)

| # | Decision | Ratified |
|---|---|---|
| **§1** | Commission Policy Scope | **B** — Sales Rep, Customer, and Customer Group only in Phase 1. Team, Campaign/Segment, and Global scope are explicitly NOT added in Phase 1. |
| **§2** | Precedence | **A** — Customer Override wins over Rep Policy. Full Phase 1 rank order: **Customer → Customer Group → Sales Rep**. If no active Customer policy, fall through to Customer Group, then Sales Rep. |
| **§3** | Calculation Basis | **B** — Basis is a field on each individual Commission Policy, not a global fixed setting. Phase 1 supports Gross Sales, Net Sales, and Collected Amount. |
| **§4** | Target Tier Rate Application | **B** — Marginal / per-tier calculation. Each tier's rate applies only to the portion of the eligible amount falling within that tier's band. |
| **§5** | Target Architecture | **B** — Target Management is its own independent bounded context. Commission does not own Target data. |

**Original status line (superseded by the ratification above, kept for
the record):** *"PROPOSED — CTO decision pending. Analysis only."* No
code, migration, schema, API, frontend, or commission/target calculation
was authorized by this document at the time it was written. Produced
strictly from `ADR-066` (Sales Commission & Target Management: Future
Architecture Requirements, RECORDED baseline) — no new investigation, no
new claim about the repository was made beyond what `ADR-066` already
established. `ADR-059` / HR Phase 1 (CLOSED/PASS), `ADR-064`/`ADR-067`
(Payroll study/policy), and the Attendance track (`ADR-062`/`ADR-063`/
`ADR-065`) were not reopened by this document.

This document converted `ADR-066`'s **Business Policy Decision Required**
items (§3, §4, §5, §9) plus one item `ADR-066 §2` named as a recorded
candidate list rather than an approved scope into named, bounded options
with real consequences, the same discipline `ADR-063` (Attendance) and
`ADR-067` (Payroll) already used for this program's prior CTO decision
packages. It did not choose an option or make a recommendation — the
table above is the CTO's own resolution, not an inference by this team.

**ملخص تنفيذي (ar):** تم اعتماد القرارات الخمسة (§1–§5) من قبل الـCTO.
النص الأصلي (تحليل الخيارات دون توصية) محفوظ دون تعديل كسجل تاريخي. تم
إضافة توصيف ملزم إضافي (§§A–H أدناه) يغطي: خوارزمية الـResolution
والتتبع، تعريف أسس الاحتساب (Gross/Net/Collected)، حساب الشرائح
الهامشية (Marginal Tier)، أبعاد الـTarget في Phase 1 (Employee + Period
إلزاميًا)، نموذج فترة الـTarget، لقطة الـCommission غير القابلة للتغيير،
حدود Payroll، الحوكمة، وتسلسل التنفيذ. **لا يوجد أي كود أو migration أو
schema مصرّح به بموجب هذا المستند** — الخطوة التالية فقط هي عقد تنفيذ
Commission & Target Phase 1، وهو لم يُكتب بعد.

---

## §A — Precedence & Resolution Algorithm (binding specification)

Per §2's ratified decision, the Commission Rule Resolution Engine
(preserved from `ADR-066`'s reuse direction — a dedicated resolver, never
an inline `if customerRate else repRate` chain) must resolve a commission
policy for a given transaction as follows:

1. Look for an **active, effective-dated Customer-level policy** for the
   transaction's customer. If found, it is the resolved policy — stop.
2. Otherwise, look for an **active, effective-dated Customer-Group-level
   policy** for the customer's group. If found, it is the resolved
   policy — stop.
3. Otherwise, fall through to the **Sales Rep's default policy**. This is
   the terminal fallback — Phase 1 has no scope below Sales Rep (per §1,
   Team/Campaign/Global do not exist in Phase 1, so there is no further
   fallback beyond this step).

The resolution's output must be traceable end-to-end and recorded exactly
in this shape (this is not optional formatting — it is the minimum
resolution record the Implementation Contract must specify a concrete
schema for):

```
Resolved Policy → Scope → Effective Period → Basis → Tier/Rate
```

Ambiguity within a single scope level (e.g. two overlapping active
Customer-level policies for the same customer) is not addressed by this
ratification and must be closed as an explicit rule in the Implementation
Contract — it is not inferable from the above and must not be left
implicit.

## §B — Calculation Basis Definitions (binding requirement, not yet fully specified)

Per §3, each Commission Policy carries its own basis: **Gross Sales**,
**Net Sales**, or **Collected Amount**. This ratification fixes that the
basis is a per-policy field (not a company-wide constant) and fixes the
three named bases as the Phase 1 set — it does **not** itself define the
exact accounting composition of each basis. The Implementation Contract
**must** define, explicitly and before any calculation logic is written:

- The treatment of **Discounts** within Net Sales.
- The treatment of **Returns** within Net Sales.
- The treatment of **Taxes** within both Gross and Net Sales.
- The treatment of **Credit Notes** against either basis.
- The treatment of **partial Collections** within Collected Amount (e.g.
  a partially-collected invoice's commission timing/amount).

No team member may assume or invent an accounting definition for any of
the above during implementation — each must be resolved as its own
explicit line item in the Implementation Contract, sourced from
Accounting's existing conventions where one already exists (e.g. however
Returns/Credit Notes are already recognized elsewhere in this codebase's
Accounting domain) rather than invented fresh for Commission.

## §C — Marginal Tier Calculation (binding specification)

Per §4, tier rates apply **marginally** — only to the portion of the
eligible amount within each tier's band, never to the whole amount at the
top tier reached. Worked illustration (rates and thresholds below remain
**non-authoritative examples**, exactly as `ADR-066 §5` already stipulated
— only the calculation *method* is ratified here, not any rate or
threshold):

```
0–50     → Rate A
50–70    → Rate B
70–90    → Rate C
90+      → Rate D
```

If a Sales Rep achieves 80 (using whatever achievement basis the eventual
Target definition resolves to), the calculation is:

```
0–50   at Rate A
50–70  at Rate B
70–80  at Rate C
```

Rate C does **not** apply to the entire 80 — only to the 70–80 band. The
actual tier thresholds and rates remain undecided business input, to be
supplied when the Implementation Contract (or a subsequent policy
configuration exercise) is written — this ratification fixes the
*method*, not the *numbers*.

## §D — Target Bounded Context & Phase 1 Dimensions (binding specification, closes ADR-066 §9)

Per §5, Target Management is built as its own bounded context (`targets`
or an equivalently named domain), never as Commission-owned data.
Commission's Resolution Engine (§A) consumes an **Approved Target** from
this context; it does not define, own, or mutate Target data itself. The
chain is:

```
Target Context
      ↓
Approved Target
      ↓
Commission Resolution Engine
      ↓
Commission Result
      ↓
Approval
      ↓
Payroll
      ↓
GL
```

This boundary is deliberate and closed — not open for reinterpretation —
specifically so Targets remain reusable later for sales performance
tracking, incentive programs, management dashboards, campaigns,
forecasting, or other performance programs, without redesigning
Commission (`ADR-066 §9`'s own stated rationale, now ratified as binding,
not just a named possibility).

**Phase 1 dimensions are closed as follows** (this replaces `ADR-066 §9`'s
open "final dimension list" question — it is no longer open):

- **Mandatory:** `Employee` + `Target Period`. Every Phase 1 Target is,
  at minimum, an Employee's target value for a defined period. No Target
  exists without both.
- **Supported organizational context (not a separate engine):** a Target
  may additionally be linked to the Employee's Team/Department, when
  available from the existing Organization structure (`OrgUnit`, per
  `ADR-059` D1) — but this is contextual metadata on an Employee-level
  Target, not a standalone Team-based target engine. Phase 1 does not
  support setting one target value for an entire team and deriving
  individual employee targets from it.
- **Explicitly deferred (not rejected — named as future capability,
  exactly as `ADR-066 §9` itself already framed the full candidate
  list):** Region, Customer Group Target, Product Category Target,
  Campaign Target, Territory Target, and any multi-dimensional target
  matrix combining more than one of these. None of these are built,
  stubbed, or partially modeled in Phase 1.

## §E — Target Period Model (binding specification)

Every Phase 1 Target carries, at minimum:

```
Target Period
→ Start Date
→ End Date
→ Status
→ Employee
→ Target Value
→ Approval State
```

Targets are effective-dated in the same discipline `CustomerAssignment`
already established (`ADR-066 §0`/§7) — a new row per change, never a
mutated single row. **No two Targets may overlap for the same Employee,
in the same period, at the same dimension, without an explicit rule
preventing that ambiguity.** This ratification fixes the requirement that
such a rule must exist; the exact mechanism (a DB-level uniqueness/
exclusion constraint, an application-level check, or both) is
Implementation Contract detail, not decided here.

## §F — Commission Snapshot (binding specification, closes ADR-066 §7 field list)

Per the reuse direction already preserved from `ADR-066 §7` (immutable
snapshot, never recalculated when policy changes later), every calculated
Commission Result must retain, at minimum, all of the following fields —
this is now the closed, binding field list, not just a category
description:

```
Employee / Sales Rep
Customer
Customer Group
Sale / Invoice / Collection references
Resolved Policy
Policy Scope
Calculation Basis
Target Period
Target Snapshot
Applicable Tier
Rate
Calculation Inputs
Calculated Amount
Calculation Timestamp
```

Once written, a Commission Result is immutable. If the underlying policy
changes afterward, this snapshot — not the live policy — remains the
permanent record of what was actually calculated and why.

## §G — Payroll Boundary (binding, restates and closes ADR-066 §8 for this context)

Payroll never recomputes a commission from Sales data. The boundary is:

```
Sales
 ↓
Invoice / Collection
 ↓
Commission Resolution
 ↓
Commission Result
 ↓
Commission Approval
 ↓
Payroll
```

Payroll consumes an **Approved Commission Result/Statement** only. It does
not independently re-derive Sales, Customer, Rate, Target, or Commission
Basis from source data — exactly as `ADR-064 §8`/`ADR-067` already
established for Payroll's consumption of Attendance facts, applied here
to Commission instead. This is the same boundary shape `ADR-066 §8`
already proposed; it is now ratified as binding, not merely proposed.

**Sales Rep identity remains unchanged and closed** — no new Sales Rep
identity is created. The existing path is reaffirmed as the permanent
model:

```
CustomerAssignment.salesRepUserId
        ↓
User
        ↓
Employee.userId
```

Sales Rep is a role an `Employee` plays, never a second, parallel
identity record (`ADR-066 §1`, now ratified as closed, not merely
carried-forward reuse direction).

## §H — Governance, Corrections, and Implementation Sequence

**Governance (binding):** Commission policy changes, Target approvals, and
Commission approval remain subject to: the existing permission model;
FA-01 (`ApprovalEngineService`) wherever an approval gate applies;
`AuditService` for every mutation; effective-dating for every policy and
Target; and the immutable calculation/result snapshot (§F). **A ratified
Commission Result may never be directly mutated.** Any correction must be
a controlled adjustment/recalculation flow that produces a new, separately
traceable record — never an overwrite of an existing result.

**Implementation sequence (CTO-directed roadmap, recorded here for
traceability — steps beyond Step 1 are NOT authorized by this document):**

1. Finalize this document (ADR-068) as RATIFIED — **this step**.
2. Write the Commission & Target Phase 1 Implementation Contract.
3. Review that contract against HR, Sales, `CustomerAssignment`, Sales
   Orders, Invoices, Collections, Accounting, Attendance, and Payroll.
4. Complete the Payroll Policy Decision Package (`ADR-067`) with the same
   rigor as this document.
5. Produce the Payroll Phase 1 Implementation Contract.
6. Only once both Implementation Contracts (Commission & Target, and
   Payroll) exist and are approved: Implementation → Testing →
   Verification → Delivery, as one coordinated package.

**Explicitly prohibited at this stage (documentation-only phase):** no
Commission code; no Target code; no Payroll code; no database migration;
no default/placeholder commission rates; no invented tax or social
insurance rules; no unapproved overtime or holiday rules; no modification
to HR or Sales to force-fit this design; no production deployment.

## Dependency & Conflict Review

- **`ADR-059` (HR Phase 1, CLOSED/PASS):** not reopened. §D/§G's Employee/
  Sales Rep model reads `Employee.userId` exactly as already ratified
  there (D2) — no change to HR's own aggregate.
- **`ADR-062`/`ADR-063`/`ADR-065` (Attendance):** not reopened, not
  referenced by any decision above except as a precedent for the
  facts-only Payroll-boundary shape (§G), which does not alter
  Attendance's own contract.
- **`ADR-064`/`ADR-067` (Payroll study/policy):** unmodified. §G's Payroll
  boundary is consistent with, not a change to, `ADR-064 §8`'s
  already-established "Payroll consumes an approved result, never
  reconstructs a calculation" principle — this ratification applies the
  same principle to Commission, it does not alter Payroll's own open
  policy items in `ADR-067`, which remain separately pending.
  `ADR-067`'s own Step 4 (completing the Payroll Policy Decision Package)
  is a distinct, not-yet-executed deliverable per §H above.
- **`ADR-066` (Commission/Target backlog):** this document is the direct
  ratification of `ADR-066`'s deferred Business Policy Decision Required
  items (§3, §4, §5, §9) plus its §2 scope question and §7 snapshot field
  list — fully consistent with, and closing, those open items. No
  conflict found.
- **No other ADR in this program references Commission, Target, or
  Sales Rep identity** in a way that conflicts with §§A–H above.

---

## Reading guide — how each section is structured

Per the discipline `ADR-063`/`ADR-067` established, every section below
strictly separates three kinds of statement:

- **Verified Repository Fact** — established in `ADR-066` by direct
  inspection. Nothing new is asserted here.
- **Proposed Option** — a bounded, named choice with its real consequence
  and cost/effort. Naming an option is not recommending it.
- **Business Policy Decision Required** — the literal question the CTO
  must answer. Nothing here defaults, infers, or silently picks an option.

## Reuse direction preserved from ADR-066 (unchanged, not re-litigated)

None of the five decisions below reopen or alter these points — they are
carried forward from `ADR-066` as fixed design direction, regardless of
which options are chosen:

1. **`commission` is its own bounded context**, separate from `hr`,
   `attendance`, and `payroll` — no option below proposes merging it into
   an existing domain.
2. **A dedicated Commission Rule Resolution Engine**, not an
   `if customerRate else repRate` chain in application code, is the only
   acceptable resolution mechanism — no option below proposes inline
   conditional logic as the actual resolver, regardless of how simple the
   ratified precedence rule (§2 below) turns out to be.
3. **`CustomerAssignment`'s effective-dating pattern** (new row per
   change, `startDate`/`endDate`, never mutated in place) is the model any
   option below's effective-dated policy must follow — no option proposes
   a single mutable policy row.
4. **FA-01 (`ApprovalEngineService`) and `AuditService`** are the only
   approval and audit mechanisms any option below may invoke.
5. **Payroll consumes an approved Commission Result/Statement only**,
   never reconstructing a sales calculation itself (`ADR-066 §8`, mirrors
   `ADR-064 §8`'s Attendance boundary exactly). No option below proposes
   Payroll computing commission directly.
6. **Every commission result is an immutable snapshot** (applied policy,
   applied rate, calculation basis, eligible amount, target/achievement,
   source transactions, final amount) — a policy change must never
   retroactively alter an already-calculated result (`ADR-066 §7`). No
   option below proposes recalculating historical results when a policy
   changes.
7. **"Sales Rep" is a role an `Employee` plays, never a second identity**
   (`ADR-066 §1`). The existing resolution path —
   `CustomerAssignment.salesRepUserId` → `User` ← `Employee.userId` — is a
   verified, already-available path, not something any option below needs
   to invent; how a future design formally walks that path is
   implementation detail for the eventual contract, not a policy question
   this package needs to resolve.

---

## 1. Commission Policy Scope — Which Dimensions Are In Phase 1

**Verified Repository Fact:** `ADR-066 §2` names candidate policy scopes
— company/global default, sales team/group, sales representative,
customer, customer group/category, campaign/segment — explicitly as
"named possibilities, not an approved list." No scope beyond "some
configurable policy exists" is decided anywhere in `ADR-066`.

### Option A — Two scopes only: Rep default and Customer override

Matches exactly the minimal chain `ADR-066 §3` describes as the *Future
Requirement* baseline: every Sales Rep has a default rate/policy; a
`CustomerAssignment` may optionally activate a customer-specific override.
No team, customer-group, or campaign scope exists in Phase 1.

- **Consequence:** Smallest possible Commission Phase 1 — a working
  Resolution Engine (per the preserved reuse direction above) with only
  two ranks to resolve between. Cannot represent a team-wide rate change
  or a campaign-driven promotional rate without a later phase.

### Option B — Rep, Customer, and Customer Group

Adds a third scope: a policy attached to a customer group/category, which
must rank somewhere between the Rep default and an active Customer
override (the exact ranking is §2 below's question, not this one's).

- **Consequence:** Closer to real-world sales-org structures where pricing/
  incentive policy is often set per customer segment. Adds one more rank
  the Resolution Engine (and §2's precedence decision) must account for
  from day one, and requires a Customer Group concept to already exist or
  be introduced alongside Commission — worth confirming against whatever
  customer-grouping concept (if any) already exists elsewhere in the CRM/
  Sales domain before choosing this option.

### Option C — All named candidate scopes (Rep, Customer, Customer Group,
Team, Campaign/Segment, Global)

Every scope `ADR-066 §2` names is built in Phase 1.

- **Consequence:** Most complete, but the largest Phase 1 scope by a wide
  margin — the Resolution Engine's precedence question (§2 below) becomes
  substantially harder to answer completely and correctly across six
  ranks at once, and several of these scopes (Team, Campaign/Segment) have
  no existing concept anywhere in this codebase to build on, unlike
  Customer (which already exists) or Customer Group (partial, per Option
  B's note).

**Business Policy Decision Required:** Which policy scopes are actually
built in Commission Phase 1 — the minimal two (A), three including
Customer Group (B), or the full named list (C)?

**Dependency note:** Whatever is chosen here directly sets how many ranks
§2 (precedence hierarchy) below must define. Choosing Option A here makes
§2 a two-rank question; Option C makes it a six-rank question.

---

## 2. Commission Policy Precedence Hierarchy

**Verified Repository Fact:** `ADR-066 §3` states the Future Requirement
precisely: a Rep default exists; an active Customer override "*can* take
precedence" — but `ADR-066 §3` is explicit that "the exact precedence
hierarchy... is explicitly NOT decided" by that document. This is the
single decision `ADR-066` most directly flags as unresolved.

### Option A — Strict override: Customer override always wins when active

If a `CustomerAssignment` has an active Customer Commission Override, it
is used, full stop, regardless of any Rep, Team, or Customer Group policy
that might otherwise apply. The Rep default applies only when no override
is active.

- **Consequence:** Simplest rule to state, implement, and audit — "most
  specific wins" reduced to a single binary check per customer. Does not
  by itself define where a Customer Group policy (if §1 chose Option B/C)
  ranks relative to a Rep default when *no* Customer override is active —
  this option only resolves the Rep-vs-Customer question `ADR-066 §3`
  posed, not the fuller multi-scope ranking §1 may require.

### Option B — Full specificity ranking across every scope chosen in §1

A defined total order (e.g. Customer > Customer Group > Team > Rep >
Global) resolves precedence across every scope §1 selected, with the most
specific active policy always winning.

- **Consequence:** Answers the complete question, not just the Rep-vs-
  Customer case — necessary if §1 chose Option B or C. Requires the CTO to
  fix the *entire* rank order explicitly, not just the two-scope case
  `ADR-066 §3` illustrated; a rank order left partially undefined (e.g.
  "where does Team rank against Customer Group?") would leave the
  Resolution Engine unable to resolve a real conflict between those two
  scopes.

### Option C — Priority is an explicit, per-policy-row field (not a fixed rank by scope type)

Instead of a fixed hierarchy by scope *type*, each individual policy row
carries its own numeric priority; the Resolution Engine picks the
highest-priority active, effective-dated policy that matches, regardless
of what scope type it belongs to.

- **Consequence:** Most flexible — allows a business to make one specific
  Team policy outrank a specific Customer policy in an exceptional case,
  without redefining the whole hierarchy. Pushes the actual ranking
  decision from a one-time CTO policy choice onto whoever configures each
  policy row later, which is a materially different governance model (ongoing
  operational judgment vs. a fixed rule) and needs its own conflict-
  resolution rule for what happens if two active policies share the same
  priority value.

**Business Policy Decision Required:** Is precedence a strict Customer-
override-always-wins rule (A), a full fixed specificity ranking across
every scope §1 selected (B), or an explicit per-row priority field with no
fixed type-based hierarchy (C)? If B, what is the exact rank order? If C,
what breaks a tie between two equal-priority active policies?

---

## 3. Commission Calculation Basis

**Verified Repository Fact:** `ADR-066 §4` states the engine must support
"at minimum: Gross Sales, Net Sales, Collected Amount" as configurable
bases, and is explicit that "which basis is a company's actual policy,
whether it varies by policy scope, and the precise definition of 'Net'
(net of what — returns? discounts? tax?) are not decided or assumed here."

### Option A — One fixed basis, company-wide

Every commission policy, regardless of scope (§1), calculates against the
same single basis (e.g. always Collected Amount).

- **Consequence:** Simplest possible resolution — no per-policy basis
  field needed at all, only a single company-wide setting. Cannot express
  a business need to pay, say, a promotional campaign's commission on
  Gross Sales while paying standard Rep commission on Collected Amount.

### Option B — Basis is a field on each individual policy

Each policy row (Rep default, Customer override, etc.) independently
specifies its own basis; different policies may legitimately use
different bases.

- **Consequence:** Matches `ADR-066 §4`'s own framing most directly
  ("whether it varies by policy scope" is treated there as an open
  question, implying variation is anticipated as plausible). Requires the
  Resolution Engine's snapshot (`ADR-066 §7`, preserved above) to record
  which basis was actually used per result — already required regardless,
  so this is not additional new mechanism, just confirms the field lives
  on the policy rather than globally.

**Business Policy Decision Required:** Is calculation basis one fixed,
company-wide value (A), or configurable per policy (B)? Either way: what
is the company's actual basis/bases (Gross Sales, Net Sales, or Collected
Amount), and — if Net Sales is used anywhere — what is "Net" net of
(returns? discounts? tax)?

---

## 4. Target-Tier Commission Rate Application Model

**Verified Repository Fact:** `ADR-066 §5` records target-driven,
achievement-tiered commission as a Future Requirement, explicitly stating
the illustrative tiers given in the original request
(`<50%→A, 50–<70%→B, 70–<90%→C, ≥90%→D`) are "**not approved company
policy**" and must not be treated as a default. `ADR-066 §5` names the
tier-application question as its own, separately flagged, explicitly
deferred decision — distinct from the thresholds/rates themselves.

### Option A — Full-amount tier application

Once an achievement percentage lands in a tier, that tier's rate applies
to the **entire** eligible amount for the period.

- **Consequence:** Simplest to compute and explain. Produces a "cliff-
  edge" effect — crossing a tier boundary by a small margin changes the
  rate on the *entire* period's eligible amount, which can create a large
  jump in commission for a marginal difference in achievement, a real and
  common objection to this model in practice.

### Option B — Per-tier (marginal) application

Each tier's rate applies only to the portion of the eligible amount that
falls within that tier's range — analogous to progressive tax brackets.

- **Consequence:** No cliff-edge effect; commission increases smoothly as
  achievement rises. Requires the calculation to track how much of the
  eligible amount falls into each tier band, a materially more complex
  computation than Option A, and requires an explicit rule for how a
  "percentage of target achieved" tier maps onto "portions of a currency
  amount" — not a trivial restatement of the same tiers.

### Option C — Incremental/bonus model

A base rate applies to the eligible amount up to target; additional
tiers apply only as a bonus rate on the amount *above* a threshold (e.g.
above 100% of target), rather than tiering the entire sub-100% range.

- **Consequence:** Matches a common "quota + accelerator" incentive
  design. Is the most different in shape from the illustrative example in
  the original request (which described four tiers spanning 0–100%+, not
  a base-plus-accelerator structure) — choosing this option means the
  illustrative tiers are not just unapproved rates but not even the right
  *shape* of model, which is worth the CTO confirming explicitly rather
  than assuming continuity with the example.

**Business Policy Decision Required:** When an achievement tier is
reached, does its rate apply to the entire eligible amount (A), only the
amount within that tier band (B), or is the model an incremental/bonus
structure on top of a base rate (C)? Whichever is chosen, what are the
actual tier thresholds and rates — the illustrative figures in the
original request are not usable as a default.

---

## 5. Target Management — Scope, Ownership, and Dimensions

**Verified Repository Fact:** No Sales Target, quota, or achievement-
tracking concept exists anywhere in this codebase (`ADR-066 §0`).
`ADR-066 §9` records Targets as their own future domain — "not a field
living inside Commission" — with candidate dimensions (Employee, Team,
Period, Region, Customer Group, Product Category) named but explicitly
not approved, and ownership left open ("commission's own module vs. a
shared/foundational target concept").

### Option A — Target Management is a sub-concept owned by Commission

Targets exist only to support Commission's own tier calculation (§4);
they are modeled and stored within the `commission` bounded context, not
as an independently addressable domain.

- **Consequence:** Smallest scope — one bounded context instead of two.
  Contradicts `ADR-066 §9`'s own stated reasoning that "targets plausibly
  outlive and get referenced by more than commission alone (e.g., a sales
  dashboard, a performance review)" — choosing this option accepts that
  limitation explicitly rather than by default.

### Option B — Target Management is its own bounded context, consumed by Commission

A dedicated `targets` (or similarly named) domain owns Target definitions,
periods, and achievement tracking; Commission's tier calculation reads
approved Target/achievement data from it rather than owning it, the same
shape of relationship Commission itself has to Sales/Accounting per
`ADR-066 §8`'s boundary.

- **Consequence:** Matches `ADR-066 §9`'s own stated rationale most
  directly and leaves room for other future consumers (a dashboard,
  performance reviews) without redesign. Is a second new bounded context
  to design and build in the same phase as Commission itself, a larger
  total scope than Option A.

**Business Policy Decision Required:** Does Target Management get built as
its own bounded context (B), or as a narrower sub-concept living inside
Commission (A)? Either way: which dimensions are in Phase 1 — the full
candidate list (Employee, Team, Period, Region, Customer Group, Product
Category), or a smaller starting subset, and if smaller, which ones?

**Dependency note:** This decision does not block §1–§4 above — a
Commission Phase 1 without target-tiered commission at all is a coherent,
separately valid scope-narrowing choice (effectively deferring `ADR-066
§5` and this section together), though that narrower scope is itself not
decided by this document and would need its own explicit confirmation if
that is the intended reading.

---

## Dependencies between decisions (summary)

- **§1 (policy scope)** directly sets how many ranks **§2 (precedence)**
  must resolve — Option A/B/C in §1 correspond in scope to Option A/B in
  §2's own escalating complexity, though the two are formally independent
  choices.
- **§3 (calculation basis)** is independent of §1/§2/§4 — a business can
  fix its basis decision without first resolving precedence or tiering.
- **§4 (tier application)** and **§5 (target ownership/dimensions)** are
  jointly the target-driven-commission feature — resolving §4 without §5
  (or vice versa) leaves the feature only partially specified; a decision
  to defer target-driven commission entirely effectively defers both
  together.
- **§2's** eventual precedence rule and **§4's** eventual tier-application
  rule are independent of each other — a policy's rank in the hierarchy
  and how its own tiers apply once selected are two separate questions.

## What this document does not do

- It does not choose an option in any of the five sections above.
- It does not authorize any code, migration, schema, API, frontend, or
  calculation.
- It does not treat `ADR-066` as superseded — it remains the factual
  baseline this decision package is built strictly from.
- It does not reopen or alter `ADR-059` (HR Phase 1), the Attendance track
  (`ADR-062`/`ADR-063`/`ADR-065`), or the Payroll study/policy
  (`ADR-064`/`ADR-067`) in any way.
- It does not assume any specific commission rate, target threshold, or
  precedence outcome — every illustrative figure named anywhere in
  `ADR-066` or repeated here remains explicitly non-authoritative.

## Next step

Once decisions are issued for §1–§5 above, the next and only next
deliverable is the **Commission & Target Phase 1 Implementation
Contract**, built strictly from those ratified decisions plus `ADR-066`'s
verified findings — and that contract will itself stop for approval
before any implementation begins, exactly as `ADR-061`/`ADR-065`
preceded their respective implementations and `ADR-067`'s eventual
contract will precede Payroll's. Per the brief's own execution model,
Commission/Target policy work may proceed in parallel with `ADR-067`'s
Payroll policy work — neither is blocked on the other's ratification,
though both eventually feed the same Payroll Earning → GL boundary
(`ADR-066 §8`). No implementation, migration, schema, API, frontend, or
calculation work is proposed as following automatically from this
document or from the eventual contract's mere existence. Production
remains HOLD.
