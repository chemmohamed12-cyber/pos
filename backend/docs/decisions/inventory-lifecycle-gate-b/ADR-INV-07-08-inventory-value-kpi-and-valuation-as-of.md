# ADR-INV-07 and ADR-INV-08 - Inventory value on screen (cost first) and valuation as of a date

**Status: PROPOSED (Gate B) - awaiting CTO review.** **Answers:** D-INV-7, D-INV-8. **Gate A evidence:** G-VAL-1 (overview 140.00 at selling price vs valuation = GL 1120 = 58.00; O4), G-VAL-2 (no valuation report), G-VAL-3 (`getValuedOnHandTotal(asOfDate)` ignores the date; as-of 2000-01-01 compared "now" with "then"; O8).

---
## ADR-INV-07 - Warehouse Overview value
### Decision
1. `GET /warehouse-transactions/overview` keeps `totalInventoryValueAtSellingPrice` unchanged (back-compat) and **adds** `totalInventoryValueAtCost`, `valuationAsOf` (timestamp of the latest valuation row) and `valuationPendingEvents` (count of inventory events not yet POSTED: pending in the outbox + REJECTED). Cost comes from the existing `INVENTORY_VALUATION_CONTRACT` (`@Optional()`), never from a raw table read.
2. **F6 visibility is preserved:** the figure is the sum over the caller's visible warehouses only (the contract returns per-warehouse totals; the service filters exactly as it does for the quantity KPIs).
3. The screen shows **cost as the primary value** with the label "Inventory value (cost / valuation)", and the selling-price figure as a separate, plainly labelled secondary KPI. Users without `inventory.valuation.view` do not receive the cost figure (the field is `null`), they keep the quantity KPIs and the selling-price KPI.
4. When `valuationPendingEvents > 0` a visible chip says "posting pending (N)" with a link to the Financial Events screen (ADR-INV-10).

### Alternatives / impact / rollback
*Replace the selling-price KPI* - rejected (someone may rely on it; it is a legitimate commercial number). Impact: 1 service method, 1 DTO field set, 1 screen, terminology rows; no schema. Rollback: ignore the new fields. Tests: overview cost = valuation = GL after a receipt (the Gate A probe scenario); permission-less caller gets null; F6-scoped caller sees its warehouses' cost only; Company B never included.

---
## ADR-INV-08 - Valuation as of a date, and a valuation report
### Decision
1. **Schema (additive):** `inventory_valuation_movements.businessDate date NULL` + index `(businessDate)`; **backfill** from `createdAt::date` (UTC) in the same migration (documented as "processing date" for rows written before this release). New rows store the event's business date (ADR-INV-02; default today when absent).
2. **Engine:** `getValuedOnHandTotal(asOfDate)` and a new `getValuedPositions(asOfDate, filter)` aggregate by (warehouse, product): `SUM(quantity)` and `SUM(valueDeltaBase)` over rows with `businessDate <= asOfDate` (reversal rows are offsetting rows already). With no date they keep reading `inventory_valuation_state` (unchanged fast path). A consistency check asserts `asOf(today) == state` per pair; a mismatch is reported by the reconciliation as "valuation history inconsistent", never silently ignored.
3. **API:** `GET /inventory/valuation/report?warehouseId&productId&asOf&groupBy=warehouse|item` (permission `inventory.valuation.view`, F6-scoped) returns rows `{warehouse, product, quantity, averageCostBase, valueBase}` plus totals and the as-of date. The existing `current-cost` route is unchanged.
4. **UI:** a Valuation report page (by warehouse, by item, as-of date), reachable from Warehouse Overview and from the reconciliation.

### Limitations stated up front
Rows backfilled from `createdAt` use the processing date, so as-of results for dates before this release are approximate for back-dated history; the report marks the first date from which `businessDate` is exact (`exactFrom` = migration date). Moving-average cost follows processing order (ADR-INV-02 section 5).

### Compatibility / rollback / tests
Additive nullable column with a reversible `down()`; `InventoryValuationContract` gains optional parameters/methods; old callers unchanged. Rollback = ignore the column. Tests: as-of(today) equals the state table across receipt/issue/transfer/adjustment/reversal sequences; as-of a past date equals the state recomputed independently from the movement list; back-dated documents land in the right as-of bucket; F6 scope; permission; A/B isolation; migration backfill idempotent and PG10-safe (no extensions, no generated columns).
