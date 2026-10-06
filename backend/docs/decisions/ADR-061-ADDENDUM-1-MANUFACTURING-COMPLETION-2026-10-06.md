# ADR-061 Addendum 1 — Manufacturing Module Completion (CTO Master Directive 2026-10-06)

**Status:** ACTIVE — authority is the CTO "MANUFACTURING FULL MODULE COMPLETION" master directive (2026-10-06).
**Scope:** records every place where the directive extends or supersedes the *text* of ADR-061 (Phase 1 contract). ADR-060 D1–D5 are **untouched**. The verified Work Order lifecycle (ADR-061 §3/§5/§6/§7/§8/§13, commits `a1c929c`/`466c026`) is **not redesigned**.

## A1. Routing / Operations / Work Centers — built as NON-COSTING master data
ADR-061 §4/§21 excluded Routing/Operations/Work Centers "by ratified policy D2, not by omission" and said they become necessary only "via its own CTO-ratified decision". The master directive (§3 D/E, §4) orders them built. This addendum is that decision, bounded by D2/D3:

* Routing, Operation and Work Center are **sequencing / assignment master data only**.
* **No** labor-hours, machine-hours, rates, overhead pools, allocation rules, standard cost or variance anywhere (D2, D3 stand). No field, column, config key or posting is introduced for any of them.
* Operations have **no costing effect** and publish **no Financial Event**. Inventory/WIP/GL behaviour of a Work Order is byte-identical with or without a routing.
* One routing per finished product (mirrors BOM's one-per-product, ADR-061 §2), created-or-replaced as a whole.
* At Work Order `release`, an active routing (if any) is **snapshotted** onto `work_order_operations` (same snapshot-is-authoritative rule ADR-061 §2 applies to BOM components). Operations are then executed in sequence (`start` → `complete`).
* New completion guard, **opt-in by data**: a Work Order that has operation rows may `complete` only when every operation is `completed`. A Work Order with no routing is unchanged (no regression to the verified lifecycle).

## A2. BOM — status added; versioning NOT added
* ADR-061 §2/§21 invariant is preserved: **no versioning, no effective-date ranges, UNIQUE(finishedProductId)**. The Work Order snapshot remains the point-in-time mechanism.
* Directive §3 B asks for "Lifecycle / status": an additive `status` (`active` | `inactive`, default `active`) is added to `bill_of_materials`. An inactive BOM cannot be used to release a Work Order or run an assembly (`getBomForAssembly` returns `null` for an inactive BOM → the existing "no recipe" business error). Already-released Work Orders are unaffected (snapshot).
* Quantity stays whole-number (`int`) and units remain the component Product's existing free-text `unit` label (read-only display) — no unit-of-measure engine, no schema change to `products` (ADR-061 §19).
* BOM master data is **managed from the Manufacturing workspace** through manufacturing-owned permission nodes `manufacturing.bom.*`, backed by the **same** commerce `BomService` via the published `SALES_BOM_CONTRACT` (no second BOM store, no second service). The existing Catalog `/bom` surface (`sales.catalog.edit`) is retained for backward compatibility.

## A3. Product "manufacturing eligibility"
No `products` schema change (ADR-061 §19). Eligibility is **derived**: a product is manufacturable iff it has an **active BOM**. `createWorkOrder` now validates product existence and active-BOM presence at creation (previously only at release); the UI offers only manufacturable products.

## A4. Legacy Assembly (D5) — surfaced as a Manufacturing page
`assembleProduct` (already D5-remediated) gets a dedicated Manufacturing workspace page (BOM preview, availability, history). Permission/entitlement for the path is unchanged (`inventory.assembly.create`, ADR-061 §14).

## A5. Package-readiness — feature axis removed
ADR-061 §15 made `manufacturing.work_orders` an off-by-default toggleable feature. The directive (§1, §6) requires "Manufacturing in Package ⇒ Company Capability enabled; not in Package ⇒ disabled" through the **existing** Package Engine, with **no second entitlement axis**. The feature is therefore made **structural** (`default: true, toggleable: false`) — it follows its module exactly like Procurement's features. Entitlement is now decided solely by Licence ∩ Company Package; user access solely by company-scoped permission nodes.

## A6. Permissions
Matrix extended under the existing `manufacturing` root (ancestor-walk covers the Company `admin` role in Platform and Company DBs with no new grant migration): `manufacturing.bom.{view,create,edit,delete}`, `manufacturing.routing.{view,create,edit,delete}`, `manufacturing.work_center.{view,create,edit,delete}`, `manufacturing.work_order.operation_execute`. Role templates (`manager` / `operator` / `viewer`) added to `MODULE_ROLE_TEMPLATES`.

## A7. Explicit non-goals retained (ADR-061 §21, D2, D3)
Subcontracting, quality gating, scrap/waste accounting, standard costing, variance, labor/overhead, maker/checker approval, multi-branch scoping. "Yield" is shown as the derived ratio `quantityProduced ÷ quantityPlanned` only (no scrap events). Procurement has no automated process link (study §12: data link only).
