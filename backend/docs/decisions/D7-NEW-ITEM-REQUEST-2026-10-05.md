# D7 — New Item Request (PRC-03) — evidence + recommended policy (2026-10-05)

**Status: CLOSED (2026-10-05) — IMPLEMENTED / REAL-PG VERIFIED. CTO decision received (§4 answered: Model A; one approver holding `sales.catalog.edit`; gate at PR approval). Browser verification NOT PERFORMED.**

## 1. Register entry
"**New Item Request** capability: PR line = Existing Item OR New Item Request → approval/coding → becomes Stock Item. No free-text items." Open: model (draft product vs request entity), approver, how a request converts and relinks PR lines.

## 2. Evidence (code read)
- `purchase_request_lines.productId` is `uuid NOT NULL`; the same `productId` is copied 1:1 PR → RFQ line → quotation → PO line → GR line → stock movement / GRNI. Every downstream table keys on a Product id.
- `Product` already has a lifecycle **draft → active → discontinued** (`product-status.ts`); a new product is created as `draft`; `draft → active` is the "coding complete" step (`POST /products/:id/status`, permission `sales.catalog.edit`); creation is `sales.catalog.create`. `/products/all` (used by the PR picker) returns **all** statuses, so a draft product can already be put on a PR today.
- **Gaps:** (a) a requester without catalog permissions has no way to ask for an item; (b) nothing records *who asked / why / for which PR*; (c) nothing stops a PR → RFQ → PO → **GR (stock in)** of a product that was never approved/coded (a draft with SKU placeholder and unit price 0); (d) no approval step on item creation.

## 3. Options
| | A — Draft Product is the request (recommended) | B — separate `item_requests` entity + nullable `productId` on PR lines |
|---|---|---|
| Model | A Product row in status `draft` + a small `product_item_requests` record (requestedBy, reason, sourcePurchaseRequestId, decision, decidedBy) | New entity; PR/RFQ/PO lines carry `itemRequestId` until conversion, then **relink** to the new Product |
| Downstream blast radius | **None** — `productId` stays NOT NULL, chain untouched; no relinking ever (the id is stable through activation) | High — nullable `productId` across PR, RFQ, quotation, PO, GR lines; relink on conversion; every consumer must handle "no product yet" |
| Stock safety | Add one gate: a PR/PO line whose product is not `active` cannot reach PO approval / GR (fail closed before mutation) | Natural (no product, no stock) but needs the relink to be atomic |
| Approval/coding | Activation (`draft → active`) is the coding step, routed through the Approval Engine (maker≠checker) | Same, plus conversion |

## 4. Recommendation (for CTO decision)
1. **Model A.** "New Item Request" = create a `draft` Product (auto-numbered placeholder SKU `NEW-000001`, name + unit + optional notes, unit price 0) **plus** the request record, from the PR screen, requiring only `procurement.purchase_request.create`. The PR line references it by id like any other item.
2. **Approver / coding:** the request is an Approval Engine request type (`procurement.new_item_request`, 1 approver, node `sales.catalog.edit`, maker ≠ checker). On approval the approver (catalog owner) sets the final SKU / name / unit and the product becomes `active` — "becomes Stock Item". Rejection leaves the product `draft` and **blocks** every PR line that references it.
3. **Gate (fail closed):** a Purchase Request cannot be **approved / converted to RFQ**, and a PO cannot be created/approved, while any line's product is not `active`. (Existing PRs on active products are unaffected.)
4. **No free-text items** stays true: every line is a Product id.
5. Real-PG proof: request created by a non-catalog user; draft blocked at PR approval/RFQ/PO; approve → active → chain proceeds; reject → stays blocked; A/B isolation; closed controllers touched (purchase-request, rfq, purchase-order, products) re-run.

**Questions the CTO must answer (everything else follows):** (i) Model A as recommended? (ii) approver = holder of `sales.catalog.edit` via the Approval Engine, 1 approver — or the same 2-checker rule as bank accounts? (iii) gate at PR approval (recommended — earliest, cheapest) vs only at PO/GR?

## 5. CTO decision (2026-10-05) — adopted verbatim
Draft Product = the request, plus a small request record (requester, reason, approval/status history); `productId` stays NOT NULL in PR → RFQ → PO → GR (no nullable, no relinking). Approval: ONE approver holding `sales.catalog.edit` (not the bank-account two-checker model), enforced backend-side by the Approval Engine. Gate at PR approval, no bypass through RFQ/PO/GR.

## 6. Implementation
| Piece | Where |
|---|---|
| Request record (`product_item_requests`: productId unique, requestedBy, reason, status, approvalRequestId, decidedBy/At) + Company migration | `procurement/infrastructure/product-item-request.entity.ts`, `database/migrations/procurement/1789980000000` (registered in `PROCUREMENT_COMPANY_ENTITIES`) |
| `NewItemRequestService`: `create` (system SKU `NEW-000001` via numbering, draft product price 0, request, approval submit — one transaction), Approval Engine request type `procurement.new_item_request` (1 approver, node `sales.catalog.edit`), company-scope subscribers: approved → product `draft → active` + request approved + decider recorded; rejected → request rejected, product stays draft; list/get | `procurement/application/new-item-request.service.ts` |
| `ProductLifecycleGate` (via the published Sales product contract): `assertAllActive` at **PR approval** and RFQ creation; `assertNoneDraft` at **PO creation** and **Goods Receipt** — all before any mutation | `procurement/application/product-lifecycle-gate.service.ts`; wired in `purchase-request.service.ts`, `purchase-order.service.ts`, `goods-receipt.service.ts` |
| Sales contract: `createDraftProduct`, `activateDraftProduct` (catalog's own create / `setStatus` path — never a raw table write) | `foundation/module-registry/contracts/sales.contract.ts`, `commerce/application/products.service.ts` |
| Routes (Company-scoped from the start): `POST/GET procurement/item-requests` (create = `procurement.purchase_request.create`; view = `…view`); the decision itself is on the existing Approvals screen | `procurement/interface/new-item-request.controller.ts`; `ProcurementModule` imports `CommerceModule` (acyclic) |
| UI: "Request a new item" card + request list on the Purchase Requests screen; draft items flagged "pending item approval" on PR lines | `frontend/.../procurement/PurchaseRequests.tsx`; terminology core migration `1789990000000` |

**Gate semantics (as built):** PR approval and RFQ creation require every product `active`; PO creation and GR refuse `draft` only — an already-issued PO whose product is later `discontinued` keeps working (in-flight orders are not broken). SKU stays the system-issued `NEW-######` (the catalog has no SKU-edit route; not opened here).

## 7. Verification — CTO DoD (real PostgreSQL, isolated seeded cluster; Platform DB untouched)
Spec `procurement/interface/new-item-request.company-isolation.spec.ts` — **8/8**: (1) draft product + request record + pending approval needing `sales.catalog.edit`, 1 approver; (2) invalid request refused before ANY mutation (no product / request / approval, SKU not consumed); (3) PR with a draft line can be created/submitted but approval is refused before the transition (state unchanged, no RFQ), active-only PR approves and raises an RFQ normally; (4) PO with a draft item refused (no PO row), same PO on an active item created; (5) the maker cannot approve, and a user WITHOUT the node (role with only `procurement`) is refused ("Not authorized … sales.catalog.edit") — item stays draft; (6) a holder of the node approves → product `active`, request `approved` with decider recorded, then PR approval + RFQ + PO all pass, audit trail created→approved; (7) rejection leaves the product draft and the gate keeps blocking PR approval and PO; (8) A/B isolation — B sees none of A's requests/products, cannot decide A's approval (404), own SKU sequence, B's DataSource never requested for A's calls, Platform DB has no item-request table and no new-item approvals. **GR** gate proved in `goods-receipt.company-isolation.spec.ts` (new test): GR on a draft item refused, no movement / receipt written, posts again once active.
Note: the admin role in a Company already inherits `sales.catalog.edit` through the `sales` ancestor grant (the permission resolver walks ancestors) — that is legitimate authority, not a bypass; the negative case uses a role without it.

**Regression (single serial run on the isolated PG, same run):** procurement + commerce + inventory-warehouse + approval-engine + the two fixed-asset suites + the T0 baseline — **22 suites, 135 passed + 1 skipped (T0 baseline is skipped by design; its constructor wiring is compile-checked), 0 failed.** `grni-reconciliation.spec.ts` boots the full `AppModule` (3/3) — Nest DI wiring of the new providers/controller/module import proven. Backend `tsc` + frontend `tsc` clean; backend eslint clean on the touched files; `PurchaseRequests.tsx` only has the pre-existing `set-state-in-effect` warning. Existing specs that build the PR/PO/GR services by hand now pass a real, row-backed `ProductLifecycleGate` (`procurement/interface/product-lifecycle-gate.test-helper.ts`).

**Closed controllers touched (blast radius):** `purchase-request`, `purchase-order`, `goods-receipt`, `rfq` (via PO creation on award), `products` (contract methods only) — each re-run green above. New controller `procurement/item-requests` is Company-scoped from day one and proved by the D7 spec (Area 21 baseline 27/43 unchanged; the new controller is outside that 43).

## 8. Known limits / follow-ups
Browser verification not performed. Existing data: any open PO/PR that already references a `draft` product will now be refused at the next gate (by design — such documents bypassed the lifecycle before). `commerce.product.created` (price-list auto-add, external-integration publish) fires for a requested draft exactly as it does for any catalog-created draft — unchanged behaviour. SKU edit and non-stock (service) items remain out of scope.

## Status
**D7 = CLOSED (2026-10-05).**
