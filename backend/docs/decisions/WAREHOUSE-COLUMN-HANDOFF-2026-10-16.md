# Products screen: item warehouse column — handoff (2026-10-16)

> **Status: IMPLEMENTED and verified; NOT committed** (no commit authorization yet for this change). It is independent of F11 (`3ede261`) and of Cash Flow (`75c40e8`).
> **Isolated tree:** worktree `.claude/worktrees/warehouse-column`, detached at `5e41647`, holding this change only (4 files, +89 lines, additions only). Evidence: `evidence-2026-10-16-warehouse-column/` (`change.diff` is the full change).

## What it does (owner request, 2026-10-16)
- The Products screen ("الأصناف والأسعار" → المنتجات) gets a **warehouse column**. It lists each item's default/origin warehouses, the existing `warehouse_items` markers of D1. Items without a marker show "—".
- **Edit** opens a checkbox list of the warehouses with the current ones ticked. Save adds or removes markers through the existing `POST /inventory/warehouses/:id/items` and `DELETE …/items/:productId`.
- The editor appears only with `inventory.warehouse.edit`. Without that permission the column is read-only.
- An item may belong to several warehouses; the existing model already supports that. A marker is metadata only: stock stays the ledger sum, and nothing is blocked by it.

## Files
| File | Change |
|---|---|
| `backend/src/domains/inventory-warehouse/application/inventory.service.ts` | `listWarehouseItemAssignments(visibleWarehouseIds?, manager?)`, a read-only query |
| `backend/src/domains/inventory-warehouse/interface/inventory.controller.ts` | `GET /api/inventory/warehouse-items`, with the F6 visible-warehouse filter (`@WarehouseScopeFiltered`) |
| `backend/src/domains/inventory-warehouse/interface/warehouse-item-assignment.company-isolation.spec.ts` | test 8: the list (full Company, F6 filter, empty filter, Company B isolation) |
| `frontend/src/pages/Products.tsx` | the column and the edit control |

**Database:** no migration and no schema change. It reads the existing `warehouse_items` table.

## Verification
| Check | Result | Evidence |
|---|---|---|
| Real-PG spec `warehouse-item-assignment` | **8/8 PASS**, including the new test 8. It ran on the F11 + column tree; this change's code is identical, and F11 touches a different method of the same file. | `real-pg-spec-on-f11-plus-column.log` |
| Browser on `daii_dev` (owner signed in, company Alpha) | The column shows each item's warehouses. Item 1003: add "1 — مخزن المفكك", then save, then reload (persists), then remove (restored to "—"). No failed API call on the page. | `products-warehouse-column-after-edit.jpg` |
| CI gate on this isolated tree | install, build, lint (0 errors / 5 warnings = baseline), structure, doc-links and db-guard PASS. Unit: 435/436. The single failure was `artifact-integrity` test 5, a **5 s timeout under machine load** (unit step took 401 s vs. a usual 60–100 s while another session's regression ran). Re-run alone: **7/7 PASS**. It is unrelated to this change (release artifact build). | `ci-summary.md`, `ci-unit.log`, `artifact-integrity-rerun.log` |
| Frontend build / lint (`Products.tsx`) | PASS. 0 errors. 1 warning (`set-state-in-effect`), already present in the committed version of the file. | `frontend-build.log`, `frontend-lint-products.log` |

## Completed / blocked / not started
- **Completed:** implementation, real-PG spec, browser check on `daii_dev`, and database-free CI on the isolated tree.
- **Blocked:**
  - *Commit*: needs the owner's authorization. This blocks **nothing for local preview**, because the column already runs in the preview worktree `dev-preview`. It is needed only for the next release.
  - *Optional real-PG re-run on this isolated base*: needs an exclusive slot on cluster 5546, which another session currently owns. It is **not required**: same code, already 8/8. Run it only if a reviewer asks.
- **Not started:** nothing else is in scope.

## Notes for integration
- Commit as its own change, separate from F11 and Item Details.
- `inventory.service.ts` is touched by both F11 (in `listMovements`) and this change (a new method). The hunks are independent and merge cleanly in either order.
- `master` still has this change uncommitted, mixed with the F11 edits and the Item Details work. The isolated worktree is the reviewable copy.
