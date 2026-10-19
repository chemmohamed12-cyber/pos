# ADR-INV-05 - One financial path for stock effects; value-only adjustments that update valuation

**Status: PROPOSED (Gate B) - NOT to be approved by picking an option; this ADR defines how the two mechanisms coexist. Highest-sensitivity item.** **Answers:** D-INV-5. **Gate A evidence:** G-ADJ-1.

## 1. Context (verified in code)
- **D3 path:** warehouse `adjustment`/`count` documents (supervisor approval) move stock and, at event time, post a journal at the **current moving average** and change valuation in the same transaction (`inventory-costing-handler.service.ts`, adjustment branch).
- **F07 path (FA-01, 2 approvers for write-downs):** `accounting.inventory.physical_count_variance` and `valuation_write_down` post `Dr/Cr Inventory` for a **maker-typed amount**, with an optional product/warehouse that is only informational. They move **no stock and no valuation**: nothing subscribes to `INVENTORY_ADJUSTMENT_APPROVED_EVENT` on the valuation side. The currency is hard-coded `'EGP'` in the service.
Consequences: (a) every F07 entry opens a permanent GL-vs-valuation gap that reconciliation can only call "drift"; (b) a count variance can be booked twice (once by the count document, once as an F07 entry); (c) F07's own header says routine counts "never reach FA-01" - no longer true since D3.

## 2. Decision - a matrix, so the two never overlap
| Effect | Mechanism | Posts | Valuation |
|---|---|---|---|
| Quantity changes (count variance, damage, correction, found/lost) | **D3 documents only** (adjustment/count, ADR-INV-03/04) | gain/loss accounts at average cost | updated by the handler (unchanged) |
| Value changes with no quantity change (write-down / write-up of cost) | **F07 `valuation_write_down`** (value-only) | `Dr loss / Cr 1120` (or the reverse for a write-up) | **now updated in the same transaction** (new) |
| `physical_count_variance` | **retired for new submissions**: the API answers 409 with a pointer to count documents; already approved history is untouched | - | - |

### 2.1 Making a value-only adjustment update valuation (no duplicate accounting effect)
- F07 submissions for `valuation_write_down` **must carry `productId` and `warehouseId`** (today optional) and the amount must not exceed the current valuation of that pair (a write-down cannot create negative value; quantity must be > 0).
- The existing financial-event handler for `accounting.inventory.adjustment.approved` stays the only place the journal is drafted. In the **same handler transaction** (the pattern the costing handler already uses with `ctx.manager`) it calls a new valuation-engine method `applyRevaluation(productId, warehouseId, valueDelta, idempotencyKey)` which appends a `revaluation` row to `inventory_valuation_movements` and adjusts the pair's `totalValueBase` (quantity unchanged, average recomputed). Idempotency key = the financial event's key, so a re-drive neither double-posts the journal nor double-applies the revaluation (same guarantee as the dispatch/adjustment kinds).
- If the handler rejects (missing account, closed period) nothing is mutated - accounts and period are resolved **before** the valuation write, exactly as D3 fixed for dispatch.
- The hard-coded `'EGP'` is replaced by the Company base currency (resolved, not assumed).
- Approval is unchanged (FA-01, 2 approvers, maker != checker).

### 2.2 What happens to existing F07 entries
No rewrite. Reconciliation (ADR-INV-09) classifies every historical F07 entry that has no valuation effect as the category **"F07 without valuation effect - explained"** with its amount and approval id, so the existing drift becomes an itemised, auditable list instead of an unexplained number. Whether to align history with an approved revaluation is an accountant's decision made case by case through the new path - never automatic.

## 3. Alternatives
*Retire F07 completely* - rejected: value-only write-downs (obsolescence, damaged but counted) are a real need with no D3 equivalent. *Let F07 stay GL-only and itemise it forever* - rejected: it guarantees a standing difference between sub-ledger and GL. *Merge both into D3 documents* - rejected: D3 documents have no maker-typed value concept and a one-approver step.

## 4. Impact / compatibility / rollback
New: valuation `kind = 'revaluation'` - the column is `varchar(32)` **with a CHECK constraint** (`CHK_inventory_valuation_movements_kind`, migration `inventory/1755860000000`), so a small reversible Company migration drops and recreates that CHECK with the extra value (supported on PostgreSQL 10), plus the TypeScript union, one engine method, F07 validation, UI wording. Contracts: `InventoryValuationContract` (additive method; `@Optional()` binding means installations without valuation keep today's behaviour). Flag `accounting.inventory_f07_updates_valuation` (off = today). Retiring `physical_count_variance` is flag-controlled (`warn` first: accepted but audited as deprecated). Rollback = flags off; schema untouched.

## 5. Tests
Write-down posts one journal and reduces valuation by exactly the same amount (valuation = GL stays equal); re-drive and retry add nothing; rejection leaves valuation and journals untouched; cannot exceed current value / zero quantity; both approvers required; count variance via document and via F07 cannot both succeed (the F07 kind is refused); historical F07 entries appear as the explained category; currency from base; Company isolation.

## 6. Approval needed
Confirm the matrix above (especially retiring `physical_count_variance` and making write-downs update valuation). Until then Gate C implements nothing of this ADR.
