# Manufacturing / Production — Architecture Study (Phase 0)

**Status: STUDY / DESIGN PREPARATION ONLY.** No migration, no entity, no
controller, no UI, no schema change, no permission change, and no code
implementation is authorized by this document. This is an independent
workstream from Wave 1 (Procurement/GRNI/Month-End, CLOSED/ACCEPTED) and
from the HR Phase 0 study being handled by another session. No HR-related
file, no shared HR/Employee/Department implementation, and no Wave 1 file
was read for write purposes or modified to produce this document — the few
Wave 1 artifacts referenced below (GRNI, Financial Event mechanism, Closing
Audit) are cited read-only, as integration points a future Manufacturing
module would depend on. Production remains HOLD.

**ملخص تنفيذي (ar):** هذه دراسة معمارية فقط (Phase 0) للتصنيع/الإنتاج —
بدون أي تنفيذ. النتيجة الجوهرية: **لا توجد وحدة "تصنيع" في DAII اليوم على
الإطلاق** — لا Work Order، لا Routing، لا مراكز عمل، لا WIP، لا Scrap، لا
Subcontracting، لا رقابة جودة تصنيعية. الموجود فعليًا هو بدائي جدًا: قائمة
مكونات واحدة فقط لكل منتج (BOM بلا إصدارات ولا تواريخ سريان)، ودالة واحدة
`assembleProduct` تستهلك المكونات وتُنتج المنتج التام في **معاملة واحدة
لحظية** — بدون أي وثيقة Work Order، بدون حالة انتقالية (WIP)، **وبدون أي
تكامل محاسبي أو تقييم على الإطلاق** (تتجاوز آلية `recordMovement` المعتادة
تمامًا، فلا تُنشر أي Financial Event ولا يُسجَّل أي أثر تقييمي). هذا موثّق
بوضوح في الكود نفسه كقرار CTO سابق ("لا تبنِ نظام MRP/تصنيع كامل الآن").
الدراسة تحدد 20 نقطة تكامل مطلوبة، تصنّف كل واحدة (موجود/موجود جزئيًا/
مفقود/تعارض/سياسة غير محسومة)، وتقترح مسودة عقد تنفيذ للتصنيع **غير
مصدَّقة** — بانتظار قرارات السياسة المحاسبية والمعمارية المذكورة في §22.

---

## 0. Methodology and evidence tagging

Every factual claim below is tagged:

- **VERIFIED** — read directly from the current source file(s) named.
- **INFERRED** — derived from a VERIFIED fact plus established, already-cited
  codebase convention (e.g. "X follows the same pattern as Y, which was
  verified"), not itself independently opened and read line-by-line.
- **UNVERIFIED** — a reasonable expectation or open question this study
  raises, not confirmed either way by source inspection; flagged explicitly
  so it is never mistaken for a finding.

This study was produced by direct inspection of `release-new/backend/src`
(module manifests, domain source, migrations) and `release-new/frontend/src`
— not by re-reading planning documents that predate the current source
state, per this program's own established discipline (current code and
current ADRs outrank stale planning docs when they disagree).

---

## 1. Manufacturing bounded context

**VERIFIED — does not exist.** The full backend domain list is: `accounting,
commerce, crm, customer-finance, delivery, deposit-control, fulfillment, hr,
inventory-valuation, inventory-warehouse, procurement, reports, returns,
sales, sales-orders, shipment, tracking, treasury` (`backend/src/domains/`,
directory listing). No `manufacturing`, `production`, or equivalent
directory exists. The module-registry manifest list (`backend/src/foundation/
module-registry/manifests/index.ts`) is `sales, inventory, logistics,
finance, reporting, hr, accounting, procurement` — eight entitlement
modules, no ninth for Manufacturing.

The only Manufacturing-adjacent capability that exists — Bill of Materials —
is **not its own bounded context**. It lives physically under
`domains/commerce/` but is gated at the API layer by `@RequireModule('sales')`
and reuses the `sales.catalog.edit` permission node (`bom.controller.ts`,
VERIFIED, comment: *"no dedicated BOM node exists in `sales.manifest.ts`;
reuses `sales.catalog.edit`"*). The execution primitive
(`InventoryService.assembleProduct`) is gated by `inventory.assembly.create`,
a real permission node under the **`inventory`** module's manifest
(`inventory.manifest.ts`, VERIFIED — see §17). So today's closest thing to
"Manufacturing" is split across two *other* modules' entitlement surfaces,
owned by neither.

**Consequence for ADR-055 (Modular/Package/Entitlement/Permission
Contract):** a customer who licenses Inventory but never intended to buy
"Manufacturing" already has the assembly primitive available today (gated
only by a feature toggle, `default: false` — see §17), and a customer who
licenses Sales already gets BOM-definition rights. Neither is a violation of
anything ratified (assembly is disclosed as a Sales/Inventory-scoped V1 Gap
G-2 capability, not a Manufacturing module), but a real Manufacturing module
must not simply extend this ad-hoc placement — per ADR-055 §1/§7, it needs
its own bounded module and its own declared dependency contracts on
`sales` (Product/BOM) and `inventory` (stock movements), not a continuation
of borrowing their permission nodes.

## 2. Product/BOM relationship

**VERIFIED.** One `BillOfMaterial` row per finished product — `finishedProductId`
carries a **unique index** (`bill-of-materials.entity.ts`), i.e. a product
can be the finished output of at most one BOM, structurally enforced at the
database level, not just by convention. `BomComponent` rows
(`bom-component.entity.ts`) each reference a `componentProductId` and an
integer `quantityPerUnit` (whole units only — no fractional/weight-based
quantities). Both finished product and every component are validated to be
real `Product` rows via `ProductsService.getProductSnapshot`
(`bom.service.ts::defineBom`, VERIFIED) — but `Product`
(`commerce/infrastructure/product.entity.ts`, VERIFIED) has **no field
distinguishing raw material / component / finished good / semi-finished** —
every product is the same flat shape (`sku`, `name`, `unitPrice`, `unit`
[a free-text label, explicitly **not** a UoM-conversion engine — see §3],
`status`). A component and a finished product are structurally
indistinguishable except by which BOM references them.

**Status: PARTIALLY EXISTS.**

## 3. BOM versions and effective dates

**VERIFIED — does not exist, and is explicitly, deliberately excluded.**
`bill-of-materials.entity.ts`'s own doc comment states: *"V1 simplicity — no
versioning, no effective-date ranges, no alternate/optional components"* and
cites `EXCEL_BUSINESS_MAPPING_PACKAGE.md §3B/§4/§21` and a CTO handover
directive §15: *"Do NOT build a full MRP/manufacturing ERP now."*
`bom.service.ts`'s `defineBom` is documented as **create-or-replace**: editing
a BOM deletes all prior component rows and inserts the new set in the same
transaction (VERIFIED) — there is no history of what a BOM *was* at any
past point, and no way to know which BOM revision a historical assembly
transaction actually consumed under. A `StockMovement` referencing an
`assembly` only carries `referenceType`/`referenceId` (the assembly run's own
number) — VERIFIED (see §11) — it does not carry a BOM-version identifier,
because none exists to carry.

**Status: MISSING (by explicit prior design decision, not oversight).**
**Consequence:** a real Manufacturing module needs to decide whether it
introduces BOM versioning (a schema change to an existing, currently
V1-frozen table) or treats the *current* flat BOM as immutable-at-point-of-
consumption in a different way (e.g., snapshotting the recipe onto the Work
Order at release time, never re-reading the live BOM once a Work Order
exists) — this is a real design decision, not a trivial extension, precisely
*because* the existing table was built with an explicit non-negotiable
uniqueness constraint assuming exactly one current recipe per product.

## 4. Routing / operations / work centers

**VERIFIED — does not exist.** No file, entity, or reference to routing,
operations sequencing, or work centers exists anywhere in
`backend/src/domains` or `backend/src/foundation` (repository-wide search).
`assembleProduct` has no concept of a sequence of operations, no labor/time
element, and no work-center/resource assignment — it is a single all-at-once
stock transformation.

**Status: MISSING.**

## 5. Work Orders and lifecycle

**VERIFIED — does not exist.** There is no `WorkOrder`/`ProductionOrder`
entity, no controller, no process definition. Compare with how every other
document-with-a-lifecycle in this codebase is built:
`FISCAL_YEAR_PROCESS`/`FISCAL_PERIOD_PROCESS` (`accounting/domain/
process-definitions.ts`), the Purchase Order/Goods Receipt/Supplier Invoice
process definitions (`procurement/domain/*-process.ts`, INFERRED from the
established pattern — not individually re-opened this session, but their
existence and naming convention was directly observed in `domains/
procurement/domain/` during §1's directory listing) — every one of these
uses `foundation/process-engine`'s `ProcessDefinition` mechanism (explicit
named states, explicit legal transitions, live state read via
`ProcessEngineService.getState`, never a denormalized status column). A
Work Order is exactly this same shape of thing (draft → released → in
progress → completed/closed, with a cancel/hold path) and **has zero
existing implementation to extend** — it would be a wholly new
`ProcessDefinition`, following an extremely well-established in-repo
convention, not inventing a new state-machine mechanism.

**Status: MISSING.** **Not a gap in the sense of "broken" — a gap in the
sense of "genuinely not started."**

## 6. Material reservation and consumption

**PARTIALLY EXISTS — VERIFIED, with an important caveat.** Material
*reservation* as a general mechanism is real and mature: `stock_reservations`
(status `active`/`preliminary`/etc., referenced throughout
`inventory.service.ts`, VERIFIED) is the same reservation table Sales Orders
already use (`reserveStock`/`reserveStockInTransaction`, VERIFIED — these are
generic, not Sales-specific, methods on `InventoryService`) — a Work Order
could plausibly reserve raw materials against a Work Order reference exactly
the way a Sales Order reserves finished goods against a sales-order
reference, reusing this table and its existing
`getAvailableInTransaction`/advisory-lock concurrency discipline (VERIFIED,
`inventory.service.ts` lines ~254-264 and the `pg_advisory_xact_lock` calls
inside `assembleProduct`, lines ~1201-1205) rather than inventing a second
reservation mechanism.

*Consumption*, however, as it exists today (`assembleProduct`), does **not**
go through the reservation table or through `recordMovement` at all — it
checks availability inline (on-hand minus reserved, computed fresh inside
the same transaction) and then writes `StockMovement` rows **directly via
`manager.getRepository(StockMovement).save(...)`**, bypassing
`InventoryService.recordMovement` entirely (VERIFIED, `inventory.service.ts`
lines ~1228-1257 call `movementRepo.save` directly, never
`this.recordMovement`). This matters concretely: `recordMovement` is the
**single funnel** every other movement-creating path in this codebase goes
through (VERIFIED by its own doc comment, line ~158: *"this document's
movements post together or not at all, never partially"*, and it is the
place F08 valuation and F07 GL-event publishing both hook in — see §11/§13).
Assembly's direct-write path means it silently skips both hooks, not by a
documented policy decision (unlike GRNI's receipt-vs-dispatch GL asymmetry,
which *is* a disclosed, ratified decision — ADR-040/041/054) but simply
because `assembleProduct` predates and was never wired through the funnel.

**Status: PARTIALLY EXISTS (reservation: reusable; consumption: exists but
architecturally bypasses the funnel every other domain uses).**

## 7. WIP (Work In Process)

**VERIFIED — does not exist as a concept at all.** There is no WIP account,
no WIP inventory state, no intermediate location, and no time gap between
"consume materials" and "produce finished good" in the current
implementation — `assembleProduct` does both atomically in one transaction
(VERIFIED, §6 above). There is genuinely nothing to build on; WIP is a Wave
4 concept the current codebase has zero precedent for, unlike, say, GRNI
(Wave 1), which had the `PurchaseOrderLine` quantity-tracking columns to
reuse (ADR-057 §0, cited for context — Wave 1, read-only reference, not
modified here).

**Status: MISSING.**

## 8. Finished Goods receipt

**PARTIALLY EXISTS.** `assembleProduct`'s `assembly_output` movement
(VERIFIED, `movement-type.ts` line 39, `inventory.service.ts` line 1252) *is*
a finished-goods-receipt-equivalent — it increases on-hand stock of the
finished product in the target warehouse. But it is unconditional and
immediate (no QC gate, no partial-completion concept — an assembly is
all-quantity-at-once) and, per §11, carries **no cost/valuation** at all,
unlike a real Goods Receipt (Procurement) which the Moving-Average valuation
engine explicitly hooks (`recordReceiptCost`, F08/ADR-041, VERIFIED via
`inventory.service.ts` lines ~213-214). A Manufacturing Finished-Goods
receipt would need to determine the finished item's cost from consumed
material cost (+ any labor/overhead policy, §14) — a genuinely new
computation this codebase has no equivalent of anywhere (Moving Average
today only ever *receives* a cost as an input, it never *derives* one from
component costs).

**Status: PARTIALLY EXISTS (the movement exists; the valuation does not).**

## 9. Scrap / waste / yield

**VERIFIED — does not exist.** No scrap/waste/yield field, movement type, or
concept anywhere. `assembleProduct` assumes 100% yield: N units of finished
good always consume exactly `quantityPerUnit × N` of each component, with no
provision for a spoiled/scrapped quantity, a yield percentage, or a
byproduct.

**Status: MISSING.**

## 10. Subcontracting

**VERIFIED — does not exist.** Zero references anywhere in the backend
source to subcontracting, outside processing, or a "send materials to a
third party, receive finished/processed goods back" flow. Procurement's
Purchase Order → Goods Receipt flow (Wave 1) is the closest conceptual
relative (materials leave the company's control and something is received
back), but it has no linkage to BOM/component-consumption at all today — a
subcontracted operation would need to combine Procurement's supplier-facing
document flow with Manufacturing's material-consumption concept, a genuine
cross-domain design this study surfaces but does not resolve.

**Status: MISSING. Not contemplated by the current architecture in any form.**

## 11. Inventory integration and movement provenance

**VERIFIED, with a real gap.** Every stock-affecting operation in this
codebase *except* assembly goes through `InventoryService.recordMovement`,
the single funnel that: (a) is the only writer of `stock_movements`
"through the front door," (b) optionally applies F08 valuation for
`movementType === 'receipt'`, and (c) publishes a GL-bound Financial Event
when `movementType` is in `INVENTORY_GL_MOVEMENT_TYPES` — a set containing
**only `'dispatch'`** today (VERIFIED, `inventory.service.ts` line 29, with
its own doc comment: *"no accounting mapping is defined for [other types]
yet... extending this set is a later decision, not something to change
silently"*). `assembleProduct` does not call `recordMovement` — it writes
`assembly_consumption` (negative) and `assembly_output` (positive) movements
directly (§6). Provenance *within* `stock_movements` is fine — both movement
rows correctly share `referenceType: 'assembly'` / `referenceId:
<assemblyReference>` (a real, sequential number via `NumberingService`,
VERIFIED) — so an assembly's own consumption and output rows are traceable
to each other and to the BOM that produced them. What is **not** traceable
is any accounting or valuation consequence, because none is ever created
(§13).

**Status: PARTIALLY EXISTS.** The ledger-append/provenance discipline is
followed for the movement rows themselves; the GL/valuation funnel is
architecturally bypassed, not merely "not yet extended" the way `dispatch`-
only `INVENTORY_GL_MOVEMENT_TYPES` is (that set is *designed* to be extended
later through `recordMovement`; assembly doesn't even reach the point where
extending that set would matter, since it never calls `recordMovement` at
all).

## 12. Procurement integration for raw materials

**EXISTS, cleanly, at the data-model level; MISSING at the process level.**
Procurement's `PurchaseOrderLine` references a generic `productId`
(INFERRED from Wave 1 context established this session — `ADR-057`'s own
text confirms `PurchaseOrderLine.quantityReceived`/`.quantityInvoiced` are
per-line and product-keyed; not re-opened this session to avoid touching
Wave 1 files unnecessarily). Since `Product` has no raw-material/finished-
good distinction (§2), **any** product — including one that is a BOM
component — can already be purchased through the existing, fully-built
Procurement → GRNI → AP chain today, with no code change required for that
base linkage to work. What does **not** exist is anything connecting the
two domains operationally: no automatic "this Work Order needs N units of
component X, which is short by M — raise a Purchase Requisition" flow
(classic MRP netting), and no reservation of an *incoming* Purchase Order's
expected receipt against a Work Order's material requirement. Building that
would be a new, first-of-its-kind cross-domain contract between a future
`manufacturing` module and `procurement` — per ADR-055 §7, it must be a
declared dependency contract, never a hard import of Procurement internals
into Manufacturing or vice versa.

**Status: PARTIALLY EXISTS (the underlying product/purchasing link is
free; the demand-driven procurement trigger is not built and has no
precedent anywhere in this codebase to reuse).**

## 13. Accounting/GL integration boundaries

**VERIFIED — does not exist for assembly today; a clean boundary mechanism
exists and is directly reusable.** As established in §6/§11, assembly
publishes **zero** Financial Events and touches **zero** GL accounts today.
This is a real, current-state gap, not a policy choice on record anywhere
(unlike GRNI's receipt/invoice asymmetry, which *is* a recorded, ratified
choice — ADR-040/041/054, Wave 1, cited read-only).

The reusable mechanism, however, is exactly the one Wave 1 just proved out
end-to-end: `EventBusService.publish(manager, topic, payload)` inside the
same transaction as the domain write, with a deterministic idempotency key,
consumed by a registered handler in `FinancialEventHandlerRegistry`, which
resolves GL accounts via **control functions**
(`ctx.resolveControlAccount('inventory' | 'grni' | ...)`) rather than
hard-coded account IDs (VERIFIED as the established pattern this session
via `ADR-057`, Wave 1; the mechanism itself — `FinancialEventService`,
`EventBusService`, the control-function resolution — is Foundation-owned,
not Procurement-owned, so referencing it here is citing shared
infrastructure, not touching Wave 1's own files). A Manufacturing module
would very likely need at least two new control functions analogous to
`grni`'s addition in Wave 1 — a `wip` control account (§7/§14) and possibly
a `production_variance` account (§14) — added the same way `grni` was: a new
named value in the existing `ControlFunction` enum plus a chart-of-accounts
seed, not a new mechanism.

**Status: MISSING (assembly's own integration) / mechanism to reuse: EXISTS
and is proven (Wave 1).**

## 14. Manufacturing costing and variance

**Policy questions only — not resolved here, per this study's own scope
restriction.** What is VERIFIED about the *existing* costing mechanism:
Inventory valuation in this codebase is **Moving Average** (`F08`, `Moving
AverageCostEngine` — INFERRED from the class name referenced in Wave 1's
`ADR-057 §10`/`§0` and this session's own §11/§8 findings; the file itself
was not re-opened this session). It is a *received-cost-in, weighted-
average-out* engine — it has never derived a cost from a bill of materials,
because nothing has ever asked it to.

**Policy questions this study surfaces, explicitly not answered:**

1. **Standard costing vs. actual costing for Work Orders.** Does a
   Manufacturing module cost a finished good at (a) the live moving-average
   cost of its components at consumption time (actual costing — consistent
   with how the rest of this codebase already values everything, no new
   costing *method* introduced), or (b) a predetermined standard cost with a
   variance account (a genuinely new costing method for this codebase)?
2. **Labor and overhead absorption.** Is finished-goods cost = component
   cost only (a pure material roll-up, matching the "do not over-engineer
   V1" precedent already set for BOM/UoM), or does it include labor/overhead
   allocation (which would require new inputs — labor hours, an overhead
   rate — this codebase has no existing concept of either)?
3. **Variance recognition.** If any standard-cost element exists, where does
   the variance post — a dedicated `production_variance` P&L account
   (new), or absorbed into COGS at a later point? This is exactly the kind
   of accounting-policy decision `ADR-054`'s own precedent (GRNI Option A
   vs. B) shows must go to the CTO explicitly, not be inferred by whichever
   session builds this first.
4. **WIP valuation timing.** Is WIP valued continuously (a running balance
   that needs its own moving-average-style tracking) or only at period-end
   (a Month-End-time computation, which would make WIP a **new**,
   seventh reconciliation type for `ClosingAuditService`, alongside the six
   Wave 1 just finished — AR/AP/Cash-Bank/Inventory/Fixed-Asset/GRNI,
   ADR-056, cited read-only)?

**Status: POLICY UNRESOLVED on all four points. No accounting policy is
invented by this document, per the assignment's explicit instruction.**

## 15. Warehouse integration

**EXISTS, with a directly reusable precedent.** `Warehouse` rows support a
self-referencing `parentWarehouseId` for genuine sub-locations — VERIFIED,
`warehouse.entity.ts`: *"every Shipping Company / Company Vehicle gets an
auto-created Operational Sub-location nested under a real warehouse, so
custody transfers are ordinary... transfers between two real `Warehouse`
rows — never a parallel stock system."* This is a strong, concrete precedent
for how a "WIP location" or "production floor" concept could be modeled
without a new location/bin entity: an auto-created sub-warehouse per
production line or work center, with material consumption and finished-
goods output modeled as ordinary transfers into/out of it, reusing
`WarehouseTransactionsService`'s existing transfer mechanism (INFERRED —
the transfer mechanism itself was read in §6's citation of
`inventory.service.ts`'s `transfer_in`/`transfer_out` movement types, not
independently re-verified for this specific hypothetical use).

**Status: EXISTS (a real, reusable modeling precedent — not a built
Manufacturing capability, but a strong architectural option).**

## 16. Quality-control integration

**VERIFIED — Manufacturing QC does not exist; an analogous precedent exists
in a different domain.** `movement-type.ts` documents an "Inspection
sub-location" for the **Returns** domain (VERIFIED comment: *"Returns Engine
(CTO directive, Returns/Inspection Location)... analogous to `receipt` —
stock appearing from an external event, just not a purchase"*) — a real,
working pattern for "goods sit in a special location pending a
pass/fail decision before moving to their real destination." This is a
directly transferable pattern for a Manufacturing QC gate (e.g., finished
goods land in an Inspection sub-location before being transferred to
general stock), but it is a **Returns-domain feature today, not a shared
Foundation capability** — reusing it for Manufacturing would mean either
generalizing it into Foundation first (the ADR-055-compliant path) or
duplicating the pattern in a new Manufacturing-owned mechanism (a
disclosed, deliberate duplication, per ADR-055 §10's "reuse before creating
new infrastructure" rule — this would need justification either way, not a
silent choice).

**Status: MISSING for Manufacturing specifically; a reusable pattern EXISTS
elsewhere.**

## 17. Permissions and segregation of duties

**VERIFIED.** Current state, in full, from `inventory.manifest.ts`:

```
{ node: 'inventory.assembly', title_code: 'perm.inventory.assembly', parent: 'inventory' }
{ node: 'inventory.assembly.create', title_code: 'perm.inventory.assembly.create', parent: 'inventory.assembly' }
```

One node. No `.view`, no `.reverse`, no `.approve` — a single "can execute
an assembly" permission, all-or-nothing. The corresponding feature code:

```
{ code: 'inventory.assembly', title_code: 'feat.inventory.assembly', default: false, toggleable: true }
```

`default: false` — assembly is **already** entitlement-gated as an optional,
non-default feature under the `inventory` module (a genuinely good,
ADR-055-§2-consistent precedent: an installation without this feature
enabled simply cannot call the endpoint — INFERRED from the established
`RequireFeatureGuard` pattern used elsewhere in this codebase, e.g. F11's
`accounting.financial_dimensions`, not independently re-verified for this
exact feature code this session). What is genuinely **missing** relative to
every other sensitive, financially-adjacent operation in this codebase
(AR/AP/Cash-Bank/Fixed-Asset adjustments, all Wave 1) is any **maker/checker
approval gate** — assembly executes immediately on one person's permission,
with no FA-01 (Approval Engine) involvement at all, unlike, say, an AR
write-off of comparable business significance.

**Status: PARTIALLY EXISTS (entitlement-gating precedent is good and
reusable; permission granularity and approval-gating for a real
Manufacturing module's many new actions — Work Order release, material
issue, finished-goods receipt, scrap write-off — all need to be designed
from scratch, following the `procurement.*`/`accounting.*` fine-grained
node convention ADR-055 §6 already mandates).**

## 18. Approval workflows

**VERIFIED — none exist for assembly; the reusable engine is proven.**
`assembleProduct` has no FA-01 involvement (§17). The Approval Engine itself
(`foundation/approval-engine`) is domain-neutral and already proven across
five-going-on-more request-type families (AR/AP/Cash-Bank/Fixed-Asset/GRNI-
adjacent fiscal closing, Wave 1) — a Manufacturing module needing
maker/checker on, for example, a large negative scrap write-off or a
Work Order cost override would register new request types the exact same
way every Wave 1 domain's `onModuleInit` already does (`registerRequestType`
+ `upsertMatrixRule`, self-registering its own default matrix rule — the
established, current-as-of-2026-09-18 pattern per this session's own
Wave 1 findings, cited read-only).

**Status: MISSING for Manufacturing (no request types registered yet) /
mechanism to reuse: EXISTS and is proven.**

## 19. Organization/branch/legal-entity dependencies

**VERIFIED — assembly is not organization-scoped at all today.**
`BillOfMaterial`/`BomComponent` have no `orgUnitId` column (VERIFIED,
full entity field lists in §2/§3). `assembleProduct`'s signature —
`(warehouseId, finishedProductId, quantity, actorUserId)` — carries no
`orgUnitId` parameter at all (VERIFIED, `inventory.service.ts` line 1184-
1189), unlike essentially every Accounting-domain write this session
touched in Wave 1, which threads `orgUnitId` throughout (ADR-031 scoping,
cited as established convention, not re-verified independently this
session). A `Warehouse` row, however, *can* imply an organizational
location (its `parentWarehouseId`/physical `location` field, §15) — so
today's *implicit* scoping for assembly is "whichever warehouse you assemble
in," not an explicit org-unit grant. Whether a Manufacturing module needs
true multi-branch/multi-legal-entity Work Orders (§7 of ADR-053's own Wave 5
"Multi-Company" item) is **out of scope for Wave 4** per the roadmap
sequencing already ratified — this study flags it only so Wave 4's design
doesn't accidentally foreclose Wave 5 by hard-coding a single-org
assumption where the existing `orgUnitId` convention could be threaded in
for free now.

**Status: PARTIALLY EXISTS (implicit via warehouse; no explicit
organization/legal-entity model for Manufacturing documents).**

## 20. Frontend operational workflow

**VERIFIED — does not exist.** `frontend/src/pages/Bom.tsx` (repository
search, this session) only handles defining a BOM's recipe — no reference
to "assemble," "assembly," or any call to `POST /inventory/assemble`
anywhere in the frontend source. The backend capability
(`inventory.assembly.create`) has **zero UI surface** — even the one
primitive capability that exists today cannot be triggered from the
application at all, only via direct API call. A real Manufacturing frontend
(Work Order list/create/detail, material issue screen, WIP dashboard,
finished-goods receipt confirmation) is a full, new frontend surface with
no existing page to extend, following the same page/route/nav-entry pattern
every other module in this codebase already uses (INFERRED — the
established `pages/<domain>/*.tsx` + `App.tsx` route + `Layout.tsx` nav-item`
convention this session's own earlier work in this same repo already
followed for Accounting/HR, not re-verified independently for this specific
claim since it is this session's own prior, directly-observed work).

**Status: MISSING.**

---

## 21. Gap Matrix

| # | Area | Status | Evidence |
|---|---|---|---|
| 1 | Manufacturing bounded context | **MISSING** | VERIFIED — no domain, no manifest |
| 2 | Product/BOM relationship | **PARTIALLY EXISTS** | VERIFIED — flat 1:1 BOM, no product classification |
| 3 | BOM versions/effective dates | **MISSING** (by design) | VERIFIED — explicit V1 exclusion in source comment |
| 4 | Routing/operations/work centers | **MISSING** | VERIFIED — zero references anywhere |
| 5 | Work Orders and lifecycle | **MISSING** | VERIFIED — no entity, no process definition |
| 6 | Material reservation & consumption | **PARTIALLY EXISTS** | VERIFIED — reservation reusable; consumption bypasses the funnel |
| 7 | WIP | **MISSING** | VERIFIED — no concept exists |
| 8 | Finished Goods receipt | **PARTIALLY EXISTS** | VERIFIED — movement exists, no valuation |
| 9 | Scrap/waste/yield | **MISSING** | VERIFIED |
| 10 | Subcontracting | **MISSING** | VERIFIED |
| 11 | Inventory integration/provenance | **PARTIALLY EXISTS** | VERIFIED — movement provenance OK, GL/valuation funnel bypassed |
| 12 | Procurement integration (raw materials) | **PARTIALLY EXISTS** | VERIFIED (data link) / MISSING (process link) |
| 13 | Accounting/GL integration boundary | **MISSING** (assembly) / mechanism **EXISTS** | VERIFIED |
| 14 | Costing and variance | **POLICY UNRESOLVED** | N/A — explicitly not decided here |
| 15 | Warehouse integration | **EXISTS** (reusable precedent) | VERIFIED |
| 16 | Quality-control integration | **MISSING** (Manufacturing) / precedent **EXISTS** (Returns) | VERIFIED |
| 17 | Permissions / segregation of duties | **PARTIALLY EXISTS** | VERIFIED — one coarse node, no maker/checker |
| 18 | Approval workflows | **MISSING** (Manufacturing) / engine **EXISTS** | VERIFIED |
| 19 | Organization/branch/legal-entity | **PARTIALLY EXISTS** | VERIFIED — implicit via warehouse only |
| 20 | Frontend operational workflow | **MISSING** | VERIFIED |

No **CONFLICT** was found — nothing a future Manufacturing module needs
contradicts an existing ratified decision. The one item flagged as a soft
compliance note (not a conflict) is §1's observation that today's assembly
primitive sits under `sales`/`inventory` entitlement rather than its own
module, which predates ADR-055 and is not itself a violation of it.

---

## 22. Dependencies on existing Wave 1 / Foundation contracts

A future Manufacturing implementation contract will need to explicitly
declare (per ADR-055 §7 — dependency, not hard import) on:

- **Inventory** (`inventory-warehouse` domain) — `recordMovement`'s funnel
  (to actually integrate, unlike today), the reservation table, the
  sub-warehouse/parent-warehouse pattern for a WIP location.
- **Commerce** (`sales` domain, BOM's actual home today) — Product,
  BillOfMaterial/BomComponent, whether BOM versioning is added here or a
  new Manufacturing-owned recipe concept supersedes it.
- **Procurement** — for raw-material purchasing and any future MRP-style
  requisition trigger (§12) — an entirely new integration contract, nothing
  to extend today.
- **Accounting Foundation** (Financial Event mechanism, control functions,
  `FinancialEventHandlerRegistry`) — proven reusable by Wave 1, not
  Manufacturing-specific infrastructure.
- **Approval Engine (FA-01)** — proven reusable by Wave 1.
- **Month-End Closing / `ClosingAuditService`** — only if WIP or a
  Manufacturing variance account is deemed to need period-end reconciliation
  (§14 policy question 4) — this would be a Phase-9-style additive
  extension to the same contract Wave 1's GRNI work just extended as Phase 8
  (ADR-056, cited read-only, not modified).
- **GRNI specifically** — no direct dependency found. Manufacturing raw-
  material procurement would flow through the *existing* GRNI-integrated
  Goods Receipt path (Wave 1) exactly as any other Procurement purchase
  does; Manufacturing does not need its own GRNI-equivalent for materials it
  buys, only (per §14) possibly needs its own WIP-equivalent for materials
  it *consumes* internally.

None of these are code dependencies today — they are integration points a
Manufacturing Phase 1+ implementation contract would need to bind to,
exactly as ADR-057 bound to Wave 1's existing `SUPPLIER_LEDGER_CONTRACT`
pattern rather than inventing a new one.

---

## 23. Proposed Manufacturing Implementation Contract — DRAFT, NOT RATIFIED

This section is a **starting proposal only**, offered so the CTO has a
concrete shape to react to. It is explicitly not an ADR, not approved, and
not to be treated as authorization for any implementation. Every numbered
item below is a proposal, not a decision.

1. **New module `manufacturing`**, its own manifest
   (`manufacturing.manifest.ts`), joining `ALL_MODULE_MANIFESTS` — per
   ADR-055 §1/§3, not a continuation of borrowing `sales`/`inventory` nodes.
   Declares `depends_on: ['sales', 'inventory']` at minimum (entitlement
   dependency, per ADR-055 §7 / the existing `accounting.manifest.ts`
   `depends_on: ['finance']` precedent).
2. **BOM ownership question**: either (a) migrate `BillOfMaterial`/
   `BomComponent` from `commerce` into the new `manufacturing` domain
   (a real migration of existing, populated tables — needs its own
   migration-safety plan), or (b) leave BOM in `commerce`/`sales` as
   master-data Manufacturing merely *reads* (via a cross-domain contract,
   the same `SalesBomContract` pattern already in place today,
   VERIFIED — `bom.service.ts` already `implements SalesBomContract`). **(b)
   is the lower-risk option** and this study leans toward recommending it,
   but does not decide it.
3. **`WorkOrder` as a genuine `ProcessDefinition`** (Foundation
   process-engine, matching `FISCAL_YEAR_PROCESS`'s shape): states at
   minimum `draft → released → in_progress → completed`, plus
   `cancelled`/`on_hold` side-branches — exact transition graph TBD in a
   Phase 1 contract, not here.
4. **Material consumption goes through `recordMovement`**, not a direct
   `stock_movements` write — closing the exact gap §6/§11 identified. New
   movement types (`work_order_consumption`/`work_order_output` or similar)
   would need to join `MovementType`'s existing union, same mechanism as
   Wave 1's `assembly_consumption`/`assembly_output` — reuse the mechanism,
   not the specific types (a Work Order is a materially different document
   from an instant assembly and should not silently overload the existing
   Gap-G-2 types).
5. **New control functions**: `wip` (mandatory if WIP is modeled at all,
   §7/§14) and `production_variance` (only if a standard-costing policy is
   chosen, §14 policy question 3) — added to the existing `ControlFunction`
   enum the same way `grni` was added in Wave 1, not a new resolution
   mechanism.
6. **Costing method: explicitly deferred to the CTO** — this contract draft
   takes no position on §14's four open policy questions. Whatever is
   decided, it should be recorded the same way ADR-054 recorded GRNI's
   policy: a dedicated ADR, before implementation begins, not inferred by
   whichever session builds this first.
7. **Fine-grained permission nodes** from the first commit, per ADR-055 §6:
   e.g. `manufacturing.work_order.view/create/release/complete/cancel`,
   `manufacturing.material_issue.create`, `manufacturing.scrap.create`
   (maker/checker candidate if scrap value crosses a threshold, mirroring
   the AR/AP adjustment precedent), `manufacturing.bom.view/create/edit` if
   BOM ownership moves per item 2(a).
8. **WIP location via the existing sub-warehouse pattern** (§15) —
   auto-created sub-`Warehouse` per work center/production line, reusing
   `WarehouseTransactionsService`, not a new location/bin entity — proposed
   as the lower-effort, higher-reuse option; not the only option.
9. **QC gate, if required, via a new Manufacturing-owned Inspection
   sub-location**, deliberately modeled after (not shared code with, unless
   a Foundation generalization is separately approved) the Returns domain's
   existing Inspection-location pattern (§16) — per ADR-055 §10, this
   duplication-vs-generalization choice should be disclosed and justified
   in the eventual Phase 1 contract, not silently one or the other.
10. **Month-End integration only if WIP/variance is stateful across period
    boundaries** (§14 policy question 4) — if so, proposed as an additive
    Phase 9 to the existing Month-End contract (ADR-051 + ADR-056), exactly
    matching how GRNI became Phase 8 rather than a parallel closing engine.

**This draft resolves zero of §14's policy questions and authorizes zero
implementation.** Its only purpose is to give the next decision point (a
real Manufacturing Phase 1 Implementation Contract, if and when the CTO
greenlights one) a concrete starting shape grounded in what this codebase
already has, rather than a blank page.

---

## 24. Explicit stop

Per this assignment's own instruction: this document is the complete Phase
0 deliverable. No implementation, migration, UI work, or permission change
follows from it in this session. No Wave 1 file and no HR-related file was
modified to produce this study. Production remains HOLD.
