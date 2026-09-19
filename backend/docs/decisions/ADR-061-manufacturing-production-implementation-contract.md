# ADR-061 — Manufacturing / Production: Implementation Contract (Phase 1)

**Status: Proposed baseline for implementation — STOP for CTO review and
approval before any code is written.** Derived strictly from
`ADR-053` (Long-Term ERP Completion Charter), `MANUFACTURING_PRODUCTION_
ARCHITECTURE_STUDY.md` (Phase 0), `ADR-060` (the five ratified costing/
integration decisions, D1–D5), and direct audit of existing Core mechanisms
(Financial Event Engine, Approval Engine, `recordMovement`, `NumberingService`,
`ProcessEngineService`, `AuditService`). This document introduces no
accounting policy beyond what D1–D5 already ratified, and reopens none of
them. **No code, schema, migration, permission, seed/data, or frontend
change is made by this document.** Production remains HOLD. Same
"freeze the contract before coding" discipline as `ADR-051`/`ADR-057`.

**ملخص تنفيذي (ar):** هذا هو عقد التنفيذ النهائي للتصنيع (Phase 1)، بلا أي
كود. مبني حصريًا على القرارات الخمسة المعتمدة في ADR-060: تكلفة فعلية
(متوسط متحرك)، مواد فقط بدون أجور/تكاليف غير مباشرة، بدون تكلفة معيارية أو
انحرافات، تقييم WIP مستمر عند كل حركة، وإصلاح `assembleProduct` القديم
ليمر عبر نفس قناة `recordMovement` المعتادة. يغطي العقد النقاط العشرين
المطلوبة بالكامل، مع جدول محاسبي صريح لكل نوع حركة إنتاجية (الأثر المخزني
← أثر التقييم ← الحدث المالي ← الأثر المحاسبي ← مفتاح عدم التكرار ← حدود
المعاملة) — بلا أي حركة تُستثنى ضمنيًا من الترحيل المحاسبي. التوقف إلزامي
بعد هذا المستند بانتظار مراجعة واعتماد الـCTO.

---

## 0. Evidence discipline (carried forward from Phase 0)

Every current-state claim is tagged **VERIFIED** (read directly from source
this session or the Phase 0 study session), **INFERRED** (derived from a
verified fact plus an established, cited convention), or **UNVERIFIED**
(an open question, never presented as an existing capability). Where this
contract makes a new specification (not a current-state claim), it is
stated plainly as a requirement, not tagged.

---

## 1. Manufacturing bounded context and module boundary

**Specification:** A new module `manufacturing`, with its own manifest
`manufacturing.manifest.ts`, added to `ALL_MODULE_MANIFESTS`
(`foundation/module-registry/manifests/index.ts`) — the ninth entitlement
module, joining `sales, inventory, logistics, finance, reporting, hr,
accounting, procurement` (VERIFIED current list, Phase 0 §1). `depends_on:
['sales', 'inventory']` (entitlement dependency, `ADR-055 §7`; `accounting.
manifest.ts`'s existing `depends_on: ['finance']` is the direct precedent,
VERIFIED in Phase 0 §1). Financial-event/GL integration (§13) is a Core/
Foundation capability every module already uses without a manifest
dependency on `accounting` itself (the same way `procurement.manifest.ts`
does not declare `depends_on: ['accounting']` despite posting Financial
Events — INFERRED from the established pattern; not independently
re-verified this session). New domain directory:
`backend/src/domains/manufacturing/` (`domain/`, `application/`,
`infrastructure/`, `interface/`), matching every existing domain's
structure.

## 2. Product/BOM ownership and BOM versioning/effective-date behavior

**Ownership: BOM stays exactly where it is (Commerce/`sales`), unmodified.**
`BillOfMaterial`/`BomComponent` (Phase 0 §2/§3, VERIFIED) are **not**
migrated into `manufacturing`, and their existing schema — including the
`UNIQUE(finishedProductId)` constraint and the "no versioning, no
effective-date ranges" invariant — is **not altered**. That invariant traces
to an explicit prior CTO handover directive (Phase 0 §3, VERIFIED); changing
it is a business-invariant change per `ADR-053 §16` and is out of scope for
this contract. Manufacturing reads BOM exclusively through the existing
`SalesBomContract`/`getBomForAssembly`-style read contract (Phase 0 §2,
VERIFIED `bom.service.ts implements SalesBomContract`) — a new,
Manufacturing-side read method may be added to that same contract interface
if the existing one's shape is insufficient, but the contract boundary
itself (Commerce owns and defines BOM; other domains read it) is preserved.

**Versioning/effective-date behavior: solved without touching BOM's schema.**
A Work Order **snapshots** its required components (product, quantity,
and the component's moving-average cost *at release time*) onto its own
new, Manufacturing-owned table (`work_order_components`, §3) when the Work
Order is released. From that point on, the Work Order's own snapshot — not
a live re-read of `BillOfMaterial`/`BomComponent` — is authoritative for
that Work Order's material requirement and consumption, even if the BOM is
edited afterward. This gives Work Orders point-in-time recipe fidelity
without adding versioning to a table whose current shape is a ratified
invariant, and without inventing a new BOM-versioning mechanism this
program has not asked for.

## 3. Work Order / Production Order aggregate and lifecycle

**New entity `WorkOrder`** (`manufacturing/infrastructure/work-order.entity.ts`):
`id`, `workOrderNumber` (via `NumberingService`, §16), `finishedProductId`,
`quantityPlanned`, `quantityProduced` (running total, updated at each
Finished Goods Receipt, §7), `warehouseId` (the physical warehouse the
Work Order executes in — its WIP sub-location is derived from this, §6),
`createdByUserId`, `createdAt`. No `status` column — matching the
established convention (`FISCAL_YEAR_PROCESS`/`FISCAL_PERIOD_PROCESS`,
Procurement's own process definitions — Phase 0 §5, VERIFIED/INFERRED) —
live state is read via `ProcessEngineService.getState`.

**New entity `WorkOrderComponent`** (the BOM snapshot, §2): `id`,
`workOrderId`, `componentProductId`, `quantityRequired` (= BOM's
`quantityPerUnit × quantityPlanned` at release time), `quantityIssued`
(running total), `unitCostAtRelease` (informational snapshot only — actual
issue cost is always the live moving-average at issue time, per D1; this
field exists for variance-free informational comparison only, since D3
explicitly excludes variance *accounting*, not the ability to look at a
number).

**Lifecycle** — a new `ProcessDefinition`, `WORK_ORDER_PROCESS`:

```
draft -> released -> in_progress -> completed
draft -> cancelled
released -> cancelled   [only if zero material has been issued]
in_progress -> on_hold -> in_progress
```

- `draft`: the Work Order exists, quantities are editable, no BOM snapshot
  yet, no financial/inventory effect.
- `released`: `WorkOrderComponent` snapshot is taken (§2) from the live BOM;
  quantities on the Work Order are now frozen. No material has moved yet.
- `in_progress`: entered automatically on the **first** Material Issue
  (§5/§6) against this Work Order — not a separately-triggered transition.
- `on_hold`: a manual pause; no material issue/receipt is permitted while
  on hold (mirrors `soft_close`'s "no posting while closed" role in the
  Fiscal Period process, INFERRED from that established pattern).
- `completed`: entered when the Work Order's owner explicitly closes it
  (not automatic on reaching `quantityPlanned` — a Work Order may complete
  at a partial quantity, or with a final Finished Goods Receipt exactly
  reaching plan; either way, completion is an explicit action, not an
  implicit threshold-cross, matching this codebase's general preference for
  explicit state transitions over inferred ones). **Hard guard (resolves
  §6/§7's completion-validation requirement): `completed` may only be
  entered when this Work Order's own WIP balance is exactly zero** (within
  the same currency-precision rounding tolerance every other monetary
  comparison in this codebase already uses — no new tolerance concept).
  Concretely, this means a Work Order that will finish at less than
  `quantityPlanned` (a deliberate partial/under-production close) **must
  first Material-Return whatever unconsumed component value remains** in
  its WIP (§5/§8) before `completed` is reachable — the transition is
  rejected, the same fail-closed style `assertCleanForClose`-equivalent
  guards already use elsewhere in this codebase (INFERRED from the Fiscal
  Period closing-exception guard pattern surfaced in this session's own
  earlier Accounting frontend work, not independently re-verified here),
  not silently allowed to strand value. See §8's revised worked example and
  §21 for what this implies when the shortfall is genuine physical
  scrap/spoilage rather than merely unused, returnable material.
- No `reopen` transition — a completed Work Order is closed permanently, the
  same "append-only once posted" discipline Journal Entries already use
  (Phase 0 §5, INFERRED from `accounting_journal_entries`' own "append-only
  once POSTED" rule, cited in this session's earlier Wave 1 work, not
  re-verified here).

## 4. Routing / Operations / Work Centers

**Not built in Phase 1 — explicitly excluded by the ratified policy, not by
omission.** Routing/operations/work-centers exist in real manufacturing
ERPs primarily to support labor-hour capture and multi-step production
sequencing. D2 (Phase 0/`ADR-060`) explicitly defers all labor/overhead
absorption and forbids inventing labor rates or allocation rules. Without a
labor dimension to sequence or measure, a Work Order in this contract is a
**single-step** transformation (issue materials → produce finished goods),
identical in shape to today's `assembleProduct` (Phase 0 §5, VERIFIED) except
correctly integrated (§5–§7) and no longer instantaneous (materials may sit
in WIP for a real duration, D4). No `Routing`/`Operation`/`WorkCenter`
entity is created. This is a disclosed exclusion, not silent scope
creep-by-omission: if a future phase reintroduces labor/overhead (only via
its own CTO-ratified decision, per `ADR-060`'s own escalation discipline),
Routing/Work Centers become necessary at that point, not before.

## 5. Material reservation, issue, consumption and return behavior

**Reservation:** reuses the existing `stock_reservations` mechanism
verbatim (Phase 0 §6, VERIFIED reusable) — a Work Order, on release,
reserves each `WorkOrderComponent`'s `quantityRequired` against
`referenceType: 'work_order'`, `referenceId: workOrderNumber`, using the
existing `reserveStockInTransaction`-style call (Phase 0 §6, VERIFIED as a
generic, already-multi-consumer method). This is the same reservation table
Sales Orders already use — no second reservation mechanism.

**Issue:** a new movement type `work_order_material_issue` — decreases the
component's on-hand stock in the Work Order's warehouse, decreases the
matching reservation, increases the Work Order's WIP balance (§6). **Must
call `InventoryService.recordMovement`** (this is D5's core requirement,
§14) — never a direct `stock_movements` write, closing exactly the gap
Phase 0 §6/§11 identified in the legacy path. Partial issue (issuing less
than `quantityRequired` in one call, issuing across multiple calls) is
supported by construction — `WorkOrderComponent.quantityIssued` accumulates
per issue, the same way `PurchaseOrderLine.quantityReceived` already
accumulates across partial Goods Receipts (Phase 0 §12, INFERRED from the
established Procurement pattern). **Physically**, this is an ordinary F08
receipt into the Work Order's dedicated WIP sub-warehouse (§6): the
component's physical on-hand quantity there increases by the issued
quantity, valued (per D1) at the issuing warehouse's own current
moving-average cost — the "WIP balance" increase in dollar terms is a
direct, mechanical consequence of that physical inflow, not a
separately-computed figure.

**Hard guard (no over-issue in Phase 1):** `work_order_material_issue` must
reject any issue event where `quantityIssued_before + issueQuantity >
quantityRequired` for that `WorkOrderComponent` — the same fail-closed
style as §3's completion guard and this section's own return-quantity
guard below. A Work Order's BOM snapshot (§2/§3) is the sole authorization
for how much of a component may ever be issued against it in Phase 1;
issuing beyond it is not a partial-issue variant, it is a different
business event (unplanned/extra consumption) that this contract does not
define a policy for, and therefore does not allow silently. If a Work
Order genuinely needs more of a component than its snapshot allows, the
correct Phase 1 action is to put it `on_hold` and resolve the shortfall at
the planning level (e.g. a new or amended Work Order) — not an unbounded
issue against the existing one.

**Consumption:** in this contract, "issue" and "consumption" are the same
event — once material is issued to a Work Order, it is by definition
consumed into WIP (there is no further "shelf" state between issue and
WIP, matching D4's continuous-valuation requirement: the moment material
leaves raw-material stock, it must already be a valued WIP asset, not an
un-costed limbo state).

**Return:** a new movement type `work_order_material_return` — the exact
reversal of an issue: increases the component's on-hand stock back in the
originating (real) warehouse, decreases the Work Order's WIP balance,
decreases `WorkOrderComponent.quantityIssued`. **Physically**, this
decreases that component's on-hand physical quantity in the Work Order's
dedicated WIP sub-warehouse by the returned quantity — symmetric with
Issue's physical inflow above. **Corrected costing rule
(supersedes an earlier, mathematically incomplete draft of this contract
that specified "the original issue's cost"):** a return is costed at the
**WIP sub-warehouse's own current moving-average cost for that component,
in that Work Order's dedicated WIP sub-warehouse** (§6) — not the cost of
any one specific prior issue. This is necessary, not merely stylistic:
after two or more issues of the *same* component at *different* real-
warehouse costs (§8's worked example shows exactly this), the physical
units inside WIP are fungible and already blended into one running
average by the same moving-average mechanic every other receipt in this
codebase already uses (Phase 0 §8, VERIFIED — F08 has never tracked
per-lot cost identity; "the original issue's cost" is not a well-defined
quantity once blending has occurred, and specifying it as the rule would
have been unimplementable as stated). Costing a return at WIP's current
average — symmetric with how any dispatch anywhere in this codebase is
already costed at the current average of the warehouse it leaves (Phase 0
§11, VERIFIED) — is the only rule consistent with the moving-average
method D1 ratified, and is what §8 proves conserves value exactly. A
return may not exceed the Work Order's own cumulative issued-minus-already-
returned quantity for that component (a `WorkOrderComponent`-scoped guard,
mirroring the existing quantity-variance guard pattern Phase 0 §5 found
already enforcing GRNI's own invariant as a side effect — INFERRED as the
same *kind* of guard, not a copy of GRNI's specific code).

## 6. WIP movement and valuation lifecycle — WIP isolation model (RESOLVED: Option A)

**Resolved explicitly, per the CTO's review: Option A — a dedicated WIP
sub-warehouse per Work Order, strict one-to-one ownership.** Not Option B
(a shared WIP location with Work-Order-level provenance tracking).

**Why A, not B — this is a reuse decision, not an arbitrary preference.**
The existing Moving Average engine (F08) tracks exactly one running cost
per **(product, warehouse)** pair (Phase 0 §8/§11, VERIFIED) — it has no
Work-Order dimension at all. If WIP were a single **shared** location
(Option B) holding materials for multiple concurrent Work Orders
simultaneously, a component's moving-average cost inside that shared
location would blend across *every* Work Order using it — WO-A's and
WO-B's materials would be financially indistinguishable the moment both had
issued the same component into the same shared bucket, making an accurate
per-Work-Order WIP balance impossible **without inventing an entirely new,
Work-Order-dimensioned costing ledger** — precisely the "second accounting/
valuation mechanism" `ADR-055 §10` and D1 (use the *existing* Moving
Average engine) both counsel against. A **dedicated** sub-warehouse per
Work Order sidesteps this by construction: each Work Order's sub-warehouse
is its own distinct `warehouseId` to the existing engine, so the engine's
existing, unmodified per-(product, warehouse) tracking already gives each
Work Order a correctly isolated, correctly blended running cost per
component — zero new valuation mechanism required, only new **rows** in
tables that already exist.

**Mechanics:** reuses the existing sub-warehouse precedent verbatim (Phase
0 §15, VERIFIED — the same mechanism that already gives every Shipping
Company/Vehicle an auto-created Operational Sub-location nested under a
real `Warehouse`, via the existing `parentWarehouseId` self-reference — no
new entity or table). **On Work Order `release` (§3), exactly one WIP
sub-`Warehouse` row is auto-created for that Work Order** — deterministically
coded from the Work Order's own number (e.g. `WIP-<workOrderNumber>`),
`parentWarehouseId` = the Work Order's real execution warehouse. This
sub-warehouse belongs to **exactly one** Work Order for its entire
lifetime — never reused, never shared, and (matching `ADR-055 §8`'s
"disabled/cancelled ≠ deleted" rule) never deleted even if the Work Order
is later `cancelled` — it simply remains a permanent, zero-balance,
inert row.

`work_order_material_issue` moves a component from the real warehouse into
this dedicated WIP sub-warehouse; `work_order_material_return` moves it
back; `work_order_finished_goods_output` moves value out of it into the
real target warehouse as the finished product (§7). None of these are
generic, un-costed transfers — each explicitly invokes the same valuation
primitives an existing `'receipt'`/dispatch already uses (read the source
side's current moving-average cost; apply that cost as the destination
side's receipt cost), per movement, per §13's table — **not** a bare
`transfer_in`/`transfer_out` pair with no cost consequence, which is what a
plain warehouse-to-warehouse transfer is today (Phase 0 did not verify that
transfers already carry a valuation effect, and this contract does not
assume they do — Manufacturing's movements carry their own explicit
valuation calls).

**WIP(WO) balance is never a stored, separately-maintained number.** It is
always the **computed** current stock value of that one Work Order's
dedicated sub-warehouse (Σ over every component currently on hand there, at
that sub-warehouse's own current moving-average cost per component) — the
same "never cache a balance, always compute it from the ledger" philosophy
this codebase already applies to GL account balances and trial balances
(Phase 0 citation of the established convention, not re-verified
independently this session). No new balance-tracking table is introduced.

**Consequences for the properties the CTO required this model to support:**

- **WO-level WIP balance:** exact, by construction — it is that Work
  Order's own sub-warehouse's stock value, nothing else's.
- **Exact return valuation:** the sub-warehouse's own current
  per-component average (§5, corrected) — well-defined at every point in
  time because there is only ever one Work Order's material in that
  sub-warehouse.
- **FG output valuation:** §7 (revised below), computed purely from this
  one Work Order's own sub-warehouse balance.
- **Work Order completion validation:** §3's new hard guard
  (`WIP(WO).value == 0` to complete) — trivially well-defined per Work
  Order, since there is no cross-Work-Order value to disentangle.
- **Concurrent Work Orders:** two Work Orders never contend on each other's
  WIP rows at all (different `warehouseId`s entirely) — they only briefly
  contend on the *shared real warehouse's* component stock during their own
  Issue/Return calls, exactly the existing `pg_advisory_xact_lock`
  discipline already handles (§12). This is *less* contention than Option B
  would have created, not more.
- **Reconciliation:** Month-End's existing Inventory reconciliation (§17)
  must be confirmed to correctly sum across **every** Work-Order-owned WIP
  sub-warehouse as ordinary inventory value (there will be one such
  sub-warehouse per Work Order ever released, not a single shared bucket) —
  restated and sharpened in §17 below.

## 7. Finished Goods receipt and inventory integration — FG cost formula (RESOLVED)

**New movement type `work_order_finished_goods_output`** — increases the
finished product's on-hand stock in the Work Order's real (non-WIP)
warehouse, decreases the Work Order's own dedicated WIP sub-warehouse's
balance (§6), increments `WorkOrder.quantityProduced`.

**Corrected cost formula (supersedes an earlier, mathematically incomplete
draft of this contract — the CTO correctly identified that "cumulative WIP
÷ cumulative quantity produced" double-counts once a second output event
occurs, because WIP is a *residual* balance, not a cumulative record of
everything ever produced).** For output event *i*, producing quantity
`q_i`, where `quantityProduced_before` is this Work Order's
`quantityProduced` immediately before this event:

```
remainingPlannedQty_before = quantityPlanned − quantityProduced_before
unitCost_i                 = WIP(WO).value_before ÷ remainingPlannedQty_before
valueOutput_i               = unitCost_i × q_i
WIP(WO).value_after         = WIP(WO).value_before − valueOutput_i
quantityProduced_after      = quantityProduced_before + q_i
```

**Hard guard (no over-production beyond plan):**
`work_order_finished_goods_output` must reject any output event where
`quantityProduced_before + outputQuantity > quantityPlanned` — a Work
Order can never report more finished output than it planned, even summed
across many partial output events. This is not merely a business-sanity
check: it is required for the formula above to stay well-defined, because
without it `remainingPlannedQty_before` (the formula's divisor) could
reach zero or go negative before a legitimate final output — an undefined
division, not merely an undesirable one.

**Physical component consumption at FG output (RESOLVED — closes the
physical/monetary reconciliation gap the CTO's final review identified).**
Because §6 models WIP as a real, dedicated inventory sub-warehouse holding
physical component stock — not merely a dollar figure — the formula above
governs *only* the dollar amount leaving WIP as a whole; it does not by
itself say how many physical units of any specific component are
consumed. That is defined here.

1/2. **Physical quantity consumed, tied to the BOM snapshot.** For output
event *i*, producing finished-good quantity `q_i`, and for each
`WorkOrderComponent` *c* on this Work Order:

```
componentQtyConsumed_i,c = (quantityRequired_c ÷ quantityPlanned) × q_i
```

`quantityRequired_c ÷ quantityPlanned` is exactly this Work Order's own
snapshotted BOM ratio for component *c* (§2/§3 — `quantityRequired_c` was
itself computed as `BOM.quantityPerUnit_c × quantityPlanned` at release
time), so this is equivalent to "BOM quantity per finished unit × output
quantity," using the Work Order's frozen snapshot rather than a live
re-read of `BillOfMaterial`/`BomComponent` — the same snapshot-is-
authoritative rule §2 already ratified for issue quantities, extended
here to output quantities. No alternative consumption rule is introduced;
nothing already ratified (D1–D5, §2's snapshot rule) suggests a different
one.

3. **Resulting stock movement inside the dedicated WIP warehouse.**
`work_order_finished_goods_output` is a single all-or-nothing document
(matching `recordMovement`'s existing multi-line, all-or-nothing document
discipline, Phase 0 §6, VERIFIED) containing, for this one output event:
one decrease line per `WorkOrderComponent` *c*, for
`componentQtyConsumed_i,c` units, against that component's on-hand
physical stock in the Work Order's dedicated WIP sub-warehouse (§6); and
one increase line for `q_i` units of the finished product in the Work
Order's real (non-WIP) warehouse. All lines post together or not at all —
there is no intermediate state where finished goods have been received
but WIP's physical component stock has not yet been drawn down, or vice
versa.

4. **Hard guard — physical availability.** Before applying any of the
above, for every `WorkOrderComponent` *c*, the Work Order's dedicated WIP
sub-warehouse's current on-hand physical quantity of *c* must be **≥**
`componentQtyConsumed_i,c`; if any single component fails this check, the
**entire** output event is rejected (all-or-nothing, matching the
document boundary in point 3) — a Work Order cannot report finished
output that its physically on-hand WIP stock cannot actually back, even
though the output quantity itself may be within `quantityPlanned` (this
section's other guard) and even though enough may eventually have been
*issued* in total (§5's guard) — availability is checked against what is
physically present in WIP **right now**, not against a cumulative
entitlement. In practice, this guard is what forces a Work Order's
net-issued quantity for each component to actually reach
`quantityRequired_c` before that component's share of the plan can be
fully produced — no additional, separate "has enough been issued" check
is needed.

5. **Reconciling physical quantity and monetary value at completion.**
Two independent totals must each reach zero when a Work Order completes
at `quantityProduced == quantityPlanned`: the physical on-hand quantity of
every component in WIP, and `WIP(WO).value` (§3's existing completion
guard). These reach zero **together**, not merely coincidentally:

- **Physical quantity:** summing `componentQtyConsumed_i,c` over every
  output event for a component *c* gives `(quantityRequired_c ÷
  quantityPlanned) × Σ_i q_i`. When the Work Order completes at full
  plan, `Σ_i q_i = quantityPlanned`, so total consumed = `quantityRequired_c`
  exactly — regardless of how many partial events or in what order. Net
  physical on-hand for *c* reaches exactly zero at that point **if and
  only if** net-issued quantity for *c* also reached `quantityRequired_c`
  — precisely what guard 4 above forces before the final output can be
  accepted.
- **Monetary value:** unchanged from the already-proven result below —
  `WIP(WO).value` reaches exactly `$0.00` at the same moment, because
  `remainingPlannedQty` and `quantityProduced`'s distance from
  `quantityPlanned` are the same underlying quantity by construction.
- **Attributing `valueOutput_i` across components (why there is no
  double-accounting):** `valueOutput_i` (the one dollar figure the
  formula above produces) is the *only* amount that leaves
  `WIP(WO).value` at event *i* — this does not change. Because WIP is
  physically tracked per component (§6, via F08's existing
  per-(product, warehouse) mechanic), posting the physical decrease
  lines in point 3 still requires *some* per-component cost for F08's
  own bookkeeping. That cost is **not** each component's own
  independently-tracked moving average (unlike an ordinary Issue or
  Return, §5) — it is `valueOutput_i` allocated across the components
  consumed in this event, in proportion to what each component's *own*
  current moving average would naturally have valued its
  `componentQtyConsumed_i,c` at:

  ```
  naturalValue_i,c           = componentQtyConsumed_i,c × currentAvgCost_c
  naturalTotal_i              = Σ_c naturalValue_i,c
  componentValueConsumed_i,c = valueOutput_i × (naturalValue_i,c ÷ naturalTotal_i)
  ```

  By construction, `Σ_c componentValueConsumed_i,c = valueOutput_i`
  exactly — there is exactly one dollar total leaving WIP per output
  event, split across components only for F08's own per-component
  bookkeeping, never summed twice and never independently re-derived.
  This is a deliberate, narrow exception to F08's default "dispatch at
  the source's own current average" rule (§5 still uses that default
  rule for Issue and Return): a Finished Goods Output is not an ordinary
  dispatch of a single component, it is the point where D1's
  "actual/moving average, applied one level up" policy (this section) —
  which treats the whole Work Order as one pooled costed unit, not *N*
  independently-costed component streams — is realized as a set of
  component-level postings. For a Work Order with only one component (as
  in §8's worked example), this collapses to
  `componentValueConsumed_i,c = valueOutput_i` directly, since that one
  component's natural-value share is trivially 100%.

**Explicit costing-policy statement (clarifying the formula above):** at
each FG output event, the *entire* current `WIP(WO).value` is allocated
across the Work Order's *remaining planned* production quantity — never
across only the quantity being output in that one event, and never across
the Work Order's original `quantityPlanned` re-used unmodified from the
start. The per-unit cost this formula produces is therefore **not fixed
for the life of the Work Order**: it is recomputed fresh at every output
event from whatever `WIP(WO).value` and `remainingPlannedQty` happen to be
at that instant. One consequence must be stated explicitly, because it is
easy to miss: **a Material Issue that occurs after a partial FG output
changes the cost basis of every unit still to be produced**, since it
raises `WIP(WO).value` without changing `remainingPlannedQty`, which
raises `unitCost_i` for the next output — exactly the way a
moving-average receipt anywhere else in this codebase raises the rate for
what is dispensed next. §8's worked example below is extended with
precisely this case (a Material Issue occurring after a partial FG
output) to prove the formula stays value-conserving when it happens.

This is the moving-average method (D1) applied one level up: exactly as an
ordinary dispatch draws down a warehouse's on-hand value at that
warehouse's *current* average without disturbing the average for what
remains, an FG output draws down this Work Order's WIP value at its
*current* value-per-remaining-planned-unit, leaving the correct rate in
place for the next output or for value added by a subsequent Material
Issue (which raises `WIP(WO).value` — and therefore the rate for whatever
is produced next — exactly the way any moving-average receipt raises the
rate for what is dispensed next). `unitCost_i` is supplied as the
`unitCostBase` input into `recordMovement` exactly the way a Procurement
Goods Receipt or Opening Stock import already supplies one for a
`'receipt'`-type movement (Phase 0 §8/§11, VERIFIED — F08's *"ONE approved
opening-stock/receipt cost-input flow"*) — reusing that exact, existing
mechanism rather than inventing a second one, per `ADR-055 §10`.

**Proof this conserves both value and physical quantity exactly across
multiple partial outputs, partial issues, a partial return, a component
cost change between issues, and a Material Issue occurring between two
partial FG outputs** — see §8's fully worked numerical example, which
traces a single Work Order end-to-end and shows total value in (issues,
net of a return) = total value out (two partial FG outputs), to the cent,
*and* total physical component quantity issued (net of the return) =
total physical component quantity consumed across both outputs, with the
final output correctly driving both `WIP(WO).value` and every component's
physical on-hand quantity to exactly zero (satisfying §3's new completion
guard and point 5 above) precisely because `remainingPlannedQty` reaches
zero at the same moment `quantityProduced` reaches `quantityPlanned`.

**Partial output** (a Work Order producing less than `quantityPlanned` in
one event, or across multiple events before completion) is supported by
construction — this is the formula's normal operating case, not an edge
case bolted on afterward.

## 8. Worked numerical example (required proof of conservation)

One Work Order, finished good **F**, `quantityPlanned = 10`, one raw
component **C**, BOM ratio (this Work Order's own snapshot,
`quantityRequired ÷ quantityPlanned`) = **2.1 units of C per unit of F**,
so `quantityRequired` for C = **21 units**. All figures to the cent; no
rounding error accumulates in the dollar totals because every dollar step
is exact arithmetic on the figures given (the two *derived, informational*
per-unit component rates in steps 5 and 7 are irrational-decimal and are
shown rounded — see the note after the table).

| Step | Event | Detail | Physical C on hand in WIP after | WIP(WO).value after |
|---|---|---|---|---|
| 1 | Material Issue #1 | 12 units of C @ real warehouse's current avg **$5.00** → WIP receipt-costed @ $5.00; WIP's own avg for C = $5.00. Guard check: `quantityIssued_before(0) + 12 ≤ 21` — passes. | **12** (0 + 12) | **$60.00** (12 × $5.00) |
| 2 | *(real warehouse independently receives new stock of C @ $6.00 — unrelated to this Work Order)* | — | 12 (unchanged) | $60.00 (unchanged) |
| 3 | Material Issue #2 | 8 units of C @ real warehouse's *new* current avg **$6.00** → WIP receipt-costed @ $6.00; WIP's own avg for C recomputes: (12×$5.00 + 8×$6.00) ÷ 20 = **$5.40**. Guard check: `quantityIssued_before(12) + 8 ≤ 21` — passes. | **20** (12 + 8) | **$108.00** (20 × $5.40) |
| 4 | Material Return | 2 units of C returned, costed at WIP's **current** avg for C = $5.40 (§5, corrected — not "the original issue cost," which is no longer a single well-defined number after step 3's blend) | **18** (20 − 2) | **$97.20** (18 × $5.40 — self-consistent: $108.00 − $10.80) |
| 5 | FG Output #1 | Produce 6 of 10 planned. **Physical:** `componentQtyConsumed = (21 ÷ 10) × 6 = 12.6` units of C. Availability guard: on-hand `18 ≥ 12.6` — passes. **Monetary:** `remainingPlannedQty_before = 10 − 0 = 10`. `unitCost = $97.20 ÷ 10 = $9.72`. `valueOutput = 6 × $9.72 = $58.32`. Over-production guard: `0 + 6 ≤ 10` — passes. (Derived, informational only: the effective rate this event applies to C's own physical units is `$58.32 ÷ 12.6 ≈ $4.63/unit` — not C's own $5.40 average; see the reconciliation note below.) | **5.4** (18 − 12.6) | **$38.88** ($97.20 − $58.32) |
| 6 | **Material Issue #3** *(occurs after a partial FG output — the case the costing-policy clarification above addresses)* | 3 more units of C, issued @ real warehouse's *now-current* avg **$7.00** (having moved again since step 3) → WIP receipt-costed @ $7.00. Guard check: `quantityIssued_before(20) + 3 ≤ 21` — passes, at the exact boundary once combined with step 4's return (net issued reaches exactly 21). | **8.4** (5.4 + 3) | **$59.88** ($38.88 + 3 × $7.00) |
| 7 | FG Output #2 (final) | Produce remaining 4 of 10. **Physical:** `componentQtyConsumed = (21 ÷ 10) × 4 = 8.4` units of C. Availability guard: on-hand `8.4 ≥ 8.4` — passes, at the exact boundary. **Monetary:** `remainingPlannedQty_before = 10 − 6 = 4` (**unchanged by the issue** — only `quantityProduced` moves this divisor). `unitCost = $59.88 ÷ 4 = $14.97` — **higher than step 5's $9.72**, exactly because step 6 raised `WIP(WO).value` without changing `remainingPlannedQty`. `valueOutput = 4 × $14.97 = $59.88`. Over-production guard: `6 + 4 = 10 ≤ 10` — passes, at the exact boundary. (Derived, informational rate: `$59.88 ÷ 8.4 ≈ $7.13/unit`.) | **0** (8.4 − 8.4) | **$0.00** ($59.88 − $59.88) |

**Conservation check — value:**

```
Total value IN  (issues, net of return) = $60.00 + $48.00 − $10.80 + $21.00 = $118.20
Total value OUT (both FG outputs)       = $58.32 + $59.88                   = $118.20
```

**Conservation check — physical quantity:**

```
Total C issued (net of return) = 12 + 8 − 2 + 3 = 21 units
Total C consumed (both outputs) = 12.6 + 8.4    = 21 units
```

**Both exactly balanced — neither material value nor physical component
quantity is created or destroyed**, across two partial issues, a component
cost change between them, a partial return valued at the post-blend
average, a *third* Material Issue occurring **after** a partial FG output
at yet another new cost, and two partial FG outputs whose combined
quantity exactly reaches `quantityPlanned` at the over-production guard's
exact boundary (`10 ≤ 10`). Both `WIP(WO).value` **and** physical on-hand
C reach exactly zero at the moment `quantityProduced` reaches
`quantityPlanned` — satisfying §3's completion guard and the physical/
monetary reconciliation above — without any special "final output absorbs
the remainder" rule, because `remainingPlannedQty` (the value formula's
denominator) and the *unconsumed fraction of `quantityRequired`* (the
physical formula's residual) both reach zero at the same instant by
construction. Crucially, the mid-stream Material Issue (step 6)
**demonstrably changed the monetary cost basis of the remaining planned
units** — from `$9.72` to `$14.97` per unit — while the *physical*
consumption rate stayed fixed at the BOM's own 2.1-per-unit ratio
throughout; this is the intended effect of allocating the WO-pooled dollar
total (§7) independently from the BOM-fixed physical rate (§7, point 2) —
the two are reconciled in total, not forced to move together at every
step.

**Note on the two derived per-unit component rates (steps 5 and 7):** the
$58.32/12.6 ≈ $4.63 and $59.88/8.4 ≈ $7.13 figures are *not* new policy
values and drive no posting on their own — they exist only because F08
needs a per-unit cost to record the physical decrease line for component
C (§7, point 5's `componentValueConsumed_i,c`), and here they simply equal
`valueOutput_i` itself divided by the physical quantity consumed, since a
single-component Work Order attributes 100% of `valueOutput_i` to that
one component. The GL posting itself always uses the exact-to-the-cent
`valueOutput_i` total, not a re-multiplication of a rounded per-unit rate
— any rounding shown here is for this document's display only, using the
same monetary-rounding convention already used elsewhere in this
codebase, not a new one.

**What happens if a Work Order completes with `quantityProduced <
quantityPlanned` (a deliberate under-produced close, not shown in the table
above):** `WIP(WO).value` will **not** be zero at that point (some planned-
but-unmade quantity's worth of material value is still sitting in WIP) —
§3's guard rejects `completed` until it is. In Phase 1, the *only* legal
way to reach zero in that situation is a Material Return of the
now-unneeded component quantity (§5) — see §21 for the explicit,
disclosed limitation this implies for genuine physical scrap/spoilage
(as opposed to merely unused, returnable material), which Phase 1 has no
separate mechanism for.

## 9. Actual/Moving-Average costing behavior (D1)

Confirmed, no new costing engine: every cost figure in this contract (issue
cost, WIP balance, finished-goods output cost) is either (a) read live from
the existing Moving Average engine (component issue cost) or (b) a plain
arithmetic roll-up of (a)-sourced figures (WIP balance, finished-goods
output cost) — there is no second costing method, no standard-cost field
anywhere in this contract's data model, and no code path that could produce
two different valid answers for "what did this cost" the way a
standard-vs-actual system would.

## 10. Explicit exclusion of Labor/Overhead absorption from Phase 1 (D2)

No labor-hour field, no machine-hour field, no overhead-rate config key, no
overhead-pool entity, and no allocation-rule mechanism appears anywhere in
this contract. Finished-goods output cost (§7) is material cost only, by
construction — there is no code path where a non-material cost could enter
the calculation, so there is nothing to accidentally invent here even at
the implementation-detail level.

## 11. Explicit exclusion of Standard Cost and Variance accounting from Phase 1 (D3)

No standard-cost field on `Product`, `BillOfMaterial`, or `WorkOrder`. No
variance-calculation code path (there is nothing to compare Actual cost
*against*, since no standard exists). No new GL account, control function,
Financial Event, or approval-request type for "variance" of any kind.
`WorkOrderComponent.unitCostAtRelease` (§3) is the **one** informational,
non-posting figure this contract includes that is adjacent to variance —
explicitly disclosed as informational-only, never read by any posting or
reconciliation code path, so it cannot silently become a variance
mechanism by accretion.

## 12. Inventory integration contract

**Every Manufacturing movement — issue, return, finished-goods output —
calls `InventoryService.recordMovement`.** None writes `stock_movements`
directly. This is the specific, concrete closure of the exact gap Phase 0
§6/§11 identified (`assembleProduct`'s direct `movementRepo.save()` calls)
and is non-negotiable per D5. Concurrency: the existing
`pg_advisory_xact_lock(hashtext($warehouseId:$productId))` discipline
`assembleProduct` already uses (Phase 0 §6, VERIFIED) is preserved for every
new movement type touching a (warehouse, product) pair — locking the real
warehouse/product pair, the WIP sub-warehouse/product pair, and the target
warehouse/product pair as applicable, in a stable (sorted) order, exactly
matching `assembleProduct`'s own existing deadlock-avoidance pattern.

## 13. Financial Event / GL integration contract

**No Manufacturing movement silently inherits "no GL entry."** Per the
CTO's explicit critical accounting requirement, every movement type is
specified in full below:

| Movement type | Inventory effect | Valuation effect | Financial Event | GL effect | Idempotency key | Transaction boundary |
|---|---|---|---|---|---|---|
| `work_order_material_issue` | Component stock −qty in real warehouse; +qty in WIP sub-warehouse | Cost = live moving-average of component at issue time (D1) | **YES** — new topic `manufacturing.work_order.material_issued` | `Dr WIP (control function 'wip', NEW) / Cr Inventory (control function 'inventory', EXISTING — same account `handleSupplierInvoicePosted` already resolves, Phase 0 §13)` | `manufacturing:work_order:<workOrderId>:material_issue:<issueLineId>` | Same transaction as the stock movement + reservation decrement; all-or-nothing |
| `work_order_material_return` | Component stock +qty in real warehouse; −qty in WIP sub-warehouse | Cost = the WIP sub-warehouse's own current moving-average cost for that component at return time (§5, corrected — never the specific prior issue's cost, which is not a well-defined quantity once multiple issues have blended; see §8) | **YES** — new topic `manufacturing.work_order.material_returned` | `Dr Inventory / Cr WIP` (exact reversal of the issue leg, at the return's own current-average cost, not the original issue's amount) | `manufacturing:work_order:<workOrderId>:material_return:<returnLineId>` | Same transaction as the stock movement; all-or-nothing |
| `work_order_finished_goods_output` | **Multi-line (§7, points 1–3):** finished product stock `+q_i` in the real (non-WIP) warehouse; **and, for EACH `WorkOrderComponent` c, physical stock `−componentQtyConsumed_i,c = (quantityRequired_c ÷ quantityPlanned) × q_i`** in the Work Order's dedicated WIP sub-warehouse — not a single value-only entry | Cost = `WIP(WO).value_before ÷ remainingPlannedQty_before` for the finished-good receipt leg (§7, corrected — not a single cumulative-average figure; see §8's worked example); each component's physical decrease line is costed at `componentValueConsumed_i,c = valueOutput_i × (naturalValue_i,c ÷ naturalTotal_i)` (§7, point 5 — a pro-rata share of the one WO-pooled `valueOutput_i`, not that component's own current average), both supplied as `recordMovement`'s existing `unitCostBase` receipt/dispatch-cost-input parameter per line | **YES** — new topic `manufacturing.work_order.finished_goods_received` | `Dr Finished Goods Inventory (control function 'inventory') / Cr WIP (control function 'wip')` — one Financial Event per output event, for the total `valueOutput_i` (component-level attribution is an inventory/costing-layer detail, not separate GL lines) | `manufacturing:work_order:<workOrderId>:fg_output:<outputEventId>` | Same transaction as **all** the stock movement lines (finished-good receipt + every component's decrease line) + `WorkOrder.quantityProduced` increment; all-or-nothing across the whole multi-line document |

**Explicitly, no movement type above is a `dispatch`, and none is added to
`INVENTORY_GL_MOVEMENT_TYPES` as currently defined** (that set's existing,
narrower purpose — Phase 0 §11, VERIFIED — is left untouched). Instead,
each Manufacturing movement type publishes its **own** Financial Event
topic directly from `manufacturing`'s own application service (the same
"publish inside the same transaction as the domain write, with a
deterministic idempotency key" pattern every Wave 1 handler already uses —
Phase 0 §13, VERIFIED/INFERRED), each consumed by its own registered
handler in `FinancialEventHandlerRegistry`, resolving both legs via
`ctx.resolveControlAccount(...)` — never a hard-coded account, matching the
`grni` control function's own addition in Wave 1 (`ADR-057 §2`, cited
read-only). **New control function required: `wip`** — added to the
existing `ControlFunction` enum exactly the way `grni` was added, with its
own chart-of-accounts seed and its own `value.control_function.wip`
terminology entry (mirroring `SeedFixedAssetControlFunctionTerminology`'s
own precedent for adding a single new control-function value, cited
read-only from this session's own earlier Phase 1/2 accounting-frontend
work — not re-opened here).

No P&L account is touched by any Manufacturing movement in this contract —
every entry above is an asset-to-asset reclassification (Inventory ⇄ WIP),
consistent with D1–D3 (no variance, no labor/overhead, actual costing only)
meaning there is no P&L consequence to recognize in Phase 1 at all. This is
a direct, mechanical consequence of the ratified decisions, not an
independent choice made here.

## 14. Legacy `assembleProduct` remediation boundary and compatibility behavior

**Contract only — not implemented by this document (per the CTO's explicit
instruction).** D5 requires `assembleProduct` to stop bypassing
`recordMovement`. The remediation contract:

- `assembleProduct`'s two direct `movementRepo.save()` calls (Phase 0 §6,
  VERIFIED, `inventory.service.ts` lines ~1228–1257) are replaced with calls
  to `this.recordMovement(...)` for both the `assembly_consumption` and
  `assembly_output` movement types — the movement types themselves are
  **not renamed** (preserving every existing `stock_movements` row's
  meaning and every existing report/query that filters on them, Phase 0
  §11's provenance discipline is not disturbed).
- **`assembly_consumption`/`assembly_output` join
  `INVENTORY_GL_MOVEMENT_TYPES`-equivalent treatment** via the same
  Financial-Event-publish mechanism §13 specifies for the new Work Order
  movement types — `Dr WIP / Cr Inventory` on consumption,
  `Dr Inventory / Cr WIP` on output, reusing the identical `wip` control
  function §13 introduces. This means a legacy "instant assembly" becomes,
  financially, an **instantaneous Work Order** (issue and output in the
  same transaction, WIP balance touched and immediately zeroed again) —
  not a second, parallel accounting treatment. No new control function or
  mechanism is introduced solely for legacy compatibility.
- **No retroactive posting.** Every `assembly_consumption`/`assembly_
  output` row created *before* this remediation ships remains exactly as
  it is today — no financial event, no GL entry, ever generated for
  historical rows (this codebase never edits a posted financial record,
  and there is no posted record to edit here in the first place — only
  going-forward behavior changes). This mirrors `ADR-057 §6`'s own
  transition-artifact treatment of pre-GRNI Procurement receipts, cited
  read-only.
- **Permission/entitlement unchanged for the legacy path**:
  `inventory.assembly.create` (Phase 0 §17, VERIFIED) continues to gate
  `assembleProduct` exactly as today; this remediation is a correctness fix
  to an existing, already-entitled capability, not a new feature requiring
  new permission design.
- **Sequencing note (not a decision this contract makes):** this
  remediation can be implemented before, alongside, or after the new Work
  Order build — it does not depend on Work Orders existing (D5 concerns
  the legacy path specifically), and Work Orders do not depend on the
  legacy path being fixed first. Phase 1's actual build sequencing is an
  implementation-planning decision, not an architectural one, and is left
  to the eventual Phase 1 implementation plan.

## 15. Permissions, SoD and approval boundaries

**New permission nodes** (`manufacturing.manifest.ts`), following the
established fine-grained convention (`ADR-055 §6`, `procurement.*`/
`accounting.*` precedent):

```
manufacturing.work_order.view
manufacturing.work_order.create
manufacturing.work_order.release
manufacturing.work_order.material_issue
manufacturing.work_order.material_return
manufacturing.work_order.finished_goods_receive
manufacturing.work_order.hold
manufacturing.work_order.complete
manufacturing.work_order.cancel
```

No `.approve` node and **no FA-01 (Approval Engine) involvement in Phase
1** — every action above is `systemPosting`-adjacent, a non-discretionary
consequence of an already-authorized operational action (the same
precedent Wave 1's own GL-posting actions use, Phase 0 §18, VERIFIED/
INFERRED), and D1–D3 leave no discretionary financial judgment (no standard
cost to override, no variance to approve) for any of these actions to gate.
**This may be revisited in a future phase** if, for example, large
material returns or Work Order cancellations with significant sunk WIP
value are judged to warrant maker/checker — that would be a new,
separately-ratified decision (mirroring how AR/AP adjustments got FA-01
treatment while routine postings did not), not something this contract
introduces preemptively.

**Feature entitlement:** `{ code: 'manufacturing.work_orders', default:
false, toggleable: true }` — off by default, mirroring `inventory.
assembly`'s own existing precedent (Phase 0 §17, VERIFIED) and satisfying
`ADR-055 §2`'s entitlement-vs-permission separation from the module's first
commit, not retrofitted later.

## 16. Numbering, audit, idempotency and transactional requirements

- **Numbering:** `WorkOrder.workOrderNumber` via the existing
  `NumberingService.getNextNumber('work_order')`, the identical mechanism
  `assembleProduct`'s own `assemblyReference` and every other numbered
  document in this codebase already uses (Phase 0 §6, VERIFIED).
- **Audit:** every state transition and every movement-producing action
  calls `AuditService.record(...)` inside the same transaction as the
  domain write, following `assembleProduct`'s own existing
  `inventory.assembly.completed` audit-action precedent (Phase 0 §6,
  VERIFIED) — new action names (`manufacturing.work_order.released`,
  `.material_issued`, `.material_returned`, `.finished_goods_received`,
  `.completed`, `.cancelled`) follow the same `<domain>.<resource>.<verb>`
  convention already used throughout.
- **Idempotency:** every Financial Event publish uses a deterministic key
  per §13's table — no Manufacturing movement can be double-posted by a
  retried request, matching the `UNIQUE(idempotencyKey)` guard on
  `accounting_financial_events` every other handler already relies on
  (Phase 0 §13, INFERRED from Wave 1's own established convention).
- **Transactional requirements:** every movement (§12), its Financial Event
  publish (§13), its reservation adjustment (§5), and its `WorkOrder`/
  `WorkOrderComponent` quantity updates happen inside **one** database
  transaction — partial application (e.g. stock moved but no Financial
  Event published, or vice versa) is not a permitted failure mode, matching
  `recordMovement`'s own existing "movements post together or not at all"
  discipline (Phase 0 §6, VERIFIED).

## 17. Month-End / reconciliation implications

**Deferred, not silently ignored.** Because D4 makes WIP a continuously-
valued real sub-warehouse balance (§6) rather than a period-end-only
computation, WIP does **not** require a new `ClosingAuditService`
reconciliation type the way GRNI did (Wave 1, `ADR-056`, cited read-only) —
a WIP sub-warehouse's balance is just ordinary inventory value, already
covered by whatever inventory reconciliation already exists (INFERRED — the
existing Inventory reconciliation type, one of Month-End's original five
per `ADR-051 §1`, cited read-only, was not re-opened this session to
confirm it would automatically include the new WIP sub-warehouses in its
scope; **this is flagged as requiring explicit confirmation during Phase 1
implementation, not assumed here**). If that confirmation finds a gap (the
existing Inventory reconciliation logic scoped to exclude sub-warehouses,
for instance), closing it is a Month-End-side fix, out of this contract's
own scope, to be raised the same way the GRNI/Month-End conflict was raised
and resolved (`ADR-056`) — not resolved unilaterally by whichever session
finds it.

## 18. Frontend operational workflow and required pages

New page set under `frontend/src/pages/manufacturing/` (matching every
existing domain's `pages/<domain>/*.tsx` convention, Phase 0 §20, VERIFIED/
INFERRED):

- `WorkOrders.tsx` — list + create (finished product, quantity, warehouse).
- `WorkOrderDetail.tsx` — shows the `WorkOrderComponent` snapshot, per-
  component issued/remaining quantities, running WIP balance, produced
  quantity, and the lifecycle action buttons (release, issue material,
  return material, record finished-goods output, hold/resume, complete,
  cancel) gated by the permission nodes in §15.
- A `ManufacturingCover.tsx` section-cover page, following the established
  `SectionCover` pattern (this session's own prior work on Accounting/HR
  covers, cited as established convention, not re-opened here) and a new
  `nav_group.manufacturing` sidebar entry in `Layout.tsx` — **not built by
  this document**; specified here only so Phase 1 implementation knows the
  required shape.
- **No new page for the legacy `assembleProduct` path** — per Phase 0 §20
  (VERIFIED — it has no frontend today) and this contract's own
  conservative scope, the legacy path's remediation (§14) is a backend
  correctness fix; whether it also finally gets a frontend page is a
  separate, smaller decision not bundled into this contract.

## 19. Migration/data requirements

New tables only — no existing table's schema changes (this contract touches
none of `bill_of_materials`, `bom_components`, `products`, or
`stock_movements`'s column shape):

- `work_orders`
- `work_order_components`
- New `ControlFunction` enum value `wip` (an additive enum-value migration,
  the same shape as `grni`'s own addition, Wave 1, cited read-only).
- Terminology seed migration(s) for every new nav/field/action/value code
  this contract's frontend (§18) and backend (§15) will need — following
  the exact idempotent `ON CONFLICT` pattern every terminology migration in
  this codebase already uses.

No seed data beyond terminology. No change to any HR-related table, and no
change to any Wave 1 (Procurement/Accounting/Month-End) table.

## 20. E2E acceptance matrix and explicit PASS criteria

1. Work Order created (`draft`) → released (`WorkOrderComponent` snapshot
   taken, matches live BOM at that instant, reservations created).
2. Material issued (partial) → component stock decreases in real warehouse,
   increases in WIP sub-warehouse, `Dr WIP/Cr Inventory` journal posted,
   balanced, traced end-to-end via direct Postgres queries (not HTTP 200s —
   this session's own established verification discipline, Wave 1, cited
   read-only).
3. Material returned (partial, ≤ issued) → exact reversal, costed at the
   WIP sub-warehouse's own current moving-average cost for that component
   at return time (§5, corrected), verified by direct query against F08's
   own moving-average state at that instant — **not** against the original
   issue's journal amount, which is not the correct basis once blending has
   occurred.
4. Finished Goods output (partial) → cost = `WIP(WO).value_before ÷
   remainingPlannedQty_before` at that exact output event (§7, corrected),
   `Dr Inventory/Cr WIP` journal posted, balanced, and the resulting
   `WIP(WO).value_after` verified against the same formula's hand-computed
   expectation. **Also verify the physical leg (§7, points 1–3):** for
   every `WorkOrderComponent`, the WIP sub-warehouse's on-hand physical
   quantity decreases by exactly `(quantityRequired_c ÷ quantityPlanned) ×
   outputQuantity`, verified by direct query against the stock-movement
   rows the single multi-line document produced — not merely that the
   dollar journal balances.
5. Full chain: `Work Order → Material Issue(s) → WIP → Finished Goods
   Output(s) → WIP balance returns to zero when quantityProduced ==
   quantityPlanned and no further issues occur` — traced end to end.
6. **Numerical multi-output proof (mandatory, mirrors §8 exactly):** a Work
   Order reproducing §8's worked example step for step — three Material
   Issues of the same component at three different real-warehouse costs
   (the third occurring **after** a partial Finished Goods output), one
   partial Material Return, and two partial Finished Goods Outputs whose
   combined quantity exactly reaches `quantityPlanned` at the §7 guard's
   exact boundary — run against live Postgres data, with every intermediate
   `WIP(WO).value` and every output's `unitCost_i`/`valueOutput_i` matching
   §8's figures to the cent (`$60.00 → $108.00 → $97.20 (post-return) →
   $38.88 (after FG Output #1) → $59.88 (after Material Issue #3) →
   $0.00`), FG Output #1 costed at `$9.72`/unit and FG Output #2 costed at
   `$14.97`/unit — the higher post-issue rate proving the mid-stream
   Material Issue correctly changed the cost basis of the remaining
   planned units (§7's costing-policy clarification) — and the total value
   of both partial outputs (`$58.32 + $59.88 = $118.20`) verified equal to
   total value issued net of the return (`$60.00 + $48.00 + $21.00 −
   $10.80 = $118.20`) by direct query — not by trusting the application
   layer's own arithmetic. Also verify, using the same Work Order's BOM
   ratio of 2.1 units of C per unit of F (`quantityRequired = 21`): the
   WIP sub-warehouse's physical on-hand quantity of C after each step
   matches §8's figures exactly (`12 → 12 → 20 → 18 → 5.4 → 8.4 → 0`), and
   total physical C issued net of the return (`21`) equals total physical
   C consumed across both outputs (`12.6 + 8.4 = 21`) by direct query.
   Also verify as part of the same run: an issue attempting
   `quantityIssued_before + issueQuantity > quantityRequired` is rejected
   (§5's guard); an output attempting `quantityProduced_before +
   outputQuantity > quantityPlanned` is rejected (§7's over-production
   guard); and an output attempting to consume more of a component than
   is physically on hand in that Work Order's WIP sub-warehouse is
   rejected (§7's physical-availability guard, point 4), even when
   neither of the other two guards would have blocked it.
7. No duplicate posting on retried issue/return/output calls (idempotency
   key re-delivery test, per movement type in §13's table).
8. Concurrent material issue against the same (warehouse, product) pair
   from two Work Orders — correctness verified under the existing advisory-
   lock discipline (§12), matching `ADR-053 §7`'s permanent multi-user
   correctness requirement.
9. Legacy `assembleProduct` (§14, if implemented in the same phase):
   pre-remediation historical rows unchanged; post-remediation assemblies
   produce the same `Dr WIP/Cr Inventory`/`Dr Inventory/Cr WIP` pair as a
   new Work Order's instantaneous case.
10. Existing Month-End Phase 1–8 tests re-run **unchanged** — confirms this
    contract's implementation did not silently alter Wave 1's already-frozen
    behavior (the same re-verification discipline `ADR-056` already
    required of GRNI's own Phase 8 addition, cited read-only).
11. Full regression suite.

**PASS criteria:** all eleven items above pass, with every Financial Event
in item 2/3/4/6 verified balanced (`Σdebit = Σcredit`) by direct query, not
merely "no error returned."

## 21. Explicit non-goals and deferred policies

Not in Phase 1, by ratified decision or explicit scope boundary — restated
here in one place for a single point of reference:

- Standard costing, cost variance, variance accounts/events/workflows (D3).
- Labor tracking, machine-hour tracking, overhead pools, allocation rules
  (D2).
- Routing, Operations, Work Centers (§4 — a direct consequence of D2).
- BOM versioning/effective-date ranges (§2 — the existing invariant is
  preserved, not extended).
- Subcontracting (Phase 0 §10 — not contemplated at all; no proposal made
  here either).
- Scrap/waste/yield accounting (Phase 0 §9 — not contemplated at all). A
  Work Order's `quantityProduced` may fall short of `quantityPlanned`, but
  §3's completion guard (`WIP(WO).value == 0` to complete) means the
  **only** legal Phase 1 mechanism to close such a Work Order is a Material
  Return of the unneeded component quantity (§5/§8) back into real,
  on-hand, dispensable stock. **This is only correct when the shortfall is
  genuine unused material.** If the shortfall is instead genuine physical
  scrap/spoilage — material actually consumed or destroyed in a failed
  production attempt, not physically returnable — Phase 1 has no way to
  distinguish that case from an ordinary return, and forcing a Material
  Return in that situation would incorrectly re-inflate the real
  warehouse's on-hand quantity and moving-average cost with material that
  no longer physically exists. This is a known, disclosed gap, not a
  silent omission: Phase 1 should only be used where genuine physical
  scrap is not expected, or where any such scrap is tracked outside this
  system, until a future phase adds a dedicated scrap/waste event and
  account — its own future, separately-ratified decision, not something
  this contract invents a workaround for.
- Quality-control gating (Phase 0 §16 — the Returns-domain Inspection-
  location pattern is not reused or generalized by this contract; a
  Manufacturing QC gate, if wanted, is a separate future proposal).
- Maker/checker approval on any Manufacturing action (§15 — none is
  introduced; may be revisited separately).
- Multi-branch/legal-entity Work Order scoping beyond whatever a Work
  Order's `warehouseId` already implies (Phase 0 §19 — explicitly a Wave 5
  concern, not Wave 4's).
- Any change to HR, `ADR-059`, or any Wave 1 (Procurement/Accounting/
  Month-End) file, schema, or ratified decision.

---

## 22. Explicit stop

Per the CTO's instruction: this document is the complete deliverable for
this task. No code, migration, schema, permission, or frontend change
follows from it in this session. Implementation does not begin until the
CTO explicitly reviews and approves this contract. Governance stage for
this task is **Resolve → Document → Verify → STOP**, not
Implement/Test/PASS. Production remains HOLD.
