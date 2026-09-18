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
VERIFIED in Phase 0 §1). Financial-event/GL integration (§12) is a Core/
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
`id`, `workOrderNumber` (via `NumberingService`, §15), `finishedProductId`,
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
  explicit state transitions over inferred ones).
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
§13) — never a direct `stock_movements` write, closing exactly the gap
Phase 0 §6/§11 identified in the legacy path. Partial issue (issuing less
than `quantityRequired` in one call, issuing across multiple calls) is
supported by construction — `WorkOrderComponent.quantityIssued` accumulates
per issue, the same way `PurchaseOrderLine.quantityReceived` already
accumulates across partial Goods Receipts (Phase 0 §12, INFERRED from the
established Procurement pattern).

**Consumption:** in this contract, "issue" and "consumption" are the same
event — once material is issued to a Work Order, it is by definition
consumed into WIP (there is no further "shelf" state between issue and
WIP, matching D4's continuous-valuation requirement: the moment material
leaves raw-material stock, it must already be a valued WIP asset, not an
un-costed limbo state).

**Return:** a new movement type `work_order_material_return` — the exact
reversal of an issue: increases the component's on-hand stock back in the
originating warehouse, decreases the Work Order's WIP balance, decreases
`WorkOrderComponent.quantityIssued`. **Must be costed at the same unit cost
the original issue used**, never a fresh moving-average recomputation at
return time — this is required specifically so a return-then-reissue cycle
cannot silently manufacture or destroy WIP value through two different cost
bases for the same physical units. A return may not exceed the Work Order's
own cumulative issued quantity for that component (a `WorkOrderComponent`-
scoped guard, mirroring the existing quantity-variance guard pattern Phase
0 §5 found already enforcing GRNI's own invariant as a side effect —
INFERRED as the same *kind* of guard, not a copy of GRNI's specific code).

## 6. WIP movement and valuation lifecycle

**WIP is modeled as a real, valued location — not a bare number.** Per D4
(continuous valuation) and reusing the existing sub-warehouse precedent
(Phase 0 §15, VERIFIED — the same mechanism that already gives every
Shipping Company/Vehicle an auto-created Operational Sub-location nested
under a real `Warehouse`): **each Work Order's execution warehouse gets (or
reuses) one auto-created WIP sub-`Warehouse`** (`parentWarehouseId` = the
real warehouse), and `work_order_material_issue` is, at the stock-movement
level, structurally a **transfer** into that WIP sub-warehouse (reusing
`transfer_in`/`transfer_out`-style semantics, Phase 0 §6/§15, INFERRED from
the established transfer mechanism) — **plus** the new GL/valuation
consequence §12 specifies, which a plain transfer does not carry. WIP's
"balance" at any moment is simply the on-hand stock value of that
sub-warehouse, computed the same way any warehouse's stock value is already
computed (INFERRED from `getStockReport`'s existing aggregation pattern,
Phase 0 §6/§11 citation) — no new balance-tracking table is required beyond
`stock_movements` itself, because the WIP sub-warehouse *is* the balance,
continuously, by construction (satisfying D4 without inventing a parallel
subledger the way, e.g., a from-scratch WIP ledger would have needed to,
per Phase 0 §4 Option A's own flagged cost).

**Finished Goods Receipt** (§7) is the reverse transfer: WIP sub-warehouse
→ the real target warehouse, crediting WIP and debiting Finished Goods
Inventory (§12), at a unit cost derived from the WIP sub-warehouse's own
accumulated balance for that Work Order (§7).

## 7. Finished Goods receipt and inventory integration

**New movement type `work_order_finished_goods_output`** — increases the
finished product's on-hand stock in the Work Order's real (non-WIP)
warehouse, decreases the WIP sub-warehouse's balance, increments
`WorkOrder.quantityProduced`. **Cost basis (D1, Actual/Moving Average):**
unit cost = (sum of all `work_order_material_issue` costs for this Work
Order to date, net of any `work_order_material_return`s) ÷
`quantityProduced` including this output event — i.e. a plain average over
everything issued into this Work Order so far, **not** a per-output-event
snapshot that would let early and late partial outputs from the same Work
Order carry different unit costs for materially the same recipe. This unit
cost is supplied as the `unitCostBase` input into `recordMovement`
exactly the way a Procurement Goods Receipt or Opening Stock import already
supplies one for a `'receipt'`-type movement (Phase 0 §8/§11, VERIFIED —
F08's *"ONE approved opening-stock/receipt cost-input flow"*) — reusing that
exact, existing mechanism rather than inventing a second one, per
`ADR-055 §10`.

**Partial output** (a Work Order producing less than `quantityPlanned` in
one event, or across multiple events before completion) is supported by
construction, mirroring §5's partial-issue support.

## 8. Actual/Moving-Average costing behavior (D1)

Confirmed, no new costing engine: every cost figure in this contract (issue
cost, WIP balance, finished-goods output cost) is either (a) read live from
the existing Moving Average engine (component issue cost) or (b) a plain
arithmetic roll-up of (a)-sourced figures (WIP balance, finished-goods
output cost) — there is no second costing method, no standard-cost field
anywhere in this contract's data model, and no code path that could produce
two different valid answers for "what did this cost" the way a
standard-vs-actual system would.

## 9. Explicit exclusion of Labor/Overhead absorption from Phase 1 (D2)

No labor-hour field, no machine-hour field, no overhead-rate config key, no
overhead-pool entity, and no allocation-rule mechanism appears anywhere in
this contract. Finished-goods output cost (§7) is material cost only, by
construction — there is no code path where a non-material cost could enter
the calculation, so there is nothing to accidentally invent here even at
the implementation-detail level.

## 10. Explicit exclusion of Standard Cost and Variance accounting from Phase 1 (D3)

No standard-cost field on `Product`, `BillOfMaterial`, or `WorkOrder`. No
variance-calculation code path (there is nothing to compare Actual cost
*against*, since no standard exists). No new GL account, control function,
Financial Event, or approval-request type for "variance" of any kind.
`WorkOrderComponent.unitCostAtRelease` (§3) is the **one** informational,
non-posting figure this contract includes that is adjacent to variance —
explicitly disclosed as informational-only, never read by any posting or
reconciliation code path, so it cannot silently become a variance
mechanism by accretion.

## 11. Inventory integration contract

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

## 12. Financial Event / GL integration contract

**No Manufacturing movement silently inherits "no GL entry."** Per the
CTO's explicit critical accounting requirement, every movement type is
specified in full below:

| Movement type | Inventory effect | Valuation effect | Financial Event | GL effect | Idempotency key | Transaction boundary |
|---|---|---|---|---|---|---|
| `work_order_material_issue` | Component stock −qty in real warehouse; +qty in WIP sub-warehouse | Cost = live moving-average of component at issue time (D1) | **YES** — new topic `manufacturing.work_order.material_issued` | `Dr WIP (control function 'wip', NEW) / Cr Inventory (control function 'inventory', EXISTING — same account `handleSupplierInvoicePosted` already resolves, Phase 0 §13)` | `manufacturing:work_order:<workOrderId>:material_issue:<issueLineId>` | Same transaction as the stock movement + reservation decrement; all-or-nothing |
| `work_order_material_return` | Component stock +qty in real warehouse; −qty in WIP sub-warehouse | Cost = the ORIGINAL issue's unit cost (§5 — never recomputed) | **YES** — new topic `manufacturing.work_order.material_returned` | `Dr Inventory / Cr WIP` (exact reversal of the issue leg) | `manufacturing:work_order:<workOrderId>:material_return:<returnLineId>` | Same transaction as the stock movement; all-or-nothing |
| `work_order_finished_goods_output` | Finished product stock +qty in real warehouse; −value in WIP sub-warehouse | Cost = cumulative WIP ÷ cumulative quantity produced (§7), supplied as `recordMovement`'s existing `unitCostBase` receipt-cost-input parameter | **YES** — new topic `manufacturing.work_order.finished_goods_received` | `Dr Finished Goods Inventory (control function 'inventory') / Cr WIP (control function 'wip')` | `manufacturing:work_order:<workOrderId>:fg_output:<outputEventId>` | Same transaction as the stock movement + `WorkOrder.quantityProduced` increment; all-or-nothing |

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

## 13. Legacy `assembleProduct` remediation boundary and compatibility behavior

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
  Financial-Event-publish mechanism §12 specifies for the new Work Order
  movement types — `Dr WIP / Cr Inventory` on consumption,
  `Dr Inventory / Cr WIP` on output, reusing the identical `wip` control
  function §12 introduces. This means a legacy "instant assembly" becomes,
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

## 14. Permissions, SoD and approval boundaries

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

## 15. Numbering, audit, idempotency and transactional requirements

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
  per §12's table — no Manufacturing movement can be double-posted by a
  retried request, matching the `UNIQUE(idempotencyKey)` guard on
  `accounting_financial_events` every other handler already relies on
  (Phase 0 §13, INFERRED from Wave 1's own established convention).
- **Transactional requirements:** every movement (§11), its Financial Event
  publish (§12), its reservation adjustment (§5), and its `WorkOrder`/
  `WorkOrderComponent` quantity updates happen inside **one** database
  transaction — partial application (e.g. stock moved but no Financial
  Event published, or vice versa) is not a permitted failure mode, matching
  `recordMovement`'s own existing "movements post together or not at all"
  discipline (Phase 0 §6, VERIFIED).

## 16. Month-End / reconciliation implications

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

## 17. Frontend operational workflow and required pages

New page set under `frontend/src/pages/manufacturing/` (matching every
existing domain's `pages/<domain>/*.tsx` convention, Phase 0 §20, VERIFIED/
INFERRED):

- `WorkOrders.tsx` — list + create (finished product, quantity, warehouse).
- `WorkOrderDetail.tsx` — shows the `WorkOrderComponent` snapshot, per-
  component issued/remaining quantities, running WIP balance, produced
  quantity, and the lifecycle action buttons (release, issue material,
  return material, record finished-goods output, hold/resume, complete,
  cancel) gated by the permission nodes in §14.
- A `ManufacturingCover.tsx` section-cover page, following the established
  `SectionCover` pattern (this session's own prior work on Accounting/HR
  covers, cited as established convention, not re-opened here) and a new
  `nav_group.manufacturing` sidebar entry in `Layout.tsx` — **not built by
  this document**; specified here only so Phase 1 implementation knows the
  required shape.
- **No new page for the legacy `assembleProduct` path** — per Phase 0 §20
  (VERIFIED — it has no frontend today) and this contract's own
  conservative scope, the legacy path's remediation (§13) is a backend
  correctness fix; whether it also finally gets a frontend page is a
  separate, smaller decision not bundled into this contract.

## 18. Migration/data requirements

New tables only — no existing table's schema changes (this contract touches
none of `bill_of_materials`, `bom_components`, `products`, or
`stock_movements`'s column shape):

- `work_orders`
- `work_order_components`
- New `ControlFunction` enum value `wip` (an additive enum-value migration,
  the same shape as `grni`'s own addition, Wave 1, cited read-only).
- Terminology seed migration(s) for every new nav/field/action/value code
  this contract's frontend (§17) and backend (§14) will need — following
  the exact idempotent `ON CONFLICT` pattern every terminology migration in
  this codebase already uses.

No seed data beyond terminology. No change to any HR-related table, and no
change to any Wave 1 (Procurement/Accounting/Month-End) table.

## 19. E2E acceptance matrix and explicit PASS criteria

1. Work Order created (`draft`) → released (`WorkOrderComponent` snapshot
   taken, matches live BOM at that instant, reservations created).
2. Material issued (partial) → component stock decreases in real warehouse,
   increases in WIP sub-warehouse, `Dr WIP/Cr Inventory` journal posted,
   balanced, traced end-to-end via direct Postgres queries (not HTTP 200s —
   this session's own established verification discipline, Wave 1, cited
   read-only).
3. Material returned (partial, ≤ issued) → exact reversal, at the original
   issue's cost basis, verified by comparing the return's journal amount to
   the specific issue journal it reverses.
4. Finished Goods output (partial) → cost = cumulative WIP ÷ cumulative
   produced at that moment, `Dr Inventory/Cr WIP` journal posted, balanced.
5. Full chain: `Work Order → Material Issue(s) → WIP → Finished Goods
   Output(s) → WIP balance returns to zero when quantityProduced ==
   quantityPlanned and no further issues occur` — traced end to end.
6. No duplicate posting on retried issue/return/output calls (idempotency
   key re-delivery test, per movement type in §12's table).
7. Concurrent material issue against the same (warehouse, product) pair
   from two Work Orders — correctness verified under the existing advisory-
   lock discipline (§11), matching `ADR-053 §7`'s permanent multi-user
   correctness requirement.
8. Legacy `assembleProduct` (§13, if implemented in the same phase):
   pre-remediation historical rows unchanged; post-remediation assemblies
   produce the same `Dr WIP/Cr Inventory`/`Dr Inventory/Cr WIP` pair as a
   new Work Order's instantaneous case.
9. Existing Month-End Phase 1–8 tests re-run **unchanged** — confirms this
   contract's implementation did not silently alter Wave 1's already-frozen
   behavior (the same re-verification discipline `ADR-056` already
   required of GRNI's own Phase 8 addition, cited read-only).
10. Full regression suite.

**PASS criteria:** all ten items above pass, with every Financial Event in
item 2/3/4 verified balanced (`Σdebit = Σcredit`) by direct query, not
merely "no error returned."

## 20. Explicit non-goals and deferred policies

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
- Scrap/waste/yield accounting (Phase 0 §9 — not contemplated at all; a
  Work Order's `quantityProduced` may fall short of `quantityPlanned` with
  no formal "scrap" event or account — this is a known, disclosed gap, not
  a silent omission, and would need its own future decision).
- Quality-control gating (Phase 0 §16 — the Returns-domain Inspection-
  location pattern is not reused or generalized by this contract; a
  Manufacturing QC gate, if wanted, is a separate future proposal).
- Maker/checker approval on any Manufacturing action (§14 — none is
  introduced; may be revisited separately).
- Multi-branch/legal-entity Work Order scoping beyond whatever a Work
  Order's `warehouseId` already implies (Phase 0 §19 — explicitly a Wave 5
  concern, not Wave 4's).
- Any change to HR, `ADR-059`, or any Wave 1 (Procurement/Accounting/
  Month-End) file, schema, or ratified decision.

---

## 21. Explicit stop

Per the CTO's instruction: this document is the complete deliverable for
this task. No code, migration, schema, permission, or frontend change
follows from it in this session. Implementation does not begin until the
CTO explicitly reviews and approves this contract. Governance stage for
this task is **Resolve → Document → Verify → STOP**, not
Implement/Test/PASS. Production remains HOLD.
