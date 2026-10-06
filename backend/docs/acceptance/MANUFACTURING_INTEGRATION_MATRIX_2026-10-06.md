# Manufacturing — Platform Integration Matrix (M4/M5, 2026-10-06)

Scope authority: ADR-061 + Addendum 1. No new event architecture; every row below uses an **existing** platform
mechanism. Format per CTO directive: source → event/transaction → target → consequence → rollback.

| # | Source | Event / transaction | Target | Consequence | Rollback / reversal | Proof |
|---|---|---|---|---|---|---|
| 1 | Sales (Commerce) | `SALES_BOM_CONTRACT.getBomForAssembly` (read, via published contract) | Manufacturing `createWorkOrder` / `release` | WO needs an **active** BOM (A3); components snapshotted at release | Snapshot is immutable; BOM edits never touch a released WO | `manufacturing-master-data.company-isolation.spec` (A3, A2) · `work-order-phase3-e2e` Item 1 |
| 2 | Manufacturing | `release` → `InventoryService.reserveStockInTransaction` (`stock_reservations`, `referenceType = WORK_ORDER`, XOR with `salesOrderId`) | Inventory | Component stock reserved; Sales reservations undisturbed | `cancel` (released, zero issued) / `complete` release remaining reservations | phase3 e2e Items 2,10 |
| 3 | Manufacturing | `release` → dedicated WIP sub-warehouse (`warehouses.kind = operational`) per WO | Warehouse | Physical WIP isolation; excluded from Inventory reconciliation | Warehouse retained (history); WIP must be 0 to complete | phase3 e2e Items 3,6 · `work-order.company-isolation.spec` |
| 4 | Manufacturing | `materialIssue` → `recordMovement` (warehouse → WIP) + F08 `consumeIssueCost` + Financial Event `manufacturing.work_order.material_issued` | Inventory + Costing + Accounting | Qty moves to WIP at current weighted-average cost; **Dr WIP / Cr Inventory** | `materialReturn` (exact reverse leg: **Dr Inventory / Cr WIP**); over-issue and physical-availability guards | phase3 e2e Items 5,7,8,9 |
| 5 | Manufacturing | `finishedGoodsOutput` → `recordMovement` (WIP → warehouse) + F08 controlled override `consumeManufacturingPooledCost` + Financial Event `…finished_goods_received` | Inventory + Costing + Accounting | FG valued at pooled WIP cost (ADR-061 §7 formula); **Dr FG Inventory / Cr WIP**; over-production guard | Not reversible by design (no FG un-produce in ADR-061 scope) | phase3 e2e Items 4,7,8 |
| 6 | Manufacturing | `complete` guard: WIP value = 0 **and** every snapshotted routing operation completed | Process Engine | Lifecycle `in_progress → completed`; remaining reservations released | `hold`/`resume` before completion; guard failure leaves state untouched | phase3 e2e Item 11 · master-data spec (completion guard) |
| 7 | Accounting | `MANUFACTURING_WIP_CONTRACT` → `WipReconciliationService.reconcile` (subledger WIP vs GL `wip` control account); Closing Audit module `wip` | Accounting / Month-End | Drift is **reported**, never netted against Inventory | Read-only; corrected by posting, not by Manufacturing | `wip-reconciliation.spec` · phase3 e2e Items 6,12 (now self-seeded drift) |
| 8 | Inventory | Direct Assembly path `POST /inventory/assemble` (`inventory.assembly.create`) → `recordMovement` + WIP events (D5 retrofit) | Inventory + Accounting | Single-step build from active BOM; same GL legs as 4/5 | Idempotent assembly reference | `inventory` assembly specs · **Assembly page** (A4) |
| 9 | Procurement | GRN (`GoodsReceiptService`) → stock in warehouse | Manufacturing (consumer) | Purchased components become issuable stock | Procurement's own reversal (not Manufacturing's) | no Manufacturing code path — **integration is via Inventory stock**, intentionally |
| 10 | Platform | Package → Entitlement → Company capability → User permission | All Manufacturing routes | 404 when the Company lacks the module; 404 when the user lacks the node | Downgrade blocks access, deletes nothing; upgrade restores | `manufacturing-entitlement-permission.real-pg.spec` |

## Explicitly NOT integrated (ADR-061 §21 / Addendum A7 — excluded scope, not gaps)
Quality gating/inspection · Supplier subcontracting / outside processing · Scrap/yield accounting ("yield" is only the
derived `produced ÷ planned` ratio) · Standard cost / variance · Labor, machine hours, overhead absorption (ADR-060 D2/D3) ·
Maker/checker on Work Orders · Multi-branch production. Each requires its own ADR; none is silently approximated here.

## Operations (A1) — deliberately side-effect free
Starting/completing a routing operation writes `work_order_operations` + an audit row only: **no inventory movement,
no Financial Event, no cost**. It is a sequencing/tracking control whose only coupling is the opt-in completion guard (#6).
