# ADR-060 — Manufacturing Costing & Integration Boundary: CTO Decision Package

**Status: RATIFIED (2026-09-19).** All five decisions below (D1–D5) have
been resolved by the CTO. This document's original options-analysis body
(§1–§7) is kept intact, unmodified, as the historical record of what was
weighed and why — the ratification is recorded here as a dedicated section
(§8, immediately below) rather than by editing the options text itself, the
same "supersede via new content, never rewrite the analysis" discipline
`ADR-052` used. **These five decisions are now closed and are not to be
reopened or reinterpreted** except through the same escalation categories
`ADR-053 §16` already defines. The final Manufacturing Implementation
Contract derived from these decisions is `ADR-061-manufacturing-
production-implementation-contract.md`. Production remains HOLD; no code,
migration, permission, or UI change is authorized by this ratification
alone — implementation begins only after `ADR-061` is itself separately
reviewed and approved.

---

## 8. RATIFIED DECISIONS (2026-09-19)

| # | Decision | Ratified | Meaning |
|---|---|---|---|
| **D1** | Production Costing | **§1 Option A — Actual Cost** | Phase 1 production costing extends the existing Moving Average engine. No standard-cost concept is introduced. |
| **D2** | Labor & Overhead | **§2 Option A — Material only** | Phase 1 production valuation = material cost only. Labor/overhead absorption is explicitly deferred — no labor rates, machine rates, overhead pools, or allocation rules are to be invented. |
| **D3** | Variance | **§3 — N/A for Phase 1** (consistent with D1) | No Standard Cost / variance accounting in Phase 1 — no variance accounts, variance events, or variance workflows. |
| **D4** | WIP Valuation | **§4 Option A — Continuous** | WIP is valued continuously, at each production movement event, through the controlled production/inventory flow (not a period-end-only computation). |
| **D5** | Legacy `assembleProduct` | **§5 Option B — Retrofit required** | The existing `assembleProduct` path must be brought through the controlled Inventory/Financial integration path (`recordMovement`) — it must not remain an uncontrolled production mutation that changes stock without the required financial integration. **The remediation is defined in `ADR-061`; it is not implemented by this ratification.** |

**Original status line (superseded by the ratification above, kept for
the record):** *"PROPOSED — CTO decision pending. Analysis only. No code,
migration, permission, or UI change is authorized by this document, and
none is proposed as imminent."* — produced per the CTO's explicit direction
after reviewing `MANUFACTURING_PRODUCTION_ARCHITECTURE_STUDY.md` (Phase 0):
that study was accepted as an architecture study and gap inventory only,
its §23 draft contract remained DRAFT/NOT RATIFIED, and Manufacturing
implementation was explicitly not authorized at that time. This document
existed solely to lay out the five points requiring explicit resolution
before a Phase 1 contract could be written, each as named options with
consequences, not a recommendation — the same discipline `ADR-052`'s own
GRNI decision package used.

**ملخص تنفيذي (ar):** هذه حزمة قرار للـCTO فقط — بدون أي تنفيذ وبدون أي
توصية ملزمة. تعرض خمس نقاط، كل واحدة بخيارات صريحة ونتائجها: (1) التكلفة
المعيارية أم الفعلية، (2) استيعاب الأجور والتكاليف غير المباشرة، (3)
معالجة الانحرافات، (4) توقيت تقييم WIP، (5) حدود التكامل المحاسبي/المخزني
لعقد Phase 1 (لأن `assembleProduct` الحالي يتجاوز القناة المعتادة تمامًا،
كما وثّقت دراسة Phase 0). لا شيء هنا يقرر أي خيار. بمجرد أن يُصدر الـCTO
قراره في كل نقطة، تُكتب مسودة عقد التنفيذ النهائي (Phase 1 ADR) استنادًا
إلى هذه القرارات — وليس قبل ذلك.

---

## 0. Why this document does not recommend

Per the CTO's own stated concern — *"I don't want to repeat the mistake of
Study → Implementation automatically"* — this document is deliberately
structured the same way `ADR-052` (GRNI) was: it presents verified current-
state facts and named options with their real consequences, and stops.
`ADR-052` itself proved the value of this discipline — the CTO's eventual
decision (Option B, GRNI) came with a fully-informed view of the
consequences on both sides, and the team executing it (`ADR-054`/`057`)
never had to guess what "GRNI" meant in practice. The same standard applies
here across five points, four of which are pure accounting/costing policy
and one of which is an architecture-integration decision with policy
implications.

---

## 1. Standard Cost vs. Actual Cost

**Current state (VERIFIED, from Phase 0 §14):** Inventory valuation in this
codebase is Moving Average (F08) — a received-cost-in, weighted-average-out
engine. It has never derived a cost from a bill of materials; nothing has
ever asked it to. No standard-cost field, no cost-revision mechanism, and no
variance-calculation logic exists anywhere today.

### Option A — Actual costing (extend Moving Average)

A finished good's cost at production time = the live moving-average cost of
each consumed component, rolled up per the BOM's `quantityPerUnit`
(+ whatever §2 decides about labor/overhead). No new costing *method* is
introduced — the existing engine is asked a new question (derive a cost
from a recipe) rather than replaced or supplemented by a second one.

- **Consequence:** Simplest to build; zero new costing concepts; consistent
  with "reuse before creating new infrastructure" (`ADR-055 §10`). Finished-
  goods cost will fluctuate between production runs as component costs
  drift (normal moving-average behavior, already true for every other
  product in this system). No variance to report by construction — there is
  no "standard" to deviate from, so §3 (variance recognition) becomes moot
  under this option.
- **Cost/effort:** Low — a cost-roll-up computation over existing
  `getAvailableInTransaction`-style cost reads, no new schema for cost
  itself (though WIP/consumption tracking, §4, is still needed regardless
  of which costing method is chosen).

### Option B — Standard costing with variance

Each product (or BOM) carries a predetermined standard cost, set/revised
through its own workflow. Production consumes/produces at standard; the
difference between standard and actual (moving-average) component cost at
consumption time is captured as a variance (§3 decides where it posts).

- **Consequence:** Enables true manufacturing variance analysis (materials
  price/usage variance at minimum) — valuable for cost control in a
  business with meaningful production volume, and closer to how mid-size
  manufacturing ERPs typically work. Genuinely new to this codebase: a
  standard-cost field/table, a cost-revision workflow (itself probably
  needing an approval gate — a standard cost change affects every future
  production run's variance baseline), and variance-calculation logic with
  nowhere to reuse from.
- **Cost/effort:** Materially higher — new data model, new UI (managing
  standards), new permission nodes for cost-standard maintenance
  (a sensitive, finance-adjacent action), and the variance question (§3)
  only exists at all under this option.

### Option C — Hybrid (standard for WIP/production, reconciled to actual)

Standard cost values Work Orders as they progress; a period-end (or
completion-time) true-up reconciles to actual moving-average cost, with the
difference posted as variance. Common in mature manufacturing ERPs.

- **Consequence:** Most accurate and most auditable, but also the most
  complex option by a wide margin — combines Option B's full build with an
  additional reconciliation step that has no existing precedent to reuse
  (GRNI's reconciliation, cited for contrast, reused *existing*
  `PurchaseOrderLine` columns; there is no equivalent "in-flight Work Order"
  column set to reuse here since Work Orders don't exist yet — this would be
  new state tracked from zero).

---

## 2. Labor & Overhead Absorption

**Current state (VERIFIED, from Phase 0 §14):** No labor-hour tracking
exists anywhere in this codebase today (HR Phase 0 — a separate, parallel
workstream — may eventually introduce attendance/timesheet concepts per the
Wave 2/3 roadmap in `ADR-053`, but nothing in that direction exists yet and
this decision should not assume or depend on it landing on any particular
schedule). No overhead-rate concept exists anywhere.

### Option A — Material-only roll-up (no labor/overhead)

Finished-goods cost = Σ (component cost × quantity per unit) only, per the
BOM. No labor or overhead component.

- **Consequence:** Matches this codebase's existing "don't over-engineer
  V1" precedent (the same spirit as `BillOfMaterial`'s own deliberate
  no-versioning V1 simplicity, and `Product.unit`'s deliberate non-UoM-
  engine simplicity, both cited in Phase 0). Understates true production
  cost for any business where labor/overhead is a material share of
  finished-goods value — the size of that understatement is a real-world,
  business-specific fact this document cannot assess.
- **Cost/effort:** None beyond whatever §1 already requires — no new inputs
  needed.

### Option B — Labor + overhead absorption

Finished-goods cost includes an allocated labor and/or overhead component,
sourced from some rate/basis (per labor hour, per machine hour, percentage
of material cost, or a fixed per-unit overhead — the specific basis is
itself a sub-decision not resolved here).

- **Consequence:** More accurate, GAAP/IFRS-consistent full-absorption
  costing. Requires genuinely new inputs this codebase has no source for
  today: either labor-hour capture (which would most naturally depend on
  Work Order operations/routing — Phase 0 §4, itself MISSING — and
  potentially on HR/Payroll timesheet data, Wave 2/3, not yet built) or a
  simpler proxy rate the CTO would need to specify directly (e.g. "overhead
  = 15% of material cost") as a configuration value with no operational
  data behind it.
- **Cost/effort:** High if tied to real labor/routing data (depends on
  Manufacturing's own Routing/Work-Center build, §4, and possibly on HR's
  timeline); moderate if a simple configured rate/percentage is accepted
  instead as a disclosed simplification.

---

## 3. Variance Recognition and Treatment

**Applicability:** Only relevant if §1 selects Option B or C (standard
costing in some form). Under §1 Option A (pure actual costing), there is no
variance to recognize by construction, and this section is moot.

### Option A — Immediate P&L recognition

Variance posts to a dedicated Production Variance account (a new P&L
account, requiring its own control function or configured-account entry —
same mechanism `grni`'s addition used in Wave 1, `ADR-054`, cited read-only)
at the moment it is known (e.g. at finished-goods receipt, or at Work Order
completion).

- **Consequence:** Simple, visible, matches how most of this codebase
  already recognizes financial consequences as they occur (Wave 1's own
  "systemPosting, non-discretionary" precedent for GL entries that are
  automatic consequences of an already-authorized action).

### Option B — Deferred / period-end recognition

Variance accumulates in a clearing account and is only recognized/allocated
at Month-End.

- **Consequence:** Ties variance recognition to §4's WIP-valuation-timing
  decision and to Month-End Closing (`ADR-051`/`056`, cited read-only) —
  would most likely become a new, Phase-9-style additive extension to the
  existing Month-End contract, mirroring exactly how GRNI reconciliation
  became Phase 8 rather than a parallel closing mechanism. More complex to
  build than Option A, but keeps interim (mid-period) reporting simpler by
  deferring the noise of small variances until close.

### Option C — Absorbed into COGS, no separate account

Variance is folded directly into Cost of Goods Sold with no dedicated
account or line-item visibility.

- **Consequence:** Lowest build effort of the three, but least useful for
  actual cost-control analysis — defeats much of standard costing's own
  purpose (visibility into where actual diverged from plan). Worth naming
  as an option for completeness, not because it is architecturally
  attractive if §1 already chose standard costing specifically to gain
  variance visibility.

---

## 4. WIP Valuation Timing

**Current state (VERIFIED, from Phase 0 §7):** WIP does not exist as a
concept anywhere in this codebase. `assembleProduct` has no time gap between
consumption and output — there is no intermediate state to value, because
none currently exists. Any answer here is a genuinely new capability, not
an extension of something partial.

### Option A — Continuous (real-time WIP balance)

WIP is tracked as an always-current running balance — components consumed
but not yet realized as finished-goods output are valued and visible at any
moment.

- **Consequence:** Accurate balance sheet at any point in time; supports
  mid-period reporting and dashboards. Requires a genuinely new subledger-
  style tracking mechanism this codebase has zero precedent for — unlike
  GRNI, which reused existing `PurchaseOrderLine.quantityReceived/
  quantityInvoiced` columns (Wave 1, `ADR-057 §0`, cited read-only), there
  is no equivalent "partially-completed Work Order" state to reuse, because
  Work Orders themselves do not exist yet (Phase 0 §5). This option is
  effectively "design a new subledger from scratch," not "bind an existing
  dormant contract" the way Wave 1's GRNI reconciliation was.

### Option B — Period-end only (Month-End-time computation)

WIP is computed only when Month-End Closing runs, as a new (seventh, if
GRNI's addition in Wave 1 is counted as the sixth) `ClosingAuditService`
reconciliation type — mirroring the GRNI-as-Phase-8 precedent exactly
(`ADR-056`, cited read-only).

- **Consequence:** Simpler to build initially — no continuous tracking
  needed, only an as-of-period-end snapshot computation. No real-time WIP
  visibility between closes. A Work Order that spans a period boundary
  needs its own defined snapshot/reconciliation mechanism at close time,
  comparable in kind (not necessarily in size) to the Closing Snapshot
  mechanism Month-End already has (`ADR-051`, cited read-only) — a new
  application of an existing pattern, not a wholly new one.

---

## 5. Accounting/Inventory Integration Boundary (Phase 1 Contract Requirement)

This is not one of the four costing questions, but the CTO explicitly
directed that the Phase 1 contract must resolve it, because Phase 0 §6/§11
identified that the **existing** `assembleProduct` primitive bypasses
`InventoryService.recordMovement` — the single funnel every other stock-
affecting operation in this codebase goes through, and the only place F08
valuation and GL Financial Event publishing are hooked. Whatever
Manufacturing builds must not repeat this bypass, and the CTO must decide
how the *existing* bypass itself is treated.

### Option A — New Work Order path only; legacy `assembleProduct` untouched

Manufacturing's new material-consumption/finished-goods-output movements
route through `recordMovement` from their first line of code. The existing
`assembleProduct` (Gap G-2, Sales/Inventory-scoped) is left exactly as it is
today — a disclosed, separate, legacy capability that still bypasses the
funnel, unrelated to and not fixed by the new Manufacturing module.

- **Consequence:** Cleanest scoping — Manufacturing's own new code is
  correct from day one, and nothing about the existing (already-shipped,
  already-entitlement-gated-off-by-default per Phase 0 §17) assembly
  primitive is disturbed. Leaves a known, disclosed inconsistency in the
  codebase indefinitely (two ways to "assemble," one integrated, one not) —
  acceptable only if that is an explicit, disclosed decision, not an
  oversight.

### Option B — Retrofit `assembleProduct` to use `recordMovement` first, as a prerequisite

Before or alongside Phase 1, `assembleProduct` itself is changed to call
`recordMovement` instead of writing `stock_movements` directly — closing the
existing gap regardless of whether the broader Work Order system is built
yet.

- **Consequence:** Removes the inconsistency Option A would leave in place;
  a small, self-contained, low-risk fix in isolation (no schema change, no
  new entity — purely routing an existing write through an existing
  funnel). But it is itself a real behavior change to a shipped capability:
  once fixed, assembly movements would, for the first time, become eligible
  for F08 valuation and (if `assembly_consumption`/`assembly_output` are
  ever added to `INVENTORY_GL_MOVEMENT_TYPES`, a separate decision, see
  Option C below) GL posting — this needs its own explicit sign-off the same
  way any behavior change to shipped code does, not a silent "obviously
  fine" bundled into the larger Manufacturing decision.

### Option C — Explicit decision on `INVENTORY_GL_MOVEMENT_TYPES` membership for every new/fixed movement type

Independent of A vs. B above: `INVENTORY_GL_MOVEMENT_TYPES` today contains
only `'dispatch'` — every other movement type, including `assembly_
consumption`/`assembly_output` and whatever new Work Order movement types
Phase 1 introduces, is **silently excluded from GL posting by default**
(Phase 0 §11, `inventory.service.ts`'s own doc comment: *"extending this set
is a later decision, not something to change silently"*). The Phase 1
contract must therefore explicitly state, for each new movement type it
introduces, whether it joins this set — this is not automatic, and getting
it wrong in either direction (a movement that should post to GL silently
not doing so, or a movement posting to GL when the costing/variance policy
above hasn't actually decided what account it should hit) is exactly the
class of gap `ADR-052`/`054` exists to prevent recurring.

**This option is not mutually exclusive with A or B — it is a required
disclosure regardless of which of A/B is chosen**, because it applies both
to any legacy fix (B) and to every genuinely new Manufacturing movement type
(A).

---

## 6. What this document does not do

- It does not choose an option in any of the five sections above.
- It does not authorize any code, migration, permission, or UI change.
- It does not treat Phase 0's study as superseded — Phase 0 remains the
  factual baseline this decision package is built on.
- It does not assume a timeline or dependency on HR/Payroll (Wave 2/3)
  landing before Manufacturing's labor-absorption question (§2) is decided —
  that dependency, if any, is itself part of what §2's chosen option
  implies, not a precondition asserted here.

## 7. Next step

Per the CTO's explicit instruction: once decisions are issued for §1–§5
above, the next and only next deliverable is the **final Manufacturing
Implementation Contract / ADR**, built strictly from those ratified
decisions plus the Phase 0 study's verified findings — and that document
will itself stop for approval before any implementation begins, exactly as
Wave 1's implementation contracts (`ADR-054`, `057`) did. No implementation,
migration, or UI work is proposed as following automatically from this
document or from the eventual Phase 1 contract's mere existence.
