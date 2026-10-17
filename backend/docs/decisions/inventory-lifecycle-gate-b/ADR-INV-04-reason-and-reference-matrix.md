# ADR-INV-04 - Movement reasons and mandatory reference documents

**Status: PROPOSED (Gate B) - awaiting CTO review; the initial catalog needs accounting confirmation.** **Answers:** D-INV-4. **Gate A evidence:** G-REF-1 (free-text `reference`, manual receipt stored with `referenceId = NULL`; O9). **Found during Gate B (code-evidenced):** G-ISS-1 - a warehouse `issue` document posts a `dispatch` movement (`warehouse-transactions.service.ts` postTransaction, issue branch) and the `dispatch` event kind always posts `Dr COGS / Cr Inventory`, so any internal issue (consumption, sample, scrap) is booked as cost of goods sold. To be measured in Gate D.

## 1. Context
Only `receipt` has a coded reason (configuration map `accounting.inventory_manual_receipt_reason_accounts`: code -> offset account). Other document types carry a free-text `reason`; `reference` is free text; nothing ties a movement to the document that justifies it. The directive asks for the right reference per kind of movement - not a purchase invoice on every receipt.

## 2. Decision
### 2.1 A reason catalog, stored where configuration already lives
One new Configuration-Engine key `inventory.movement_reason_catalog` (JSON, default = the starting set below, editable through the existing accounting-policy/settings screens). Each entry: `code`, terminology key (Arabic/English labels through the existing registry), `movementTypes[]`, `referenceKind`, `approval`, `financial` (`none` | `account` | `derived`), `reserved` (system-only).
The existing receipt-account map **stays the single source of the offset account** for receipts (no duplication, no migration of values); the catalog references it by code. New map keys are added only where a posting policy needs them (2.3).

### 2.2 Reference kinds and validation
`referenceKind` is one of: `purchase_order` / `goods_receipt` (receipts via Goods Receipt only - not selectable on manual receipts), `source_document` (the original sales order / return / shipment), `count_document`, `opening_batch`, `transfer_document` (the document itself), `none_with_note` (found stock, donation: a written note of at least 20 characters is mandatory plus approval).
`warehouse_transactions` gains two **nullable** columns `referenceType` and `referenceId` (the document-level link; `reference` stays as a free note). On create/submit the service validates that the referenced record exists in the same Company, is in an acceptable state, and (for quantities) is not exceeded. Enforcement mode `inventory.reference_enforcement` = `off | warn | enforce`; `warn` records `warehouse_transaction.reference_missing` in the audit trail so real data can be measured before enforcing.

### 2.3 Starting catalog (to be confirmed with accounting; no code uses codes that are not in the catalog)
| Type | Reason code | Reference | Approval | Financial effect |
|---|---|---|---|---|
| receipt | `found_stock` | none_with_note | required | Dr 1120 / Cr mapped account (existing map) |
| receipt | `donation` | none_with_note | required | Dr 1120 / Cr mapped account |
| receipt | `opening_balance` | opening_batch | **reserved - batch only** (ADR-INV-01) | opening account |
| issue | `internal_consumption`, `sample`, `scrap_waste` | none_with_note | required | **new:** Dr mapped expense / Cr 1120 at average cost via new key `accounting.inventory_issue_reason_accounts` |
| issue | `sale` | source_document | system only (shipment/fulfilment) | Dr COGS / Cr 1120 (unchanged) |
| adjustment | `count_variance` | count_document | required | gain/loss accounts (unchanged D3) |
| adjustment | `damage`, `correction` | none_with_note | required | gain/loss (unchanged) |
| adjustment | `opening_correction` | opening_batch | required | **decision O-1** (ADR-INV-01) |
| transfer | `internal_transfer` | transfer_document | required | none (Model A) |
**Policy decision requiring CTO + accounting sign-off (G-ISS-1):** introducing `internal_consumption/sample/scrap_waste` changes how manual issues are booked (expense account instead of COGS). Until it is approved, issue documents keep today's COGS behaviour and the only Gate C change is capturing the reason code and reference (flag off for the accounting change).

## 3. Alternatives
*A new `inventory_movement_reasons` table* - rejected for now: configuration already carries the receipt map and is audited/versioned; a table can come later if reasons need lifecycle. *Mandatory purchase invoice on every receipt* - rejected by the directive.

## 4. Impact / compatibility / rollback
Additive: 1 configuration key (+ manifest version bump), 1 optional key, 2 nullable columns (Company migration + fan-out instruction), terminology rows, form changes. Legacy documents keep their free-text reasons and are never rewritten. Modes `off -> warn -> enforce` make roll-out reversible at every step.

## 5. Tests
Each reason accepted only for its movement types; wrong/unknown/reserved reason refused with nothing written; reference exists / same Company / acceptable state / not exceeded; `none_with_note` needs the note; receipt via the document path with a PO reference cannot bypass Goods Receipt rules; `warn` mode audit events; legacy documents still load and reverse; issue-reason posting (if approved) debits the mapped expense exactly once at average cost; A/B isolation.
