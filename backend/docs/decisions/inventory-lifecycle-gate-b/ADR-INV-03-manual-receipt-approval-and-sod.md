# ADR-INV-03 - Approval and segregation of duties for receipts with direct financial effect

**Status: PROPOSED (Gate B) - awaiting CTO review.** **Answers:** D-INV-3. **Gate A evidence:** G-OB-2, G-SOD-1 (a warehouse worker's single `submit` posted `Dr 1120 / Cr 3105` 24.00; O3). **Found during Gate B (code-evidenced, to be measured in Gate D):** G-SOD-2 - the warehouse document `approve`/`post` path checks role/capability but never compares the approver with the creator (`warehouse-transactions.service.ts` `transition`; only `approvedByUserId` is stored), unlike FA-01 which refuses maker == checker (`approval-engine.service.ts:312`).

## 1. Context
`NO_APPROVAL_REQUIRED = { receipt }` was written when a receipt had no financial effect. Since D3-B every manual receipt carries `Dr Inventory / Cr <reason account>` for quantity x a worker-typed cost, yet it still auto-posts. Goods Receipts against an approved PO are a different path (their own posting, GRNI, PO-bound cost) and are not affected.

## 2. Decision
1. **Approval policy by effect, not by type.** A warehouse `receipt` document that creates a financial effect (every receipt with a `reasonCode`, i.e. every manual receipt) **requires approval**: `draft -> submitted -> approved -> posted`. The `submitted -> posted` auto path stays in the process definition only for legacy/reversal documents. The per-reason catalog (ADR-INV-04) carries `approval: 'required' | 'straight_through'`, default `required`; `straight_through` may only be set by an accountant through configuration, is audited, and is not used in the initial catalog.
2. **Segregation of duties on documents with financial effect.** `approve` and `post` by the same user who created/submitted the document are refused (receipt, adjustment, count with variance, issue). Enforced in `WarehouseTransactionsService.transition` before any mutation, using the document's `createdByUserId`. The check is configuration-flagged (`inventory.document_sod_enforced`) for a staged cut-over: `off` -> today; `warn` -> allow and record an audit event `warehouse_transaction.sod_violation`; `on` -> refuse.
3. **No new permission nodes.** The existing capabilities (`inventory.warehouse_tx.submit/approve/post`) are reused; the opening-equity reasons are removed from manual receipts entirely (ADR-INV-01/04), so the highest-risk receipts do not exist as documents.
4. The pending-approval KPI and list already include `submitted` documents; no UI invention is needed beyond showing the financial summary (reason, cost, offset account, total) on the detail page for the approver.

## 3. Alternatives
*Value threshold (approval only above X)* - deferred: no agreed number, and low-value fraud is still fraud; can be added as a catalog attribute later. *Route receipts through FA-01* - rejected for now: warehouse documents already have a supervisor step; adding a second engine duplicates it; FA-01 stays for bulk openings and value-only adjustments.

## 4. Impact / compatibility / rollback
Behaviour change for storekeepers (receipts now wait for a supervisor): communicated and flag-controlled (`inventory.receipt_approval_required`: off / on). No schema change. Documents already posted are untouched. Any receipt left `submitted` after a failed auto-post (Gate A O3 showed the state remains `submitted`) becomes a normal approvable document. Rollback = flags off.

## 5. Tests (Gate D)
A worker submit leaves the document `submitted`, no movement/journal; an approver != creator posts it once with `Dr 1120 / Cr reason account`; creator approving is refused (and audited in `warn`); GR path unchanged and still straight-through; reversal documents unchanged; permissions (worker cannot approve); Company isolation; every rejection leaves stock, valuation, outbox, journal untouched (snapshot test, same style as T-11).
