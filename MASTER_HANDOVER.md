# Daii ERP — Master Handover / History

**Consolidated 2026-08-24.** This file replaces 17 individual root-level session handover/report
files (`HANDOVER_*.md`, `FINAL_DELIVERY_PACKAGE.md`, `LIVE_E2E_REPORT.md`,
`PHASE_B_CUSTODY_RETURNS_PROGRESS.md`, `RELEASE_PACKAGE_ORDER_TO_TREASURY_CYCLE.md`) — their
durable content (decisions, what was built, known limitations, unfinished threads) is preserved
below by topic; the originals have been deleted after this content was verified to carry everything
actionable forward. For **current** status (what's verified working right now), see
[`MASTER_PROJECT_STATUS.md`](MASTER_PROJECT_STATUS.md) — this file is history/narrative, that one is
the live truth. For architecture, see [`MASTER_ARCHITECTURE.md`](MASTER_ARCHITECTURE.md).
`planning/v1-release/` and `planning/stage-*/` are kept separately — they're an organized historical
release archive (deployment guide, rollback guide, security audit, changelog, stage-by-stage
planning), not duplicative session logs, and are cross-referenced from `MASTER_ARCHITECTURE.md`.

---

## 1. Build order (chronological narrative)

Daii was built in roughly this sequence, each phase's real defects and decisions noted:

1. **V1 core** (2026-08-22): Sales Orders, Inventory/Warehouse, Fulfillment, Shipment/Delivery,
   Customers, Products/Pricing, Excel import/export, Printing (Sales Order/Waybill), Arabic/English
   terminology, Treasury basics. Released as a real V1 with backup/restore verification
   (`pg_dump`/`pg_restore` round-trip, exact row-count match). Backend at that point: 37 suites, 223
   tests. See `planning/v1-release/` for the full V1 release archive (kept, not consolidated here).
2. **Item Preparation**: per-item pick with a real "تحت التجهيز" (Under Preparation) sub-location,
   "تم"/"تم للجميع" actions, Preparation Review before Packing — all reusing the existing
   `stock_reservations`/`stock_movements` ledger via a new `relocateReservedStock` primitive (moves
   a reservation and its goods together, never a second inventory mechanism).
3. **Order→Treasury cycle reconciliation** (`RELEASE_PACKAGE_ORDER_TO_TREASURY_CYCLE.md`, now
   consolidated): Item Preparation's stock relocation broke two adjacent assumptions —
   `FulfillmentService.transitionPackTask` was dispatching the ledger (a full, final exit) at
   pack-close, before any shipment/pickup/custody transfer existed, and
   `ShipmentService.transferCustodyOnPickup` hardcoded the Fulfillment Order's original warehouse as
   the transfer source instead of wherever Preparation had actually since moved the goods. **Fixed**:
   pack-close no longer touches the ledger at all (only announces
   `fulfillment.ready-for-dispatch`); custody transfer at pickup now resolves its source from the
   order's own live `StockReservation` rows (which Preparation already keeps in sync);
   `DeliveryService.recordOutcome` became **the single, one-time, final ledger exit**, firing only
   on a genuine `'delivered'` outcome, sourced from wherever the goods currently sit
   (`getCurrentCustodyWarehouseId`). A `failed`/`refused`/`returned` outcome dispatches nothing — the
   goods never reached the customer. This is the authoritative data-flow reference for the whole
   Order→Delivery→Treasury chain; see `MASTER_ARCHITECTURE.md` for the current-state version.
4. **Sales Order edit-lock + audit trail**: after deposit approval, editing restricted to
   admin/finance, full field-level audit trail with before/after values.
   **Real bug found and fixed later, same thread**: `finance` role was blocked by the Scope Engine
   from approving a deposit on an order not explicitly assigned to them (`ScopeService.
   UNRESTRICTED_ROLES` was `['admin']` only) — fixed via the `isReviewerOrAdmin` per-call-site
   bypass pattern (not by widening `UNRESTRICTED_ROLES` globally); **re-confirmed live against the
   running backend** in a later session (see `MASTER_PROJECT_STATUS.md`).
5. **Sales Order draft delete + Shipping Method field**: permission-gated draft deletion, Shipping
   Method added to the Sales Order entity and its own detail screen header.
6. **RSH Shipping Orders**: auto-created the moment a Sales Order's Pack Task closes, via the
   existing `Shipment` entity (no parallel shipping-order system) — `RSH-YYYY-NNNNNN`, an
   independent numbering sequence (not literally "the SO number with an RSH prefix," despite that
   being the original directive's literal wording — a later session explicitly decided to keep the
   independent sequence rather than force a retrofit migration; see `MASTER_PROJECT_STATUS.md` §4).
7. **Shipping Company / Vehicle Custody**: third-party company and in-house vehicle custodians, each
   auto-provisioned an Operational Sub-location (goods) and a Custody Treasury account (money) via
   the Numbering Engine — **a real bug found live** during this build: naming those codes off the
   custodian's own code overflowed a `varchar(32)` column for a long custodian code (500 error, not
   a validation error) — fixed by generating both codes through the Numbering Engine instead of
   string concatenation.
8. **Carrier Waybill-required flow**: server-side block on shipment pickup when a company-routed
   shipment is missing its carrier waybill number/image.
9. **Custody Visibility (resumed)**: per-custodian detail page (`CustodianDetail.tsx`), Custody/COD
   reporting, Collection Settlements as its own screen.
10. **Returns Engine, Phase A (Customer Returns) + Phase B (Shipping/Vehicle Custody Returns)**: full
    Request→Inspection→Disposition flow for both origins, reusing the same disposition pipeline;
    custody-origin returns never create a customer credit (goods never reached the customer) and are
    dispatcher-auto-authorized rather than routed through customer-facing approval.
11. **Customer Financial Account / Invoice / AR / Treasury integration**: real Customer Ledger
    subledger (append-only, `CustomerLedgerService.getCustomerBalance` the only place a balance is
    computed), Sales Invoices, Payments, AR Aging, Return Credits, wired into Treasury/Deposit
    Control/COD.
12. **Section Covers / Dashboards**: the shared `SectionCover` component (shortcut row + real KPI
    tiles + optional `MiniBarChart`) rolled out to Sales, Warehouses, Fulfillment, Shipping, Catalog,
    Treasury, Administration.
13. **Printing extensions**: `PickListPrint.tsx` switched from raw Sales Order lines to real
    `PickTaskLine` rows (shows Prepared/Requested + per-item status, not just what was originally
    requested).
14. **Financial UI Integration** (this year's later session): the Financial Core from #11 existed as
    backend + a couple of isolated pages but wasn't properly surfaced in the main ERP nav — added the
    "العملاء والحسابات" nav group, its Section Cover, Customer Accounts List, dedicated Customer
    Statement, Invoices/Payments/AR Aging list screens, enriched Customer Account header, Return
    Credits table, full cross-navigation, 3 new print pages. **Two real bugs found and fixed** during
    Browser E2E verification: the Return Credits table showed a raw Sales-Order UUID instead of its
    readable number, and the Customer Statement showed a raw ledger-entry UUID instead of its
    readable `CLE-2026-XXXXXX` number for deposit/return-credit rows specifically (root cause: the
    Statement page and the Account page's own ledger tab were reading two different endpoints with
    differently-shaped `reference` fields — not actually "the same endpoint" as originally claimed).
15. **Master continuation / release-readiness pass** (this session): four parallel domain audits
    reconciling every handover above against actual running code; closed the vehicle-custody
    gaps (sales-rep traceability, custody-warehouse closing via the existing Stock Count mechanism,
    settlement-transfer via the existing `transfer` warehouse-transaction type); added the missing
    Reports Section Cover; fixed a real `activeShipmentsCount` bug and a real N+1 performance issue;
    ran a security spot-check; wrote this consolidation. Full detail in `MASTER_PROJECT_STATUS.md`.

## 2. Known limitations carried forward (still open, not resolved by any session above)

From the V1-era `KNOWN_LIMITATIONS.md` (`planning/v1-release/`), still true as of this consolidation
unless marked otherwise:
- Historical `priceListPrice` backfill gap (pre-price-list orders) — unaffected by later work.
- QR intake order-creation picks the first active warehouse rather than a real warehouse-selection
  policy — not addressed by any later session.
- Pre-reservation-era orders have `warehouseId=null` — unaffected by later work, cosmetic only.
- No cross-warehouse activity-by-user report — `Reports.tsx` still has no such tab.
- Password-change session re-entry gap (changing your own password doesn't immediately force
  re-login on other active sessions) — not addressed.
- Migration timestamp/FK hygiene items — not addressed, low priority.
- `.env.example` incomplete — not addressed.

From `FINAL_DELIVERY_PACKAGE.md` (a later, still-current set, resolved marked explicitly):
- Cold-terminology-cache flash on print pages on first load — not resolved.
- Driver shown as a raw UUID instead of a name on some prints — not resolved.
- ~~`activeShipmentsCount` semantics (counted all-time shipments, not actually-active ones)~~ —
  **RESOLVED this session**, see `MASTER_PROJECT_STATUS.md`.

## 3. Unfinished, separate-repo work: the QR ↔ Daii live handshake

**Not part of the Daii ERP itself** — a cross-repo integration effort against a separate,
independent codebase (`../xnexus-website/`, the QR Platform, referenced in `_source-audits/` but
normally read-only; a directive explicitly authorized building the QR-side bridge for this one task).
**Left mid-task on an explicit stop instruction, both dev servers cleanly shut down.** Progress
against the CTO's 12-step checklist:

| # | Step | Status |
|---|---|---|
| 1 | Pair QR with Daii | ✅ Done live |
| 2 | Test connection | ✅ Done live |
| 3 | Publish one product | ✅ Done live — all 13 Daii products bulk-published, verified matching on QR |
| 4 | Change price → verify QR receives it | ⏳ Unblocked (a real gap was found and fixed — Daii had no `updatePrice` at all; built, tested, deployed) but the actual re-test call was never made |
| 5 | Change/verify availability | ❌ Not started (endpoint exists, mapping already exists from step 3) |
| 6–10 | Real order QR→Daii, verify exactly one Sales Order, retry, verify no duplicate | ❌ Not started |
| 11–12 | Change Daii order status, verify QR receives it | ❌ Not started |

**To resume:**
```bash
# Terminal 1 — Daii backend
cd Daii/backend
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=daii DB_PASSWORD=daii_dev_only DB_NAME=daii_dev PORT=3500 node dist/main.js
# Terminal 2 — QR Platform
cd ../xnexus-website
node server/server.js   # listens on :4000
```
- **Always use `127.0.0.1`, never `localhost`**, for both curl and any config value on this machine
  — `localhost` resolves to `::1` first and neither server reliably accepts that.
- Pairing state persists (Postgres row / QR's `data/daii-integration.json`) — restarting both
  servers should not require re-pairing; connector id `f49d3eb1-c6bf-4773-a0a2-262239db76e2`
  (confirm it still reads `"connected"`, re-pair with a fresh shared token if not).
- Credentials: Daii admin `admin@daii.example` / `DemoPass123`; Daii rep (connector's
  `systemUserId`) `rep1@daii.example` / `DemoPass123`; QR CMS test admin
  `daii-handshake-admin` / `DaiiHandshake123` (local-dev-only, safe to leave or delete).
- Step 4's target: product `e7a300ad-7de4-43f8-b877-1e38850d993c` (SKU `HANDSHAKE-LAMP-1`) — call
  `POST /api/products/e7a300ad-7de4-43f8-b877-1e38850d993c/price {"unitPrice":"88.00"}` as any
  authenticated Daii user, then re-check QR's `GET /api/daii-integration/products` for that
  `daiiProductId` showing the new price.
- Known pitfalls already hit and fixed (don't re-debug): `stock_movements.movementType` was too
  narrow for `'assembly_consumption'` (fixed via migration, already applied); a QR-side
  `require()`-before-instantiation ordering bug (fixed); the `localhost`/`127.0.0.1` quirk above.

## 4. Where the real company data lives

`احمد/` (a folder of real spreadsheets from the actual client — Al-Gharbia Company for
Assembly & Manufacturing of Lighting Supplies/LED Lamps, provided by the CTO as the company's live
operating data: pricing, investments, fixed assets, custody, expenses, payroll, treasury, suppliers,
customer analysis) was the source for `planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md`,
which fed the Excel import/export feature. **Excluded from git** (see `.gitignore`) as sensitive real
data, not application code. Confirm with the CTO whether it should remain in the workspace, move
somewhere access-controlled, or be deleted now that its analysis has been consumed.

## 5. Files this document replaces

`FINAL_DELIVERY_PACKAGE.md`, `HANDOVER_CUSTOMER_FINANCIAL_ACCOUNT_INVOICE_AR_SESSION.md`,
`HANDOVER_FINANCIAL_UI_INTEGRATION_SESSION.md`, `HANDOVER_ITEM_PREPARATION_SESSION.md`,
`HANDOVER_PHASE4_CARRIER_WAYBILL_SESSION.md`, `HANDOVER_PHASE5_CUSTODY_VISIBILITY_RESUMED_SESSION.md`,
`HANDOVER_PHASE6_SECTION_COVER_DASHBOARD_SESSION.md`, `HANDOVER_PHASE7_PRINTING_SESSION.md`,
`HANDOVER_QR_HANDSHAKE_SESSION.md`, `HANDOVER_RETURNS_CUSTOMER_RETURNS_SESSION.md`,
`HANDOVER_RSH_SHIPPING_ORDERS_SESSION.md`, `HANDOVER_SALES_ORDER_DRAFT_DELETE_SHIPPING_METHOD_SESSION.md`,
`HANDOVER_SALES_ORDER_EDIT_LOCK_SESSION.md`, `HANDOVER_SHIPPING_CUSTODY_SESSION.md`,
`LIVE_E2E_REPORT.md`, `PHASE_B_CUSTODY_RETURNS_PROGRESS.md`, `RELEASE_PACKAGE_ORDER_TO_TREASURY_CYCLE.md`
— all deleted from the repository root after this content was verified to carry forward everything
actionable. Recoverable from git history (`4187e7d` baseline commit onward) if ever needed.
