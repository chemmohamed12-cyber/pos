# Manufacturing Engine — implementation decisions (2026-10-24)

Taken under the owner's direct execution order of 2026-10-24 (shared dev environment, test data). Each decision is the **narrowest option that works and does not change a ratified cost decision**. Accounting-policy items are marked **owner sign-off pending**: they are implemented and previewable on the dev environment but are not final until their owner signs.

**Unchanged on purpose:** ADR-060 D1 (actual / moving-average costing), D2 (material cost only), D3 (no standard cost / variance), D4 (continuous WIP). Labour / machine / overhead absorption, standard costing, variances and the payroll feed are **not implemented** — they stay behind a separate ratification. Anything below that needs a cost element is built as *quantity/operational* data only.

| # | Decision | Detail | Sign-off |
|---|---|---|---|
| **D-ME-1** (M0-3) | Scrap is a **first-class result**, not a material return | `recordScrap` consumes the components of N finished-unit equivalents from the order's WIP at the existing pooled cost and writes that value to a **configured expense account** (`accounting.manufacturing_scrap_loss_account_code`): **Dr Scrap loss / Cr WIP**, no stock created. Planned quantity is exhausted by produced + scrapped. `recordRecovery` puts salvaged material back into the warehouse at a declared value capped by the scrap it came from: **Dr Inventory / Cr Scrap loss**. A material return remains valid only for physically intact, unconsumed material. All scrap is expensed (no "normal loss" capitalisation) because capitalising loss would be a new costing policy (D2/D3). | accounting owner — pending |
| **D-ME-2** (Q4) | Fractional quantities by **integer base-unit scaling** | `stock_movements.quantity` stays `int`. Each product gets a base unit plus a conversion table (`unit → factor in base units`, integer). Definitions and screens accept alternate units (carton, kg) and convert to the integer base unit; a conversion that is not an exact integer is rejected. No change to the inventory core or valuation. Revisit only if a product cannot be expressed by a small enough base unit. | product / inventory owners — pending |
| **D-ME-3** | Model: **additive** tables, WIP per operation is a **derived production ledger** | New tables for definitions (BOM versions, process graph, operation types), execution (operation runs, result lines) and pegging; nothing existing is altered in meaning. Physical WIP stays one sub-warehouse per order; per-operation quantity and value are derived from result lines, not stored as extra warehouses. | manufacturing / inventory — pending |
| **D-ME-4** | Eight outcome classes with fixed engine semantics | See table below; the **policy per class** (destination, whether a reason is required) is configuration, the class set is not. | manufacturing owner — pending |
| **D-ME-5** | Quick assembly is **not a second engine** | `assembleProduct` is re-based on the work-order path (create → release → issue → output → complete in one transaction) so every production leaves one order trail and one posting path. Delivered last (slice S6) with its existing specs as the regression. | manufacturing / inventory — pending |

## Outcome classes (D-ME-4)
| Class | Quantity effect | Value effect (material cost only) | Closing rule |
|---|---|---|---|
| `good` | produced (+ FG receipt) | pooled WIP value → finished/intermediate stock | counts toward the plan |
| `scrap` | scrapped (components consumed, no stock) | pooled WIP value → Scrap loss expense | counts toward the plan |
| `recovered` | material received back | declared value ≤ scrap value → Dr Inventory / Cr Scrap loss | optional, capped |
| `rework` | units re-enter a prior operation | none (no new material) | must resolve to good / scrap before close |
| `rejected` | held for decision | none until disposed | must be disposed (rework/scrap/good) before close |
| `held` | quality hold | none | must be released before close |
| `co_product` / `by_product` | received into stock | share of pooled WIP by configured allocation basis | part of the same pool |

## Execution order (each slice: real-PG tests + browser preview before the next)
S1 outcomes/scrap/recovery + accounting · S2 units & pack conversion · S3 BOM versions/alternates/multi-level · S4 process graph, runs, per-operation ledger · S5 multi-output + recovery + quality operation (no cost element) · S6 quick-assembly re-base · seven industrial cases · regression + report.

## Dev-environment record — S1 (2026-10-24)
- Migrations applied (known, verifiable): `manufacturing/1790033000000-CreateWorkOrderResults` to daii_dev + the 9 `company_*` dev DBs; `core/1790033100000-SeedManufacturingOutcomeTerminology` to daii_dev.
- Alpha (company_f3ea8a2e…) dev configuration changed: `accounting.manufacturing_scrap_loss_account_code` = 5299; `accounting.inventory_manual_receipt_reason_accounts` = {mfg_s1_test: 3101}.
- Alpha test data (prefix MFG-S1): products MFG-S1-FIN/C1/C2, BOM (2xC1 + 1xC2), WO-2026-000001 (plan 10, 2 scrapped = 40.00, journal Dr 5299 / Cr 1150), 100 each of C1 @5 and C2 @10 received.
- Ports 3500/5173 are held by another session's main-checkout servers; S1 was verified on this worktree's backend :3501 + vite :5174 (VITE_API_TARGET=:3501).
- Browser-verified: outcomes panel renders (AR), scrap form posts, WO shows quantityScrapped, GL journal visible on the order.
