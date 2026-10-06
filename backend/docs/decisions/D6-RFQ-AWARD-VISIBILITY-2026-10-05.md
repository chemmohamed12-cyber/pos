# D6 — RFQ award: keep maker-checker, make it visible (2026-10-05)

**Status: POLICY CLEAR (CTO preliminary D6, no open decision) → IMPLEMENTED → INTEGRATED → REAL-PG VERIFIED → CLOSED (2026-10-05).**
Execution rule in force (CTO, 2026-10-05): a stage with no blocker / pending architectural decision / security-isolation risk starts immediately after the previous one closes.

## 1. Approved scope (CTO, D6 — decision register)
**Keep maker-checker.** Fix **visibility**: show `approvalRequestId` / "Pending Approval", surface the request in the Approval queue, and **ratify the checker rule**. No change to who may approve, no straight-through award.

## 2. Evidence (finding PRC-02 + code read, 2026-10-05)
- `POST /procurement/rfqs/:id/award` → `RfqService.awardToSupplier` submits a maker-checker request (`procurement.rfq_award`) and returns `{ approvalRequestId }`; the RFQ stays `sent` until a **different** user holding the node approves; only then `onAwardApproved` creates the Purchase Order from the winning quotation and moves the RFQ to `awarded`.
- **Gap (UI/visibility):** `Rfqs.tsx` threw the response away — no "submitted" state, no request id, no pending indicator, nothing telling the maker *why nothing happened*; the Award button stayed active, so the maker could submit **duplicate** requests; the Approvals queue listed the request only as a raw type code + action (no title, no resource, no maker, no rule), and offered Approve/Reject to the maker (who then got a 403).
- The RFQ controller/service were already Company-scoped (Area 21) — D6 therefore touches a **closed controller** (additive only) and re-proves it.

## 3. Ratified checker rule (recorded as-is — unchanged behaviour)
1. **Maker ≠ checker** (Approval Engine segregation of duties): the user who submitted the award can never approve it.
2. The checker must hold the permission node **`procurement.rfq_award` at `editable`** (the request's `resolvedRequiredNode`).
3. **Minimum approvers = 1** unless a Company's Approval Matrix rule for `procurement.rfq_award` says otherwise (no rule is seeded; the engine default applies; a Company can add one on the Approvals screen — `resolvedMinApprovers` / `resolvedRequiredNode` are shown on every request).
4. Consequence (by design, now visible): a Company with a single admin user cannot complete an award — it needs a second user holding the node.

## 4. Implementation (additive, no rule change)
| Piece | Where |
|---|---|
| `RfqService.getAwardApproval(rfqId)` — latest award request as a read-only view: `approvalRequestId`, `state` (pending / approved / rejected / …), `makerUserId`, `submittedAt`, `requiredNode`, `minApprovers`, `approvedCount`, supplier, total, and — once approved — `purchaseOrderId` / `purchaseOrderNumber` | `rfq.service.ts` (+ exported `RfqAwardApprovalView`) |
| `GET /procurement/rfqs/:id` now includes `awardApproval` | `RfqService.getById` |
| **One live award request per RFQ:** a second submission while the first is pending/escalated is rejected with the pending request id (a rejected/withdrawn/expired one can be re-awarded) | `awardToSupplier` |
| RFQ screen: status panel (Pending Approval + request id + who must approve + "you submitted this" + link to Approvals; Approved → PO number; Rejected → can re-award), submission notice with the request id, Award buttons hidden while pending | `frontend/.../procurement/Rfqs.tsx` |
| Approvals queue: request-type **title**, summary (supplier · total for an award), link to the resource (`/rfqs?id=`), "submitted by" ("You" for your own), the rule that applies (`node × approvers`); the **maker no longer sees Approve/Reject** on their own request ("a different approver is required") | `frontend/.../Approvals.tsx` |
| Terminology (12 keys, ar/en) | core migration `1789930000000-SeedRfqAwardVisibilityTerminology` |

## 5. Verification (real PostgreSQL)
**Spec:** `domains/procurement/interface/rfq-award-visibility.company-isolation.spec.ts` — **6/6**, real Company DBs A/B, real Approval Engine + RFQ + PR + PO services: (1) no award ⇒ `awardApproval` null; (2) submitted award visible — pending, request id, maker, node, 1 approver, supplier, total 47.50, RFQ still `sent`, no PO — inside `assertDataSourceNeverRequestedFor(B)`; (3) duplicate award rejected naming the request id, no second approval row; (4) **maker-checker unchanged** — maker cannot approve (still pending), a different user approves ⇒ approved, PO created and linked (number `PO…`), RFQ `awarded`; (5) rejected ⇒ visible as rejected, RFQ stays `sent`, re-award creates a new request; (6) Company B cannot see A's RFQ/award and has 0 approval requests / RFQs / POs / quotations.
**Blast radius (closed controllers) — all green:** `rfq-supplier` (4), `purchase-request`, `purchase-order`, `goods-receipt`, `supplier-invoice`, `supplier-invoice-ppv-vat` (D5), `supplier-payment`, `approval-engine.company-isolation` (8), `approval-expiry.scheduler` — **71/71 across 10 suites**. Backend build / `tsc` clean; backend lint clean (D6 files); frontend type-check clean.

## 6. Regression record (isolated seeded PostgreSQL — never `daii_dev`; stable `dist` snapshot)
**One full run: 144 suites / 914 tests — 891 passed, 22 failed (5 suites), 1 skipped (opt-in T0). Wording per CTO: 891/914 first run (+1 skipped); failures classified and cleared/isolated — not "clean".**
| Class | Suites | Disposition |
|---|---|---|
| Contention (60 s `beforeAll` AppModule boot under parallel load) | `wip-reconciliation` (5) | re-run serially: **5/5 PASS** |
| Environment-guarded by design (refuse to run unless `DB_PORT=5544`, the HR instance) | 4 `*.characterization.spec.ts` (17 tests) | not executed by choice; unrelated |
| D6-caused | none | — |

## 7. Known limits / follow-ups (disclosed)
1. **UI is type-checked, not browser-verified** (the shared dev server runs older code and an un-migrated terminology table; no preview run).
2. A checker needs `core.approval.view` to open the Approvals screen; the RFQ screen itself now tells any procurement user the request id, the required node and the approver count, but approving still happens on the Approvals screen. Whether the procurement approver role template should include `core.approval.view` is a role-template decision — recorded, not changed.
3. The Award button on the RFQ screen remains admin-gated (unchanged); the matrix rule for `procurement.rfq_award` is not seeded (engine default: 1 approver, node = the type code).
4. Generic request summaries/links exist only for `procurement.rfq_award` / `rfq`; other request types still show type title + action (follow-up for each domain as it is visited).

## 8. Incident (disclosed)
After D6 closed, a later full run showed `rfq-award-visibility` failing to compile: **another Claude session working in the same files had overwritten my D6 edits** in `rfq.service.ts`, `Rfqs.tsx` and `Approvals.tsx`. I re-applied them (idempotent scripts), re-ran type-checks and the D6 specs — `rfq-award-visibility` 6/6, `rfq-supplier` 4/4, `approval-engine` 8/8 (18/18) — and asked that session to re-read before editing. All other D1–D6 markers were verified present. Lesson recorded: after any parallel-session period, re-grep each stage's markers before trusting an earlier green run.

## Status
**D6 = IMPLEMENTED / INTEGRATED / REAL-PG VERIFIED / CLOSED (2026-10-05).** Next gate in the CTO order: D1 (real Item↔Warehouse assignment).
