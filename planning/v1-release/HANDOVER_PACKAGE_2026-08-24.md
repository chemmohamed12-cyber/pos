# Daii Platform — Handover Package
**Date:** 2026-08-24 · **Prepared by:** Claude Code (this session) · **Status: NOT yet declared Release Ready** (see §9)

**Addendum (later same session):** three additional Sales Order features were requested and
delivered after the report below was written — see §12 at the end of this document.

This document consolidates the CTO's "FINAL EXECUTION DIRECTIVE" checklist. It reports only what
was actually verified in this session — live-tested where stated, not just written. No git
repository exists in this working tree, so this document plus the accompanying ZIP snapshot
(`Daii-V1-Release-2026-08-24.zip`) are the only restore point.

**Important context:** this repository had a second Claude Code session actively developing the
same directive concurrently with this one. Several of the items below (marked "other session")
were built and live-tested by that session, not this one; this report independently re-verified
them (build/typecheck/test/live-trace) rather than taking them on faith.

---

## 1. Final Release Report (executive summary)

| Area | Status |
|---|---|
| Backend build (`nest build`) | ✅ Clean |
| Backend typecheck (`tsc --noEmit`) | ✅ Clean |
| Frontend build (`vite build`) | ✅ Clean |
| Frontend typecheck (`tsc --noEmit`) | ✅ Clean |
| Backend unit test suite | ✅ 40/40 suites, 390/390 tests passing |
| Migrations | ✅ All applied, zero pending |
| Critical Gap #1 (premature/double stock dispatch) | ✅ **Fixed, live-verified** (§3) |
| Live E2E: full order→delivery→treasury cycle | ✅ Verified via real ledger trace (§6) |
| Browser E2E (Admin controls, Customer Account) | ✅ Verified via live browser session (§6) |
| Demo/test data cleanup | ❌ **Not done** — candidates identified, not removed (§9) |
| Full cross-flow regression beyond the traced path | ⚠️ Partial — one full lifecycle traced live; not every screen/role combination re-walked this session |
| Full handover package (this document + ZIP) | ✅ This document + `Daii-V1-Release-2026-08-24.zip` |

**This session does not declare the platform Release Ready.** The one explicit release-gate
condition in the directive — closing Critical Gap #1 and verifying it live — is met. What remains
is data hygiene (§9) and broader regression coverage beyond the one path this session traced,
not a known defect.

---

## 2. Architecture / Implementation Report

Domain-driven NestJS backend (TypeScript, TypeORM, PostgreSQL) + React/Vite frontend, following
`Daii/architecture/DAII_DOMAIN_BOUNDARIES.md`'s Cross-Domain Rule (a domain only calls another
domain through its exported service methods, never its tables directly) and a shared Process
Engine (ADR-008) reused across every workflow (Sales Order approval, Fulfillment pick/pack,
Shipment lifecycle, Warehouse Transactions, Returns).

### What changed in this session

**Fixed (Critical Gap #1 — inventory ledger correctness):**
- `FulfillmentService.transitionPackTask` — removed the premature `fulfillReservation` loop that
  fired at pack-completion, before a shipment/pickup/custody-transfer existed.
- `InventoryService.fulfillReservation` — added an optional `warehouseIdOverride` (the physical
  location may have moved via custody transfer since the reservation was booked).
- `InventoryService.fulfillReservationsForOrder` (new) — the order-level orchestration the fix
  needed.
- `ShipmentService.getCurrentCustodyWarehouseId`/`resolveCustodyWarehouseId` (new) — resolves
  where an order's goods currently sit (custodian sub-location, or the fulfillment warehouse if
  no custodian was ever assigned).
- `DeliveryService.recordOutcome` — now calls `fulfillReservationsForOrder` at the single correct
  moment: when a shipment's outcome is recorded as `'delivered'`.

  *(Authorship note: this fix was built collaboratively — this session added the
  `getCurrentCustodyWarehouseId`/`fulfillReservationsForOrder` scaffolding first, deferred while a
  concurrent session owned `fulfillment.service.ts`/`inventory.service.ts`, and that session wired
  it into the actual fix using the same scaffolding.)*

**Built by the other session, independently re-verified here (build/test/live-trace):**
- Preliminary Hold → Reserved → Under Preparation → Shipping custody → Delivery, with a real
  "تحت التجهيز" (Under Preparation) sub-location and `InventoryService.relocateReservedStock`
  physically moving reservations between locations (not just re-labeling them).
- Per-item Preparation screen (`PickTaskLine`, `[الكمية][تم][تم للجميع]`) and Preparation Review
  actions (finish packing / hand to shipping / print), fully wired frontend-to-backend.
- Multi-carrier custody model: Shipping Company / Vehicle / Driver, each an auto-provisioned
  Warehouse sub-location + Treasury custody account, with COD collection posting to custody
  immediately and a separate remittance-to-settlement step.

**Built by this session:**
- **Admin user controls** — `POST /admin/roles/revoke`, `POST /admin/users/:id/status`
  (activate/deactivate — status change only, never a hard delete, matching this codebase's
  existing never-delete discipline), `POST /admin/users/:id/reset-password` (admin-initiated,
  revokes the target's sessions). `GET /admin/users` now includes each user's roles. Full
  [Admin.tsx](../../frontend/src/pages/Admin.tsx) rewrite: role revoke chips, status selector,
  inline password-reset field.
- **Customer Account Foundation** — `CustomerAccountsService` (new, in the `reports` domain,
  the codebase's existing cross-domain composition layer). `GET /reports/customer-accounts/:id`
  returns a **live-computed statement** — Sales Orders, Deposits, Collections, Returns for one
  customer, chronologically merged, with summary totals — built entirely from existing domain
  services' own published methods (two small additive methods were added:
  `DepositsService.listDepositsForOrder`, `DeliveryService.getCollectionForShipmentUnscoped`,
  the latter mirroring the existing `listPendingRemittances` unscoped-for-finance precedent).
  **Deliberately not a stored balance table** — every figure is a live sum, same principle
  `InventoryService` already uses for stock (ADR-007). New frontend page
  [CustomerAccount.tsx](../../frontend/src/pages/CustomerAccount.tsx), reachable via a
  "عرض الحساب" (View Account) button on the Customers screen.
- Fixed a real, pre-existing dev-environment defect: 4 of 6 documented local dev accounts
  (`admin`, `rep1`, `mgr1`, `wh1`) had password-drifted from the documented default at some
  point during earlier testing; reset via direct `credentials` table update (same bcrypt(12)
  scheme `AuthService.setPassword` uses) and re-verified live. `sup1`/`drv1` were unaffected.

### Domains touched this session (files)
See §10.

---

## 3. Critical Gap #1 — what it was, and proof it's fixed

**The bug:** `FulfillmentService.transitionPackTask` posted a final, ledger-exiting `dispatch`
movement the moment pack-verification closed — before a `Shipment` existed, before pickup, before
any custody transfer. `ShipmentService.transferCustodyOnPickup` would then try to move the *same*
quantity again from a warehouse whose stock had already been zeroed for that unit — either a hard
failure (insufficient stock) or a silent double-count against unrelated stock of the same SKU.

**The fix:** the ledger-exiting `dispatch` now fires exactly once, in `DeliveryService.
recordOutcome`, only on a genuine `'delivered'` outcome, at whatever warehouse the goods
currently occupy (resolved via the custody chain, not the reservation's original warehouse).

**Live proof (not just unit tests — real data, traced through the actual movement ledger):**

Using the other session's own live E2E fixture (`E2EFULL-WH` → `PREP-000002` Under Preparation →
`SLOC-000007` custody sub-location, order `SO-2026-000043`, customer "Full Cycle Customer"), this
session queried the real `stock_movements` at every warehouse in the chain:

| Warehouse | Movement | Qty (2 products) | Net |
|---|---|---|---|
| Main (E2EFULL-WH) | `receipt` | +10, +10 | — |
| Main (E2EFULL-WH) | `transfer_out` (→ Prep) | −3, −4 | 7, 6 remaining on-hand |
| Under Preparation | `transfer_in` (from Main) | +3, +4 | — |
| Under Preparation | `transfer_out` (custody transfer, pickup) | −3, −4 | **0, 0 — nothing stuck here** |
| Custody sub-location | `transfer_in` (from Prep) | +3, +4 | — |
| Custody sub-location | `dispatch` (referenceType `sales_order`, on delivery) | −3, −4 | **0, 0 — nothing stuck here** |

Exactly **one** `dispatch` movement per product, firing only at the last stage, quantities
conserved at every hop, nothing double-counted, nothing lost. `GET /inventory/reservations/
by-order` for this order now returns an empty active-reservation list (the reservation resolved
to `'fulfilled'`, not stuck `'active'`). The Customer Account statement for this same order
independently confirms `totalCollected = totalRemitted = 135.00 = totalOrdered` — the COD→Treasury
chain and the ledger-exit both agree.

---

## 4. Completed vs Remaining Tasks (against the CTO directive's numbered list)

| # | Item | Status |
|---|---|---|
| 1 | Inventory Ledger — fix premature/double dispatch | ✅ Done, live-verified (§3) |
| 2 | Preparation (per-item, [تم]/[تم للجميع], Under Preparation transfer, audit) | ✅ Done (other session; re-verified build+test+browser here) |
| 3 | Shipping/Custody full cycle, company/vehicle as operational custody, Treasury link | ✅ Done for the custodian-assigned path (live-traced, §3). ⚠️ A plain in-house driver (no company/vehicle assigned) still gets no intermediate location tracking after packing — disclosed limitation, not a regression from this session's work (§9) |
| 4 | Sales Order Review/Edit (edit button between approve/reject, audit history, stays in review until approved) | ✅ Already complete from prior work (this session's earlier turns); re-verified via full test suite, unchanged this session |
| 5 | Treasury hierarchy (Bank/Wallet/Cash, extensible sub-accounts, one ledger) | ✅ Already complete from prior work; unchanged this session |
| 6 | Customer Accounts foundation | ✅ Done this session (§2), live-verified with real data |
| 7 | Admin controls + demo data cleanup | ✅ Admin controls done, live-verified. ❌ Demo data cleanup **not done** — see §9 |
| 8 | Verification (build/typecheck/tests/migrations/live API/browser E2E) | ✅ All done for the areas this session touched or traced. ⚠️ Not an exhaustive re-walk of every screen/role in the system |
| 9 | Release Gate (don't declare Ready before Double Dispatch is closed and live-verified) | ✅ Gate condition met — but see the top-level "not declared Release Ready" note; other conditions (data hygiene) remain |

---

## 5. Database / Migration Report

- All migrations through `SeedCustomerAccountTerminology1755850100000` (this session's last) are
  applied to the real `daii_dev` database. `npm run migration:run` reports zero pending.
- New migrations this session: `1755850000000-SeedAdminUserManagementTerminology.ts`,
  `1755850100000-SeedCustomerAccountTerminology.ts` (both terminology-only — no schema change).
- No destructive migration was written or run this session. No table was dropped, no column
  removed.
- One pre-existing oddity found, not caused by this session: two migrations share the identical
  timestamp `1755849600000` (`SeedOrderEditTerminology` from earlier work, `SeedShippingCustody
  Terminology` from the other session) — both applied successfully (TypeORM tie-breaks
  deterministically by filename), but worth renaming one to avoid confusion in a future diff.

---

## 6. E2E / Regression Test Report

**Automated:**
- `npx tsc --noEmit` — backend and frontend, both clean, run repeatedly after every change this
  session made.
- `npm test` (backend) — 40/40 suites, 390/390 tests, run three times this session (before/after
  the other session's concurrent changes landed, and after this session's own changes) — always
  green, no regressions introduced by either session's work.
- `npm run build` — both backend (`nest build`) and frontend (`vite build`) succeed.

**Live (this session, against isolated temporary backend instances — never against the shared
dev server, to avoid disrupting the concurrently-active session; see §11):**
- `POST /auth/login` for all 6 documented dev accounts.
- `GET/POST /admin/*` — full round-trip: list users with roles, assign a role, revoke a role,
  verified via real browser interaction (not just curl) at http://localhost:5174, actions
  performed on the "New Staff" test account and reverted afterward.
- `GET /reports/customer-accounts/:id` — verified against a real customer with 19 real order/
  deposit entries, and independently against the other session's full-cycle E2E fixture.
- Full stock-movement trace for one complete order lifecycle: creation → preliminary hold →
  deposit approval → reserved → preparation → custody transfer → delivery → ledger exit (§3).
- Browser-verified: Customers list → "عرض الحساب" button → Customer Account statement page,
  fully rendered in Arabic with correct terminology.

**Not done this session:**
- A full walk of every role × every screen (e.g., driver-only screens, warehouse_supervisor
  approval flows, returns disposition, price-list edge cases) — only the paths this session
  either built or was verifying the critical fix on were exercised live.
- Load/concurrency testing.

---

## 7. Deployment Instructions

This is a local-dev-configured monorepo; there is no production deployment config in this
repository (`docker-compose.yml` is explicitly commented "Local development only — not a
deployment artifact").

**Backend:**
```bash
cd backend
npm install
cp .env.example .env   # or create .env — see §8 for required vars
npm run migration:run
npm run build
npm run start           # runs dist/main.js — production-style
# or: npm run start:dev # nest start --watch, for development
```
Backend listens on `PORT` (default 3500), API mounted at `/api`.

**Frontend:**
```bash
cd frontend
npm install
npm run build            # outputs frontend/dist — static, servable by any web server
# or: npm run dev         # Vite dev server on :5173, proxies /api to VITE_API_TARGET or localhost:3500
```

**Database:** PostgreSQL 16 (matches `docker-compose.yml`'s `postgres:16-alpine`). Either run
`docker compose up -d` from `backend/` for a local instance, or point `.env` at any Postgres 16
instance.

**Bootstrap:** the first `POST /api/auth/register` call becomes the platform's admin account
automatically (see `AuthService.register`); every subsequent registration requires an
authenticated admin caller. See [LOCAL_DEV_CREDENTIALS.md](../../LOCAL_DEV_CREDENTIALS.md) for
the exact bootstrap sequence.

---

## 8. Environment Variables

From `backend/.env` (local dev values shown — replace for any non-local environment):

| Variable | Purpose | Local dev value |
|---|---|---|
| `NODE_ENV` | Runtime mode | `development` |
| `PORT` | Backend HTTP port | `3500` |
| `DB_HOST` | Postgres host | `localhost` |
| `DB_PORT` | Postgres port | `5432` |
| `DB_USER` | Postgres user | `daii` |
| `DB_PASSWORD` | Postgres password | `daii_dev_only` (**must** be changed outside local dev) |
| `DB_NAME` | Postgres database | `daii_dev` |

Additional variables consumed by `AppConfigService`/JWT config (not all present in the current
`.env` — check `src/foundation/configuration/` for the full Joi validation schema before a
non-local deployment): JWT signing secrets, token TTLs. This session did not audit that schema
exhaustively — flagged as a to-verify item before any real deployment, not a known gap.

Frontend: `vite.config.ts`'s dev-server proxy target is now configurable via `VITE_API_TARGET`
(new this session, default unchanged at `http://localhost:3500`) — added specifically so this
session could run an isolated verification frontend without touching the shared dev server; safe,
backward-compatible, no effect on normal `npm run dev` usage.

---

## 9. Known Limitations

1. **Demo/test data is NOT cleaned up.** The live `daii_dev` database contains numerous
   obviously-test records mixed with real-looking demo data, e.g.:
   - Users: `Verify Admin`, `MOHAMED KHAIRY` (email `admin@daii.exampl` — a typo'd domain,
     apparently created during earlier live testing), `Sales Rep Two Verify`, `New Staff`.
   - Customers: three identical "Custody E2E Customer" rows, "Full Cycle Customer",
     "Prep E2E Customer", plus a customer with corrupted UTF-8 in its name/governorate
     (`CUST-000005`, "Hi Risk caf�" / "�������") — a pre-existing Excel-import encoding bug,
     apparently already investigated once (`CUST-000006` is a correctly-encoded retest of the
     same name).
   - Numerous `draft`-status sales orders left over from earlier testing sessions.

   This was **not acted on** — deleting data with no git/backup safety net for a live shared
   database, while another session may still be using these exact records for its own testing,
   was judged too risky to do unilaterally. Needs an explicit decision on what "release database"
   means: a fresh empty `daii_dev`, or a filtered cleanup of this one. The ZIP snapshot in this
   package does **not** include a database dump — only source code.

2. **A plain in-house-driver shipment (no Shipping Company or Vehicle assigned) gets no
   intermediate location tracking after packing.** `ShipmentService.transferCustodyOnPickup`
   deliberately no-ops when no custodian is assigned. The Critical Gap #1 fix still works
   correctly for this case (ledger exit still happens exactly once, at delivery, from the
   fulfillment warehouse) — but there is no visible "in transit" location for this specific
   shipment type between pack and delivery. Disclosed, not a regression.

3. **The UTF-8 mojibake customer record** (`CUST-000005`) is real corrupted data sitting in the
   live database, not just a display bug — should be fixed or removed as part of data cleanup,
   not left as a silent duplicate of `CUST-000006`.

4. **Two migrations share an identical timestamp** (`1755849600000`) — cosmetic, not a functional
   bug (both applied correctly), but worth a rename to avoid confusion.

5. **JWT/auth environment variable schema** was not exhaustively audited against a non-local
   deployment target this session (see §8).

6. **No git repository exists in this working tree.** This handover document plus the
   accompanying ZIP are the only restore point. Initializing git is strongly recommended before
   any further multi-session work on this codebase — the concurrent-editing risk this session
   encountered directly (two Claude Code sessions writing the same files, discovered mid-session
   by noticing file timestamps changing under active reads) would have been either prevented or
   trivially recoverable with version control.

---

## 10. Files and Documents Updated This Session

**Backend:**
- `src/domains/shipment/application/shipment.service.ts` — `getCurrentCustodyWarehouseId`,
  `resolveCustodyWarehouseId` (extracted/added)
- `src/domains/inventory-warehouse/application/inventory.service.ts` —
  `fulfillReservation` (`warehouseIdOverride` param), `fulfillReservationsForOrder` (new)
- `src/domains/delivery/application/delivery.service.ts` — `getCollectionForShipmentUnscoped` (new)
- `src/domains/deposit-control/application/deposits.service.ts` — `listDepositsForOrder` (new)
- `src/foundation/admin/admin.controller.ts` — role revoke, user status, admin password reset
  endpoints; `listUsers` now includes roles
- `src/domains/reports/application/customer-accounts.service.ts` (**new file**)
- `src/domains/reports/reports.module.ts`, `src/domains/reports/interface/reports.controller.ts`
  — wired the above in
- `src/database/migrations/1755850000000-SeedAdminUserManagementTerminology.ts` (**new, applied**)
- `src/database/migrations/1755850100000-SeedCustomerAccountTerminology.ts` (**new, applied**)

**Frontend:**
- `src/pages/Admin.tsx` — rewritten (roles display/revoke, status control, password reset)
- `src/pages/Customers.tsx` — added "عرض الحساب" (View Account) link
- `src/pages/CustomerAccount.tsx` (**new file**)
- `src/App.tsx` — new route `customers/:id/account`
- `vite.config.ts` — proxy target now reads `VITE_API_TARGET` (default unchanged)

**Other:**
- `LOCAL_DEV_CREDENTIALS.md` — documented the password-drift finding/fix
- This document, `planning/v1-release/HANDOVER_PACKAGE_2026-08-24.md`

**Not authored by this session but present in the current codebase** (the other concurrent
session's work, independently re-verified per §6): `pick-task-line.entity.ts`,
`relocateReservedStock`, the Preparation screen's frontend logic in `Fulfillment.tsx`, the
Shipping Company/Vehicle custody model, and the actual wiring of the Gap #1 fix into
`fulfillment.service.ts`/`delivery.service.ts` (this session provided the scaffolding methods;
the other session did the wiring — see §2).

---

## 11. Git / Repository State

**No git repository exists** at `D:\CLAUDE-CODE\XNEXUS-WORKSPACE\Daii` or any parent directory —
confirmed at the start of this session and unchanged throughout. There is no branch, no commit
history, and no way to diff this session's changes against a prior state other than the file-level
enumeration in §10 and the timestamps observed during the session.

**Concurrent-session note:** for a significant portion of this session, a second Claude Code
session was independently and simultaneously editing the same working tree — confirmed by
observing file modification timestamps changing seconds apart from this session's own edits, and
by new files (`pick-task-line.entity.ts`) appearing mid-session that this session had not created.
This session deliberately avoided touching `fulfillment.service.ts`/`inventory.service.ts` while
that was happening (per explicit user instruction mid-session), and never restarted or killed the
shared dev backend process (PID discovery showed it running on port 3500 throughout) — all live
verification in this session ran against isolated temporary backend/frontend instances on
alternate ports instead, specifically to avoid disrupting the other session's work.

**Recommendation:** initialize git now (`git init`, commit the current working tree as a baseline)
before any further parallel-session development — this was the single biggest process risk
observed this session, and it has no mitigation today beyond this document and the ZIP snapshot.

---

## 12. Addendum — Sales Order Edit/Dashboard/Deposit-Preview (later same session)

Three concrete gaps were reported against the Sales Order screens and fixed in this same session,
after §1–§11 above were written. All are backend + frontend + tests + live browser E2E verified
(isolated temp instances, same discipline as the rest of this report — never against the shared
dev server).

### 12.1 Order Edit at Draft (full screen, add/remove item, deposit)
Previously, `[تعديل]` only worked during `supervisor_review`/`manager_approval`, and only for
quantity/price on *existing* lines — a rep could not edit their own order at all while it sat in
`draft`, and the system correctly rejected the attempt (by design, but the directive needed
`draft` covered too). New:
- `SalesOrdersService.editDraftOrder` (new) — ownership-gated (the order's own rep, or admin),
  not role-gated. Full add/remove/change: any line not resubmitted is released and deleted; any
  line without an id is a new addition (freshly reserved); quantity changes on kept lines reuse
  the existing `adjustReservationQuantityInTransaction`. Re-prices fresh against the customer's
  *current* price list (correct for draft — nothing has been submitted/approved yet, so there is
  no non-retroactivity guarantee to protect, unlike the review-stage edit).
- `InventoryService.releaseReservationForOrderProductInTransaction` (new) — the release-only half
  of the existing adjust-quantity method, for a fully-removed line.
- `POST /sales-orders/:id/draft-lines` (new endpoint).
- New frontend screen [SalesOrdersEdit.tsx](../../frontend/src/pages/sales-orders/SalesOrdersEdit.tsx) — reuses the Create screen's line-editing UX (add item, per-line remove, live stock
  check, price preview), pre-filled with the order's existing lines; customer/warehouse are
  read-only (changing either would invalidate existing reservations, out of scope); an optional
  deposit-at-edit section mirrors Create's, shown only when the order has no deposit yet.
  [SalesOrdersDetail.tsx](../../frontend/src/pages/sales-orders/SalesOrdersDetail.tsx)'s `[تعديل]` button now branches: draft → navigates to this new screen; the two review
  stages → the existing inline quantity/price edit, unchanged.
- **A real bug was found and fixed live, not just in review:** if a manager had set a
  `managerPrice` override on a line (e.g. built the order under a rep's name), the rep later
  editing *any other* part of the draft — even just adding an unrelated item — silently stripped
  that override back to the rep/list price, because the shared pricing resolver unconditionally
  nulls `managerPrice` for a non-manager actor (a correct anti-forgery gate, but wrong for
  *preserving* an already-legitimate value on an unrelated edit). Fixed: an existing line's
  manager-price override is now preserved when the editing actor isn't authorized to touch it.
  Live-verified against a real fixture order built under this exact scenario — confirmed the
  override survived a save, then confirmed line removal also works correctly.

### 12.2 Sales Orders dashboard (clickable status tiles, role-scoped)
[SalesOrdersList.tsx](../../frontend/src/pages/sales-orders/SalesOrdersList.tsx) rebuilt with 4
tiles (مسودة / مراجعة المشرف / موافقة المدير / اعتماد العربون) plus an "all orders" tile, each
showing a live count, clicking opens the filtered list. No backend change was needed — visibility
was already correctly role-scoped in `SalesOrdersService.listOrders` (a rep sees only their own
orders, a supervisor/manager/admin/warehouse_worker sees the full queue); this only groups the
same already-scoped response client-side. Live-verified as `rep1`: tiles showed real counts (16
draft, 1 supervisor review, 1 manager approval, 2 deposit verification, 31 total, all scoped to
that rep's own orders), and drilling into a tile correctly filtered the list.

### 12.3 Deposit receipt preview during approval
Accounts previously had no way to view the uploaded deposit-transfer receipt while approving —
the file was stored (`Deposit.evidenceMediaAssetId`) and served (`GET /media/:id`) but nothing in
[DepositPanel.tsx](../../frontend/src/components/DepositPanel.tsx) linked to it. Since that route
requires a Bearer token a plain `<img src>` can't carry, added `downloadBlob` to
[api.ts](../../frontend/src/lib/api.ts) (authenticated fetch returning a raw `Blob`, bypassing the
JSON-envelope parsing every other API call uses) and a "معاينة الإيصال" button that fetches the
evidence as a Blob, turns it into an object URL, and shows it in a lightweight overlay (image or
iframe, revoked on close). Live-verified against a real fixture deposit with an attached receipt —
confirmed the image actually loads (1440×1920, `complete: true`), not just that the button renders.

### Files changed (§12)
- `backend/src/domains/inventory-warehouse/application/inventory.service.ts` —
  `releaseReservationForOrderProductInTransaction` (new)
- `backend/src/domains/sales-orders/application/sales-orders.service.ts` —
  `DraftOrderLineInput` (new type), `editDraftOrder` (new)
- `backend/src/domains/sales-orders/interface/sales-orders.controller.ts` — `POST :id/draft-lines`
- `backend/src/domains/sales-orders/application/sales-orders.service.spec.ts` — 7 new tests
  (including the manager-price-preservation regression test) + one pre-existing mock bug fixed
  (line-id collision when a batch of lines was created before any was saved — not a service bug,
  a test-fixture bug that happened to never surface before)
- `backend/src/database/migrations/1755850200000-SeedDraftEditAndDepositPreviewTerminology.ts`
  (new, applied)
- `frontend/src/pages/sales-orders/SalesOrdersEdit.tsx` (new file)
- `frontend/src/pages/sales-orders/SalesOrdersDetail.tsx`, `SalesOrdersList.tsx` (rewritten)
- `frontend/src/components/DepositPanel.tsx`, `frontend/src/lib/api.ts`, `frontend/src/App.tsx`

### Verification (§12)
Backend: `tsc --noEmit` clean; full suite **40/40 suites, 401/401 tests** (was 396, +5 net after
adding 7 and discovering the test-fixture id-collision fix touched an existing count); zero
pending migrations. Frontend: `tsc --noEmit` clean; `vite build` clean. Live: isolated temp
backend+frontend instances (same non-disruptive discipline as the rest of this report), full
add/remove/save round-trip exercised as `rep1` against a real order, manager-price preservation
confirmed against a real fixture, dashboard tiles confirmed with real counts, deposit preview
confirmed against a real uploaded file. Temp instances stopped and log files removed afterward.
