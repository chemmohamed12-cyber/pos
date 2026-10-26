# Alpha — warehouse assignment closure record (2026-10-26)

## 1. Decision (closure record fields)
1. **Decision:** every Alpha warehouse (11 main + 2 operational sub-locations of `1001`) is owned by the branch **كتامه** (`3314ab1a-f504-41f8-98f0-8cd1432aa85e`, active branch of Alpha).
2. **Approver:** the project owner, personally, in chat on 2026-10-26 (answers: "All in one branch" → "كتامه"). Engineering did not infer or suggest the branch; the worksheet's name column showed no branch mention for any warehouse.
3. **Companies affected:** Alpha Trading Co (database `company_f3ea8a2e75814dd4b3f708e606a434f9`) only.
4. **Evidence reviewed:** worksheet `12-…` (13 warehouses, only `1001` has documents: 2 sales orders, 2 purchase orders).
5. **Exceptions:** none.

## 2. Application (done)
Through the application's own `InventoryService.setWarehouseOrgUnit` (the method behind the warehouse screen, audited as `inventory.warehouse.org_unit_changed`) with the controller's rule replicated up front (target must be an **active unit of type `branch`** of that Company; an existing link is never overwritten). Script: `25b-…`. Dry run `24-…` (13 to assign, 0 applied) → apply `25-…`: **13 applied, 13 audit rows, all 13 warehouses linked to كتامه**, the 2 operational sub-locations carry the same branch as their parent `1001`. No other table was written. (It was applied by script rather than by clicking the screen because the shared dev frontend runs a build without the new endpoints; the persisted result and the audit trail are the same.)

## 3. New backfill preview, reviewed (files 26, 27) — **NOTHING WRITTEN**
- Plain dry-run (`26-…`): sales orders 2 and purchase orders 2 are now derivable (before: 0); invoices / fulfillment orders / shipments show 0 only because they derive from the order's stamp which a dry-run does not write.
- Full-chain preview (`27-…`): the real backfill executed inside **one transaction that is always rolled back** (afterwards: stamped-column counts and `org_migration_log` rows identical to before → nothing persisted). It would stamp **all 10 documents** — 2 sales orders, 2 invoices, 2 fulfillment orders, 2 shipments, 2 purchase orders — with **كتامه**, derived only from warehouse `1001`'s branch (orders / POs) and from the parent order (children); logged rows per table 2/2/2/2/2; **financial checksums before = after** in every step; conflicts 0; no document stays unassigned.
- Review points: single branch, single Company, no cross-Company or cross-branch mixture; no document is reassigned (all currently NULL); the derivation uses today's warehouse branch for historical orders — correct only because the owner states all Alpha warehouses have always belonged to كتامه (confirm this when approving).
- Beta / Gamma / Delta: no data, unchanged.

## 4. Approval still required
The backfill itself has **not** been executed and is **not** approved by the assignment answer. It needs the owner's explicit approval of this preview; afterwards: execute via `POST organization/legacy/backfill` semantics (service `OrgLegacyService.backfill` with confirm), then record post-application verification (rows listed from `org_migration_log`, checksums, counts). Status: **AWAITING EXPLICIT BACKFILL APPROVAL**.

## 5. Backfill executed after explicit approval (update)
**Approval:** the project owner, personally, in chat on 2026-10-26 ("Approve and execute"), after reviewing the full-chain preview (file 27) and confirming Alpha's historical orders belong to كتامه. **Executed** with `OrgLegacyService.backfill` on Alpha only (script `29b-…`, result `29-…`, exit code 0), run id `ac6e4c19-048d-45e4-8591-d5737a8bf4c6`.
- **Changed rows (all previously NULL):** sales orders 2, invoices 2, fulfillment orders 2, shipments 2, purchase orders 2 = **10 rows, 10 rows in `org_migration_log`** (from NULL to كتامه, source `warehouse.owning_branch` / `sales_order.branch`).
- **Verification afterwards (files 29, 30, 31):** stamped/total = 2/2 in each of the five tables; **order, invoice and purchase-order totals identical before/after** (checksums inside the run and re-computed outside it); a new dry-run over the four companies assigns **0** (idempotent) with 0 unassigned and 0 conflicts for Alpha; Beta/Gamma/Delta unchanged (no data); Alpha organization unchanged (root «ضى», archived `mother`, 0 orphans, single-root index).
- **Remaining exceptions:** Alpha's one vehicle has no branch (no legacy text, no assignment given) — left unassigned; the 2 `purchase_orders`/`sales_orders` links are the only attribution derived from history.
- **Rollback:** by restoring a backup of the Alpha database (the dev data is test data; for real data `down` would drop the stamped columns and lose the stamps — see the final report §1). Status: **CLOSED**.
