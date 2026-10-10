# Daii ERP — Master Project Status

**Last reconciled: 2026-08-24.** This is the authoritative, cross-checked status of the project —
built by reading every prior handover/report **and** verifying each claim against the actual
running code, tests, and (where practical) the live application, not by trusting any single
document at face value. The 17 individual root-level `HANDOVER_*.md`/report files this was built
from have since been consolidated into [`MASTER_HANDOVER.md`](MASTER_HANDOVER.md) (history/
narrative) and deleted — this document is the one to trust for "is X actually done" *right now*;
`MASTER_HANDOVER.md` is where to look for *how it got this way*. `planning/v1-release/` remains as
a distinct, organized historical release archive (not consolidated — see `MASTER_ARCHITECTURE.md`).

**How this was built:** four parallel code-and-test audits (Sales Order/Sales Control;
Preparation-Fulfillment/RSH; Shipping Company/Vehicle/Custody/Returns; Section Covers/Printing/docs
inventory), each reading the relevant handover(s) in full and independently verifying every claim
against `backend/src/**` and `frontend/src/**` (file:line citations, test presence/absence) —
followed by this session's own further fixes and live browser verification for anything the audits
flagged as open.

---

## 1. Overall verdict

**Backend:** 43/43 test suites, 550/550 tests passing (re-confirmed after every change this
session — see §3 for how the count grew). **Frontend:** typecheck clean, production build clean.
**Database:** all migrations applied through `1755852100000`, no pending migrations, no
`synchronize` usage anywhere (forward-only migrations only).

The ERP is **feature-complete for every domain the CTO directive named**, with a small number of
genuinely open items (§4) and a larger number of housekeeping items (§5, §6) still ahead before a
final release candidate can be cut.

---

## 2. Domain-by-domain status

### Sales Order / Sales Control — VERIFIED
Edit-lock after deposit approval (finance/admin only, reason-required), full line-level audit trail
(`GET /sales-orders/:id/edit-history`), draft delete with ownership/status/FK-conflict handling,
Shipping Method field (entity + UI + print), and a single clear header showing
customer/phone/governorate/address/rep/shipping-method are all implemented and covered by backend
tests (`sales-orders.service.spec.ts`). RSH document data is embedded in Waybill/Delivery prints
(no separate RSH print page) — see §4.3 for whether that's sufficient.
**This session:** confirmed live (not just at the source level) that the previously-flagged
`finance` role + Scope 404-on-deposit-approval bug (`task_cf32e266`) is genuinely fixed against the
running backend.

### Preparation / Fulfillment — VERIFIED
Per-item pick (`PickTaskLine`), prepared-quantity tracking, "تم"/"تم للجميع" actions, a real
Preparation sub-location (`PREP-######`), a Preparation-Review state (`pending_verification`)
before Packing, and stock-conservation via `InventoryService.relocateReservedStock` under advisory
locks are all implemented and unit-tested (`fulfillment.service.spec.ts`).

### RSH Shipping Orders — VERIFIED (one disclosed deviation)
Sales Order → Ready-for-Shipping → RSH auto-creation, 1:1 linkage, appears in the Shipping screen,
linked from the Sales Order detail, and reuses the existing `Shipment` entity (no parallel shipping
system). **Deviation from the literal directive wording:** RSH numbers are an independent sequence
(`RSH-YYYY-NNNNNN`), not "the SO's own number with an RSH prefix" — this was a deliberate design
choice by the implementing session, tested and working, just not literally matching the original
phrasing. Not changed this session; flag to product if literal number-mirroring is actually
required.

### Shipping Company — VERIFIED
Shipment↔customer/SO/RSH linkage, company selection, waybill/policy number + image upload,
server-side blocking of pickup when required fields are missing, full status lifecycle, custody
(goods stay off the ledger until actual delivery), COD, Collection, Settlement (two-leg Treasury
transfer), and a per-company balance are all implemented and covered by
`shipment.service.spec.ts`/`delivery.service.spec.ts`. Goods-custody (physical stock) and
financial/collection balance are correctly tracked as two separate numbers
(`getCustodianOverview.stock` vs `.custodyBalance`).
**Confirmed by your decision this session:** the custody chain is correctly direct
(Preparation → final custodian) — no intermediate Shipping-Warehouse leg is needed; this matches
current behavior, no change required.

### Company Vehicle Shipping — NOW COMPLETE (was 3 gaps, closed this session)
Vehicle selection, vehicle custody warehouse, delivery/closing, and COD→Treasury flow were already
solid. Three real gaps found by this session's audit — **all three closed this session**, per your
explicit decisions:
- **Sales-rep traceability** — `Shipment` now snapshots `salesRepUserId` at creation (backfilled
  for existing rows); shown on `Shipments.tsx` and `CustodianDetail.tsx`.
- **Vehicle custody-warehouse closing/reconciliation** — new "إغلاق عهدة السيارة" card on
  `CustodianDetail.tsx` (vehicle only), built entirely on the **existing** Stock Count
  (`count`-type `WarehouseTransaction`) mechanism for the variance+approval workflow you asked for.
- **Vehicle → warehouse settlement** — same card's "ترحيل المتبقي إلى المخزن" button, built on the
  **existing** `transfer`-type `WarehouseTransaction` — no new document type, per your "investigate
  reuse first" decision; reuse turned out to be fully sufficient.
- **In-house driver custody account** — confirmed by your decision: not needed, no change required.

**Real bug found and fixed in the process:** `getCustodianOverview.activeShipmentsCount` was
counting every shipment a custodian had *ever* handled, including long-delivered/returned ones —
meaning a vehicle that had done even one shipment could never be closed. Already disclosed as a
known limitation (`MASTER_HANDOVER.md` §2); now actually fixed (filters by current Process
Engine state) and covered by a new regression test.

### Returns Engine — VERIFIED, no gaps found
Both the Customer Return and Shipping/Vehicle Custody Return flows (Inspection → Disposition) are
complete and correctly enforce: no credit for goods that never reached the customer, no phantom
ledger entries, no inventory loss/duplication, an enforced over-return cap, and correct Return
Credit issuance rules. `returns.service.spec.ts` covers all of this. One disclosed low-risk item
not fixed (see §4.4).

### Customer Financial Account / Invoice / AR / UI Integration — VERIFIED (this session)
Full ERP UI integration completed and Browser-E2E-verified this session against the previously-built
Financial Core: Section Cover, Customer Accounts List, Customer Statement, Invoices, Payments, AR
Aging, enriched Customer Account header, Return Credits table, full cross-navigation, printing (all
3 document types), and role-based Scope filtering (`rep1` correctly sees 31/47 customers). Two real
UI bugs found and fixed during that verification (raw-UUID-instead-of-readable-reference in two
places) — see `MASTER_HANDOVER.md` §1 (build step 14) for full detail; this status file doesn't
repeat it.

### Section Cover / Dashboard System — NOW COMPLETE (was 1 gap, closed this session)
9 of 10 required sections already had a proper Section Cover (shortcut row + real KPIs, several with
a `MiniBarChart`). **Reports (التقارير) was the one gap — closed this session**: new
`ReportsCover.tsx` with shortcuts that deep-link into specific report tabs (`Reports.tsx` now reads
`?tab=`) and real KPIs (open orders, active shipments, open returns, AR outstanding for
admin/finance). Home (`/`) still uses the pre-existing `Dashboard.tsx` rather than the shared
`SectionCover` component — functionally equivalent (shortcuts + real data), just not on the newer
shared design system; not changed this session, low risk either way (see §5).

### Printing — VERIFIED
All 17 print pages under `frontend/src/pages/print/` go through the one shared
`PrintDocument.tsx`/`documentTypes.ts` renderer — confirmed no duplicate print system exists.
Sales Order, Waybill/Shipment, Customer Statement, Invoice, Payment Receipt, Returns, and
Custody/Collection/Settlement all have working print buttons wired to real routes, including a new
**Collection Receipt** (`CollectionReceiptPrint.tsx`, added this session — see §3) that closes what
was previously the one financial record type in the whole app with no print receipt at all. RSH has
no standalone print page (its number is embedded in Waybill/Delivery prints) — same open question as
§2's RSH item, deliberately not built (§4 item 2).

---

## 3. What changed THIS session (continuation work, in order)

1. Initialized git for the repository (previously untracked) as a safety baseline before any
   further work, with a `.gitignore` excluding `node_modules`, build output, logs, `.env`, and the
   `احمد/` folder (real business spreadsheets — see below).
2. Four parallel domain audits (this document's primary source).
3. Confirmed live that `task_cf32e266` (finance/Scope deposit-approval 404) is genuinely fixed.
4. Added `salesRepUserId` traceability to `Shipment` (migration + entity + service + 2 frontend
   screens), live-verified.
5. Added the missing Reports Section Cover, live-verified (and fixed an `AR aging` field-name bug
   caught during that verification: `remaining`, not `remainingAmount`).
6. Asked you 4 targeted questions on the open Vehicle/Custody business decisions (closing semantics,
   settlement-order necessity, custody-chain depth, in-house-driver custody) — all four answered
   and implemented/confirmed.
7. Built Vehicle Custody closing (Start Count + Transfer Remaining Stock, 100% reused mechanisms)
   and fixed the `activeShipmentsCount` bug that would have made it unusable, live-verified
   end-to-end (real transactions `WH-TR-2026-000002` / `WH-CNT-2026-000002` created correctly).
8. Consolidated 17 root-level handover/report files into `MASTER_HANDOVER.md`, fixing 2 real broken
   references in the process (a source-code comment, two README mentions), then deleted the
   originals — see `MASTER_HANDOVER.md` §5 for the full list.
9. Measured performance on 11 hot endpoints, found and fixed a real N+1 query in
   `ReportsService.getSalesOrdersReport`; precisely documented (not fixed) a real 5-endpoint
   pagination gap; ran a full security spot-check (secrets, `.env`, bcrypt, guards, SQL parameterization
   all clean) and found + fixed a real gap — no rate limiting existed anywhere, including on login.
   Added `@nestjs/throttler`, live-verified (10 rapid login attempts → `429` from the 10th onward).
10. Verified the on-prem/LAN port-adapter architecture claim against real code (found a genuine
    `object-storage.port.ts`/adapter pair, no cloud-SDK coupling anywhere) and confirmed a shared
    `IdempotencyService` genuinely exists (correcting an earlier wrong guess).
11. Built Collection Receipt printing (`CollectionReceiptPrint.tsx` + a new finance/admin-gated
    `GET /delivery/collections/by-shipment/:shipmentId` route reusing an existing unscoped read) —
    closed what had been the one financial record type with no print receipt at all, live-verified
    end-to-end.
12. Added per-account login lockout (`Credential.failedLoginAttempts`/`lockedUntil`, checked before
    the bcrypt compare) — 5 consecutive failed attempts locks the account for 15 minutes, rejecting
    even the correct password, closing what per-IP rate limiting alone can't (a slow/distributed
    attack against one account). 4 new tests; live-verified (`fin1@daii.example` locked after 5 wrong
    attempts, `admin@daii.example` unaffected — confirmed per-account, not global).
13. Verified, by grepping every migration, that none seed fake business data into `customers`/
    `sales_orders`/`shipments`/`products` — the release artifact (source + migrations) is already
    clean of test data by construction; only the shared live dev database accumulates it, which is
    separate dev-environment hygiene, not a release-readiness blocker.
14. Closed §7's last disclosed gap — a real, live, browser-driven E2E for Returns (both origins) and
    Custody/Collection Settlement, not just the existing unit-test evidence (full detail in §7's own
    rewrite below). Found and fixed **two real, live-discovered bugs** in the process, both the same
    class as the already-fixed `task_cf32e266` (a qualified role missing from a Scope-bypass
    allow-list, because Scope assignments are inherently per-sales-rep and this role was never
    individually assigned to the resource):
    - **`CustomersService.REVIEWER_ROLES` (`crm/application/customers.service.ts:24`) was missing
      `finance`** — every customer-scoped read gated through `getCustomer`/`listCustomers`
      (invoice creation, Customer Statement, AR aging, the Customer Accounts List,
      `/customer-finance/balances`) 404'd or silently returned an empty list for a `finance` caller
      on any customer they weren't individually Scope-assigned to, i.e. almost every customer —
      live-reproduced (`fin1` creating an invoice for a real order 404'd; `GET /customer-finance/
      balances` returned `[]` instead of 47 rows). **Fixed**: added `finance` to `REVIEWER_ROLES`.
      2 new regression tests in `customers.service.spec.ts`.
    - **`ShipmentService.getShipment`/`getTrackingHistory` (`shipment/application/shipment.service.ts`)
      only ever allowed the assigned driver or an admin** — the exact route
      `CollectionReceiptPrint.tsx` (this session's own new Collection Receipt page, §3 item 11) calls
      to enrich the receipt with the waybill/RSH/SO number, and it 403'd for `fin1` live in the
      browser (`Only the assigned driver (or an admin) may act on this shipment.`) even though
      printing that exact receipt is a `finance`-gated action one route over. **Fixed with a
      deliberately separate, read-only `assertCanReadShipment` helper** (admin/finance/assigned-driver)
      — `assertDriverOrAdmin` itself was left untouched and still gates every actual driver ACTION
      (pickup/depart/carrier-waybill/recordCollection), so `finance` can now print a receipt but still
      cannot dispatch a shipment. 2 new regression tests in `shipment.service.spec.ts`.
    - Both fixes live-reverified after landing: `fin1` created/posted an invoice and saw the full
      47-customer balances list; the Collection Receipt for shipment `28afbe30-...` rendered correctly
      in the browser as `fin1` (waybill `WB-2026-000020`, RSH `RSH-2026-000013`, amount `130.00`).
    - **Disclosed, not fixed**: `GET /shipments/custody-search` (backs the "current shipments in
      custody" table on `CustodianDetail.tsx`) is gated to `admin`/`warehouse_worker`/
      `sales_supervisor` only — a `finance` viewer of that same page sees the KPI stat "Active
      shipments: 1" correctly but the table below it silently renders "no matching results" for
      what's actually a 403, not a real empty set. Different in kind from the two bugs above (those
      blocked the intended actor of a finance-gated route from doing the exact thing the route exists
      for; this is a legitimate open question of whether `finance` should see custody-return-candidate
      shipments at all, not a clear-cut access bug) — left as-is per this session's "investigate,
      don't assume" discipline; flag to product if finance visibility into that specific table is
      actually wanted.

Backend: 43/43 → 43/43 suites, 524 → 537 → 548 tests throughout this session (this work's own tests:
1 `activeShipmentsCount` regression test + 4 login-lockout tests + 2 `REVIEWER_ROLES`/finance tests +
2 `assertCanReadShipment`/finance tests = 9; the rest landed from the concurrent session's own
parallel commits — both tracked and verified green together, not conflated). Frontend: typecheck and
production build re-confirmed clean after every change, including after this session's own two fixes.

**Noted, not fixed, pre-existing, unrelated to this session's work:** `CUST-000005` has corrupted
(mojibake) name/governorate data in the seed dataset — a data-quality issue, not a code bug (compare
`CUST-000006`, a correctly-encoded row with the same evident test intent).

---

## 4. Open items requiring a decision or further work (not blocking, but real)

1. **RSH numbering scheme — DECIDED, no code change.** Kept as the current independent
   `RSH-YYYY-NNNNNN` sequence rather than migrating to "SO number with an RSH prefix." Rationale:
   the current scheme is live, tested, and referenced by real data; retrofitting literal
   number-mirroring would need a data migration touching every existing RSH number with real
   collision/uniqueness risk, for a purely cosmetic difference from the original phrasing — not
   proportionate given "REUSE FIRST" / "minimal architectural change" guidance. Reversible later if
   product explicitly requires literal mirroring, but not a default worth forcing.
2. **Dedicated RSH print page — DECIDED, not built.** RSH data (number, SO, customer, items) is
   already fully visible on the existing Waybill/Delivery prints. A standalone RSH-only print
   document would duplicate that same information through a second document type for no clear new
   use case. Treated as satisfied by the existing embedding; revisit only if a concrete scenario
   surfaces where someone needs the RSH specifically, separate from the Waybill.
3. **`CustodianDetail.tsx` and `CollectionSettlements.tsx` had no own print button — both fixed
   this session.** `CustodianDetail.tsx` wired to the existing `/print/custody/:type/:id` route.
   `CollectionSettlements.tsx` gained a new `CollectionReceiptPrint.tsx` (keyed by `shipmentId`, a
   new finance/admin-gated `GET /delivery/collections/by-shipment/:shipmentId` route reusing the
   already-existing `getCollectionForShipmentUnscoped` read — no new query). Initially deferred
   earlier this session due to a collision risk with a concurrent session then actively mid-edit in
   the same Delivery domain; implemented once `git log`/`git status` confirmed their work had moved
   on to `Shipments.tsx` UI only. Both live-verified end-to-end against real data.
4. **`ReturnsService.initiateCustodyReturn` is not wrapped in a single top-level transaction** —
   disclosed as low-risk by the original implementer; investigated this session and *deliberately
   not changed* — the codebase's consistent pattern throughout Returns is per-step atomicity via
   advisory locks, not cross-service transactions, and a naive `dataSource.transaction()` wrapper
   would not actually make the sub-service calls atomic (they use their own connections) while
   introducing new lock-contention risk. A real fix would need `InventoryService`/`ShipmentService`/
   the process engine to accept a shared transactional manager — a larger, cross-cutting change than
   its actual (low, disclosed) risk currently justifies.
5. **Home (`/`) dashboard not on the shared `SectionCover` component** — cosmetic/consistency only,
   functionally complete either way.

---

## 5. Housekeeping backlog (before a final release candidate)

- **Documentation consolidation (directive §12) — DONE.** `MASTER_ARCHITECTURE.md` (indexes the 18
  `architecture/DAII_*.md` files with current-implementation reconciliation) and `MASTER_HANDOVER.md`
  (durable "how this system works" history, session-scoped noise discarded) both exist; the 17
  original root-level `HANDOVER_*.md`/report files they replace were deleted after their content was
  verified carried forward (`MASTER_HANDOVER.md` §5 lists exactly which). `FINAL_RELEASE_REPORT.md`
  is written once the release gate in §8 actually passes, not before.
- **Test-data cleanup (directive §11) — DONE, see §8a for full detail.** A scoped, reviewed cleanup
  ran against `daii_dev`, backed by a verified `pg_dump` safety backup, removing every customer/order/
  shipment/etc. created by E2E and browser-verification sessions while preserving the 2 baseline
  customers (`CUST-000001` Acme Trading Co., `CUST-000002` Beta Retail LLC) other still-referenced
  fixtures depend on. Two real data-integrity bugs surfaced and were fixed during post-cleanup
  verification — see §8a.
- **`LOCAL_DEV_CREDENTIALS.md` — DONE.** `fin1@daii.example` documented as a permanent persona.
- **The `احمد/` folder and `احمد.zip`** (23 MB, real company spreadsheets — pricing, investments,
  fixed assets, custody, expenses, payroll, treasury, suppliers, customer analysis for the actual
  client, "الشركة الغربية لتجميع وتصنيع مستلزمات الاضاءة") — excluded from git as sensitive real
  data, not application code. **Still open**: confirm with the CTO whether this should stay in the
  workspace at all, move somewhere access-controlled, or be deleted once its Excel-mapping analysis
  (`planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md`) is confirmed no longer needed. Not
  resolved by this session — a business decision, not something safely inferable.

---

## 6. Cross-cutting readiness (directive's "Performance + Local Deployment + Security + Future PC")

A full architecture-level treatment of on-prem/LAN readiness, security, and future licensing
already exists and is now indexed in [`MASTER_ARCHITECTURE.md`](MASTER_ARCHITECTURE.md) §5 — most
of it was already designed (several ADRs already **ACCEPTED**), not a from-scratch gap. What's
genuinely new this session:

**Performance — measured, not impressionistic, per the directive's own instruction.** Timed 11 hot
list/report endpoints against the live backend with real data (47 customers, 74 sales orders, etc.):

| Endpoint | Rows | Latency |
|---|---|---|
| `/customers`, `/inventory/warehouses`, `/ar-aging`, `/invoices`, `/payments`, `/shipments`, `/returns`, `/customer-finance/balances` | 1–47 | Consistent 108–140ms across repeated runs |
| `/sales-orders`, `/reports/sales-orders`, `/reports/sales-by-rep`, `/reports/sales-by-period`, `/reports/sales-by-customer` | 1–74 | **174–499ms, inconsistent across repeated runs of the same request** |

Found a real, confirmed N+1 pattern in `ReportsService.getSalesOrdersReport` (`reports.service.ts`)
— a sequential `for...of` loop awaiting a per-order status lookup + deposit lookup, one order at a
time, for every row. **Fixed**: parallelized via `Promise.all` (same queries, same result shape and
ordering, issued concurrently instead of sequentially) — backend re-tested clean (43/43, 533/533)
and typecheck clean.

**Follow-up, now resolved.** The earlier session's own hypothesis — that `/sales-orders`-family
latency's high, inconsistent readings (174–499ms, same request/data) were concurrent-DB-contention
noise from another session actively working against this same dev database, not a real bottleneck —
is now confirmed. Re-measured in this continuation session once that concurrent work had finished:
5 repeated `GET /sales-orders` calls in isolation landed a **consistent 121–142ms**, matching the
"fine" endpoint family, not the earlier erratic one. Also acted on this section's own remaining
suggestion: grepped every filter column the 5 paginated queries use against the migrations and found
each already indexed, but confirmed **no table had an index on `createdAt`** despite every one of
them doing `ORDER BY "createdAt" DESC` — invisible at today's row counts (Postgres just sorts in
memory) but a full-table sort on every single page request at real future scale. Added
`1755852100000-AddCreatedAtIndexesForPaginatedLists.ts` (purely additive, 5 new btree indexes:
customers/sales_orders/shipments/treasury_transactions/warehouse_transactions), applied to the live
dev DB, re-verified 43/43 suites still pass and all 5 paginated endpoints still return correct
`{rows, total}` live via curl.

**Still not done:** load testing at realistic future scale (thousands of customers/orders, per the
directive's explicit ask). Deliberately not attempted via bulk-inserted synthetic data against the
shared `daii_dev` database — bypassing the application layer to mass-insert rows risks leaving
invalid/incomplete records (missing process-engine state, audit trail, numbering-sequence gaps) that
other work depends on being clean, for a load-test that would need its own cleanup afterward. The
right way to do this safely is against a disposable, isolated database (create it, run migrations,
bulk-load, measure, drop it — never touching `daii_dev`) — a real, scoped task for a future session,
not skipped from lack of effort. What this session **did** verify is that the mechanism the fix
depends on (LIMIT/OFFSET + a matching index) is now actually in place, which is the part that
determines whether scale-testing would even show good numbers.

**Pagination audit — done; all 5 endpoints closed this continuation session.** Grepped every
`repo.find({...})` call in a list-returning service method for `take`/`skip` params. Five genuinely
unbounded, customer-facing list endpoints found; the contract decided (reusing the already-live
`?page=&pageSize=` convention from `InventoryController.warehouseInventory` — `page>=1`, `pageSize`
clamped `1..200`, default 50, response becomes `{rows, total}` — see `DAII_API_ARCHITECTURE.md`'s
envelope shape) and applied consistently to all 5:

| Service | Location | Status |
|---|---|---|
| `CustomersService.listCustomers` | `customers.service.ts:559,593` | ✅ **Paginated** — new `listCustomersPage` sibling method, old method kept for internal full-set callers (Reports, CustomerAccounts, invoice/AR/ledger name-lookups) |
| `SalesOrdersService.listOrders` | `sales-orders.service.ts:400,402` | ✅ **Paginated** — new `listOrdersPage`; the "all orders" bucket on `SalesOrdersList.tsx` now pages, the bounded workflow-queue tiles (draft/review/approval) still use the full fetch since their counts must stay exact |
| `WarehouseTransactionsService` list | `warehouse-transactions.service.ts:249` | ✅ **Paginated** — new `listTransactionsPage`; `MovementCenter.tsx` pages with Prev/Next |
| `ShipmentService.listShipments` | `shipment.service.ts:466` | ✅ **Paginated backend, frontend deferred** — new `listShipmentsPage` sibling method, same contract, 1 new test (disjoint pages + driver-scoping preserved). `Shipments.tsx` (773 lines, freshly rewritten this same day under the concurrent "Shipping Screen Redesign" directive) deliberately **not** wired to page/pageSize yet — bolting pagination controls onto an actively-just-changed, complex operational dashboard carries real regression risk for a screen that's fine today at real data volumes (max ~74 rows observed); the `GET /shipments` route stays 100% backward compatible (unpaginated) until that screen gets its own dedicated pass. |
| `TreasuryService` ledger list | `treasury.service.ts:454` | ✅ **Paginated backend, frontend deferred** — new `listLedgerPage` sibling method, same contract, 1 new test. Same reasoning as Shipments: no dedicated ledger-list screen was touched this session, same low-current-volume/high-future-value tradeoff. |

Each paginated `GET` stays 100% backward compatible when `page`/`pageSize` are omitted (returns the
original plain-array shape); passing either opts a caller into the new `{rows, total}` shape. Backend
gained 12 new tests total exercising the offset/limit math and total-count-under-filters directly
(43/43 suites → still 43/43, 537 → 550 tests). Frontend reuses the existing `action.previous_page`/
`action.next_page`/`field.page_of_total` terminology keys — no new strings.

(A few other unparameterized `repo.find` calls exist but aren't list-endpoint gaps — they're
inherently small, scoped queries like "preliminary holds for one sales order" or "transactions
sharing one transfer group.") **Remaining work, disclosed not silently dropped**: wire
`Shipments.tsx` and a Treasury ledger view to the now-live `page`/`pageSize` params with the same
Prev/Next UI the other 3 screens got — the backend contract is proven and stable, this is pure
frontend follow-up with no further design decision needed, deferred only because both screens
warranted their own careful pass rather than a rushed addition alongside unrelated pagination work.

**Security — spot-checked against real code, not assumed from the architecture docs alone:**

| Area | Finding |
|---|---|
| Secret handling | **Good.** `configuration.schema.ts` fails closed correctly — `DB_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATION_ENCRYPTION_KEY` all explicitly reject their dev-default value when `NODE_ENV=production`, exactly matching the architecture's binding rule. |
| `.env` in git | **Good.** Confirmed not tracked (`.gitignore` covers it, verified via `git ls-files`). |
| Password hashing | **Good.** `bcrypt`, not a weak hash. |
| Route authorization | **Good.** Every domain controller has a class-level `JwtAuthGuard`. The two exceptions found are both correctly justified: `terminology.controller.ts` (intentionally public — just UI label lookups, no sensitive data) and `integration-order-intake.controller.ts` (uses `IntegrationAuthGuard`, a separate machine-to-machine credential mechanism for the QR Platform connector — not a gap, a different auth type). |
| SQL injection | **Good.** Spot-checked every raw `dataSource.query`/`manager.query` call site in the money-touching domains (customer-finance, treasury, sales-orders, inventory) — 100% use parameterized `$1`/`$2` placeholders, never string-concatenated user input. `ORDER BY` column selection uses a hardcoded whitelist lookup, not direct interpolation. |
| CORS | **Not a gap.** No CORS configuration exists, and none is needed — the frontend dev server proxies `/api` through Vite (confirmed in `vite.config.ts`), and production serves the frontend as static files from the same Express process (`main.ts`'s own comment confirms this deliberately). Both are same-origin by construction. |
| **Rate limiting / brute-force protection** | **FIXED this session, both halves.** (1) Installed `@nestjs/throttler` (`app.module.ts`: `ThrottlerModule.forRoot` + global `APP_GUARD`, 300 req/min/IP default) plus a stricter override on `POST /auth/login` (10/min/IP) and `POST /auth/register` (5/min/IP) — live-verified, `429` from the 10th rapid attempt onward. (2) Per-account lockout: `Credential` gained `failedLoginAttempts`/`lockedUntil`; 5 consecutive failed attempts locks the account for 15 minutes, rejecting even the *correct* password until it expires or the password is changed — closes what per-IP throttling alone can't (a slow/distributed attack against one specific account). Live-verified: 5 wrong attempts on `fin1@daii.example` then a correct-password 6th attempt was rejected as locked, while `admin@daii.example` logged in normally at the same time (confirmed per-account, not global). 4 new tests. Backend: 43/43 suites, 537/537 tests throughout. |

**Note on the shared-workspace environment this segment ran in:** a concurrent session was
continuously active in `backend/src/domains/shipment/`, `backend/src/domains/delivery/`, and
`frontend/src/pages/Shipments.tsx` throughout this segment — landing at least 4 commits (own
migration `1755851700000-AddShipmentCarrierContactPhone`, an idempotency fix, an
`assignShippingRoute` feature, and more) under a "Shipping Screen Redesign directive." This session
deliberately avoided touching those same files/domains to prevent collisions, and verified the
shared test suite and both typechecks stayed clean after each round of their changes (43/43 suites,
533/533 tests, frontend `tsc -b` clean as of the last check) — including a transient `Shipments.tsx`
unused-variable typecheck error observed mid-edit, which that session resolved on its own by the
next check.

---

## 7. Golden-path Final E2E — done, real, live-verified

A complete, live, real end-to-end walkthrough of the core business cycle, driven against the actual
running backend and cross-checked in the actual browser UI — not a mock, not a unit test:

**Order `SO-2026-000088`** (Acme Trading Co., 2× Widget @ 150.00 = 300.00) walked through every
stage in sequence, each verified before moving to the next:

1. Created (draft) → `submit` → `supervisor_approve` → `manager_approve` → `deposit_verification`.
2. Deposit submitted (100.00, cash) → approved against a real Treasury cash account → **order
   auto-released**.
3. Fulfillment Order + Pick Task created explicitly → `receive-and-start` → `prepare-all` (2/2
   prepared) → `finish-and-ready-for-shipping` → Pack Task closed.
4. **RSH auto-created** (`RSH-2026-000009`), correctly linked to the Sales Order, **with
   `salesRepUserId` correctly populated** — a live, real-scenario confirmation of this session's
   own earlier traceability fix (§3 item 4), not just the isolated test that first proved it.
5. Driver assigned → `pickup` → `depart` → `arrive_for_delivery` → delivery outcome recorded as
   `delivered`.
6. **Inventory integrity verified**: `GET /inventory/reservations/by-order` returned an empty array
   immediately after delivery — the reservation was consumed by the final dispatch exactly once, no
   orphan, matching the documented "final ledger exit only at actual delivery" design
   (`MASTER_HANDOVER.md` §1 build step 3).
7. Invoice created and posted (`INV-2026-000004`, 300.00) → **customer AR balance verified correct
   both via API and in the browser UI**: `balance: 200.00`, `totalOutstanding: 200.00` (300.00 sale
   − 100.00 deposit, exact), the Sales Order detail page showed the invoice as "مدفوعة جزئيًا"
   (partially paid) matching precisely, and the Customer Accounts List UI independently showed the
   same 200.00 balance.

**Result: every number was correct and mutually consistent across the backend, the API responses,
and two independent UI screens, at every stage.** This is real financial and inventory integrity
verification of the complete Sales Order → Deposit → Fulfillment → RSH/Shipment → Delivery →
Invoice → AR cycle — the single most load-bearing path in the whole application — not an
impression, an actual traced execution with checked results at each hop.

**What this does and doesn't cover:** this is the core "happy path" through Sales/Deposit/
Fulfillment/Shipment/Delivery/AR. Vehicle Custody closing is covered separately by this session's own
earlier live verification in §3 item 7. Returns (both origins) and Custody/Collection Settlement were
**not** covered by this walkthrough — they're covered by the follow-up walkthrough directly below,
run the same way (real created records against the live backend, real numbers checked at each step,
cross-checked in the browser UI, not just the pre-existing unit-test evidence).

### 7b. Returns Engine + Custody/Collection Settlement E2E — done, real, live-verified

Run in a **separate, freshly-created customer** (`CUST-000049`, "Returns E2E Customer 1787589003")
rather than reusing `Acme Trading Co.` above, because a concurrent session turned out to be actively
running its own live Returns E2E against that exact customer at the same time (discovered mid-run via
an unexpected ledger entry from a Sales Order this session never created) — isolating onto a fresh
customer was the only way to get unambiguous, uncontended before/after numbers, the same rigor §7
itself required.

**Customer Return** (`SO-2026-000090`, 2× Widget @ 150.00 = 300.00, delivered, `INV-2026-000006`
posted): AR balance before any return, verified via API and the Customer Accounts List UI,
`200.00` (300.00 − 100.00 deposit, exact). Returned 1 of 2 units (`RET-2026-000012`, `product_return`)
through `authorize` (sup1) → `receive` → `inspect` → `disposition: restock` (wh1). Verified:
Main Warehouse Widget stock `onHand 55 → 56`, `available 39 → 40` — exactly +1, matching the returned
quantity, via `GET /inventory/warehouses/:id/inventory` (not just the UI badge). Return Credit created
for exactly `150.00` (the line's own historical per-unit price × 1, not the current catalog price).
Applied the credit to the invoice (`POST /returns/credits/:id/apply-to-invoice`, fin1) — AR balance
moved `200.00 → 50.00`, exactly −150.00, invoice state `posted → partially_paid` with `remaining:
50.00`. No phantom Treasury entries: the full customer ledger was pulled and reconciled entry-by-entry
(`deposit +100 credit`, `sales_invoice +300 debit`, `return_credit_note +150 credit` — nothing else).

**Shipping/Vehicle Custody Return** (`SO-2026-000091`, 3× Widget = 450.00, routed through vehicle
`XYZ-0007` via `assignShippingRoute`, picked up but **never delivered** — goods sitting in vehicle
custody): custody transfer at pickup verified first (Main WH `onHand 56 → 53`, vehicle custody
warehouse `0 → 3`, fully reserved). Initiated a partial custody return for 2 of the 3 units
(`RET-2026-000013`, origin `vehicle_custody`, `POST /returns/custody`, wh1) — auto-authorized and
received in one call, matching the code's own documented "dispatcher-initiated, no separate approval
gate" design. Verified: vehicle custody warehouse stock `3 → 1` (exactly −2) at initiation time,
`disposition: restock` → Main Warehouse `53 → 55` (exactly +2). **Confirmed the core business rule
(`MASTER_HANDOVER.md`): zero customer credit created** — `returnType` is `null` for a custody-origin
return, `GET /returns/credits?customerId=` stayed empty, and the customer's full ledger (pulled again
after this return) shows **zero new entries from the return itself** — the only ledger movement in
that window was an unrelated deposit on the still-undelivered `SO-2026-000091`, confirmed by
reconciling the ledger line-by-line, not assumed. `custodyBalance` stayed `0.00` throughout (no
phantom Treasury leg). Both returns render correctly on the live Returns screen (`/returns`) with
correct origin label ("مرتجع من عهدة سيارة" vs "مرتجع عميل"), quantity, and status.

**Custody/Collection Settlement** (`SO-2026-000092`, 1× Widget = 150.00, delivered through vehicle
`TEST-1234`, 20.00 deposit + 130.00 COD): vehicle custodian baseline confirmed clean first
(`custodyBalance: 0.00`, 0 stock). After delivery, recorded the COD collection
(`POST /delivery/collections`, 130.00, driver) — `getCustodianOverview.custodyBalance` moved
`0.00 → 130.00`, exact. Remitted/settled it (`POST /delivery/collections/:id/remit`, fin1, vehicle's
own `settlementAccountId` set to the `Main Cash` treasury account) — `custodyBalance` moved
`130.00 → 0.00` exactly, and `Main Cash`'s balance increased by exactly `130.00` (reconciled against
its own before/after snapshot, accounting for an unrelated 20.00 deposit that landed in the same
account in between — both API and UI (`CustodianDetail.tsx`'s "الأموال تحت العهدة" KPI) agreed on
`0.00` after settlement). **Printed the Collection Receipt** (`CollectionReceiptPrint.tsx`) as `fin1`
in the browser — this is what surfaced one of the two real bugs below; after the fix it rendered
correctly with waybill `WB-2026-000020`, RSH `RSH-2026-000013`, SO `SO-2026-000092`, customer name,
vehicle plate, remitted timestamp, and amount `130.00`, all matching the API exactly.

**Two real, live-discovered bugs were found and fixed during this walkthrough** — see §3 item 14 for
full detail (file:line citations, the fix, and the regression tests added): `finance` was missing
from `CustomersService.REVIEWER_ROLES` (blocked invoice creation and every customer-scoped financial
read for any customer not individually Scope-assigned to the finance user), and `ShipmentService.
getShipment`/`getTrackingHistory` only allowed the assigned driver or an admin (blocked the Collection
Receipt print page — a `finance`-facing feature — from loading for `finance`). Both fixed, both
live-reverified, backend re-confirmed at 43/43 suites / 548/548 tests, frontend build re-confirmed
clean.

## 8. Final Release Gate

**The concurrent session has genuinely concluded** — no commits from it since `ee12688`, confirmed
again at the start of this continuation (`git log`/`git status` clean, working tree matched HEAD
exactly before any of this segment's own changes). The golden-path E2E (§7) and the broader Returns/
Custody-Settlement E2E (§7b) are both done. Test-data cleanup is now done (§8a). Backup/Restore is
now verified (§8b). What's left before the release package itself: one more full regression pass
(done, see §8a's own test counts) and the package build.

### 8a. Database cleanup — done, with two real integrity bugs found and fixed

A `pg_dump -Fc` safety backup was taken first (`daii_dev_backup_pre_cleanup_2026-08-25.dump`,
verified restorable — see §8b). The cleanup itself was scoped narrowly: every `customers` row except
`CUST-000001`/`CUST-000002` (the two baseline fixtures other tests still reference) and everything
that FK-chains from the deleted customers' sales orders — `sales_orders`, `deposits`,
`fulfillment_orders` (+ their pick/pack tasks), `shipments`, `return_requests`, `stock_reservations`,
`sales_invoices`, `customer_payments`, `return_credits`, `customer_ledger_entries`,
`treasury_transactions` (by `customerId`/`salesOrderId`), and their `process_instances`. System
users/credentials, terminology, warehouses, products, price lists, and the 2 baseline customers'
own data were untouched.

**Two real bugs found during post-cleanup integrity verification (not before — this is exactly why
the CTO directive's "verify, don't just delete" instruction mattered):**

1. **Orphaned settlement-transfer legs.** Deleting a `treasury_transactions` row by `customerId`/
   `salesOrderId` correctly removed a custody account's *collection* leg (`cash_in`, which carries
   those ids) but left its later *settlement* `transfer_out`/paired `transfer_in` legs behind (which
   don't — they're keyed by `transferGroupId`, not customer/order). Result: 4 custody treasury
   accounts showed a nonzero balance (`-130.00`/`-200.00`/`-135.00`/`-150.00`) for a settlement that
   had actually completed cleanly pre-cleanup. Found by diffing every account's balance against a
   restored copy of the pre-cleanup backup (`daii_backup_check`, a scratch database, dropped after
   use) — confirmed each broken pair via its shared `transferGroupId`, then deleted the now-orphaned
   surviving legs too. All 4 custody accounts now correctly show `0.00`; `BANK-1`/`MAIN-CASH` netted
   down by the corresponding test-only amounts. (One separately-investigated account, `BANK-1`
   showing `-200.00`, turned out to be pre-existing and unrelated — a genuinely reversed transfer
   pair alongside a separate genuine posted transfer, both self-consistent and present in the backup
   before any cleanup ran — confirmed a false alarm, not touched.)
2. **`SalesOrdersService.deleteDraftOrder` left orphaned rows** (`sales-orders.service.ts`) —
   independent of this cleanup, a pre-existing gap: deleting a draft order correctly releases its
   line reservations (`status: 'released'`) and hard-deletes the order/lines, but never deleted the
   now-parentless `stock_reservations`/`process_instances` rows themselves (every other flow keeps
   such rows as history against a still-existing parent order; draft-delete is the one flow that
   removes the parent, so nothing was left for them to be history for). Found via the same orphan
   sweep (3 instances, from earlier draft-delete E2E testing). **Fixed in the same transaction**, 1
   new regression test, live-reverified.

**Post-fix verification — zero orphans across every table checked** (`stock_reservations`,
`fulfillment_orders`, `shipments`, `deposits`, `treasury_transactions`, `return_requests`,
`customer_ledger_entries`, `sales_invoices`, `customer_payments`, `return_credits`,
`process_instances`), all remaining `active`/`preliminary` reservations trace to real orders owned
by the 2 kept customers, and every treasury account balance recomputed from its transaction history
matches expectations exactly. Backend: 43/43 suites, 551/551 tests (551 = 548 baseline + 1 orphan-fix
regression + 2 from the concurrent pagination/index work landed in parallel, all independently
re-verified together). Frontend build and the structural validator both re-confirmed clean.

### 8b. Backup/Restore — audited, verified live, deliberately not turned into a new admin feature

**Audit first, per the directive.** Grepped the entire backend and frontend for any existing
Backup/Restore service, controller, or UI — **none exists.** This is not an oversight: it's already
a deliberate, **ACCEPTED** architectural decision (`architecture/DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md`,
ADR-020) to rely on an operational `pg_dump`/`pg_restore` procedure rather than a self-service in-app
feature, explicitly deferred until real on-premise packaging work is scoped ("No backup automation,
restore scripts, or migration tooling are implemented here — per Stage 1.1's explicit constraint
that no On-Premise product is built now").

**Exercised live this session** (not merely assumed to still work): `pg_dump -Fc` of `daii_dev`
pre-cleanup → `pg_restore --no-owner` into a fresh scratch database → row counts compared against
the source on every table checked (`customers`: 49/49, `treasury_transactions`: 41/41, exact match).
This satisfies ADR-020 §2's own bar — "restore is only 'supported' once it has been exercised
end-to-end at least once... not merely assumed to work" — with real, fresh evidence, not a stale
claim from the V1-era backup/restore exercise (`planning/v1-release/`).

**Decision (CTO, this session): document the verified procedure, do not build a self-service admin
UI.** Building create/list/restore-with-confirmation/RBAC/audit-trail as an in-app feature would
reverse ADR-020, not close a gap — a genuinely large, security-sensitive addition (shelling out to
`pg_dump`/`pg_restore` from the web process, backup file storage/retention/download-access
decisions) that the rest of this release-hardening pass's "close disclosed gaps" pattern doesn't
apply to. **Operational runbook** (the one actually exercised above):
```bash
# Backup
PGPASSWORD=<password> pg_dump -h <host> -p 5432 -U daii -Fc -f daii_backup_YYYY-MM-DD.dump daii_dev

# Restore (into a NEW/empty database — never over a live one without a fresh backup of that too)
createdb -h <host> -p 5432 -U daii daii_restore_target
PGPASSWORD=<password> pg_restore -h <host> -p 5432 -U daii -d daii_restore_target --no-owner daii_backup_YYYY-MM-DD.dump
```
Uploaded media (`backend/storage/`, per `MEDIA_STORAGE_PATH`) is a separate filesystem asset, not
captured by `pg_dump` — back it up alongside the database dump (a plain file copy) for a complete
restore, per `DAII_BACKUP_RECOVERY_UPGRADE_ARCHITECTURE.md`'s own distinction between DB and media
backups. RBAC is moot for a shell-level procedure run by whoever has server/DB credentials — the
same access control that already gates production database access, not a new permission to design.

## 9. How to keep this document current

This file should be updated (not left stale) whenever a domain's status changes materially. Prefer
editing this file over creating a new dated one — the whole point of this consolidation is fewer,
current files instead of accumulating another handover.
