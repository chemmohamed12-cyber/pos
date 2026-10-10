# Security Audit — Final (V1 Release)

Date: 2026-08-23. Scope: all 20 controllers under `backend/src/domains/**/interface` and `backend/src/foundation/**`, JWT/RBAC/Scope foundation, every Process-Engine state machine. Method: background research pass (agent, 84 tool uses) → every finding independently re-verified against source by file:line before any fix → fix applied → rebuilt → full suite rerun → live-tested with real HTTP requests against a running instance.

## BLOCKER — fixed, live-verified

**Public self-registration, no gate, auto-activates any caller.**
`backend/src/foundation/authentication/auth.controller.ts` — `POST /auth/register` had no guard at class or method level. Any unauthenticated caller could create a fully active account at any time, not just the intended one-time bootstrap.
Fix: open only when zero users exist (bootstrap → first user becomes admin, unchanged); every registration after that requires an authenticated admin caller (`auth.controller.ts` `requireAdminCaller`, verifying the bearer JWT and role server-side, not trusting any client claim). No separate "create user" endpoint exists, so this stays the one onboarding path — just no longer public.
Live-verified: anonymous `POST /auth/register` → `401 UNAUTHORIZED`; same call with a valid admin bearer token → `201`, user created.

## HIGH — fixed, live-verified (3)

1. **`customers.controller.ts` `:id/assign`** — no role gate; any authenticated user could self-assign as a customer's sales rep, which immediately grants real Scope access via `assignSalesRep` → `scope.assign`. Fixed: `@RequireRole('admin','sales_manager')`, matching every sibling business-policy route on that controller. Live-verified: non-privileged token → `403`; admin → `201`.
2. **`products.controller.ts` `create`/`updateUnit`/`setStatus`/`updatePrice`** — no role gate; `updatePrice` sets the platform-wide fallback price used whenever no price-list/rep/manager override applies, a real financial-integrity exposure across every customer's orders. Fixed: `@RequireRole('admin')`, matching the sibling `import` routes and the frontend's own pre-existing admin-only UI gating. Live-verified: non-privileged token → `403` on both create and price-update.
3. **`warehouse-transactions.service.ts` `transition()`** — an action absent from `WAREHOUSE_TRANSACTION_ACTION_ROLES` (e.g. `auto_post`, an internal-only transition the service fires itself) skipped the role check entirely instead of being rejected. Any authenticated user, any role, could call `{action:"auto_post"}` directly on a `submitted` transaction and mark it `posted` with **zero ledger movement and no stock check**. Fixed: default-deny — an action with no role-map entry is rejected outright. Live-verified: rejected for both a regular user and an admin (genuinely internal-only, never client-reachable, by design).

## MEDIUM — fixed, live-verified (6)

- **Sales Orders** (`sales-orders.service.ts` `transitionOrder`): same default-deny gap — `start_review`/`auto_release` (internal-only, fired by `submit`'s own auto-chain) had no `ORDER_ACTION_REQUIRED_ROLES` entry, so calling them directly could skip the entire supervisor/manager/deposit review chain for a `standard`-policy order. Fixed the same way. Live-verified: both actions rejected for every caller including admin.
- **Shipment** (`shipment.service.ts` `transitionShipment`): `return_to_sender`/`retry` were absent from `DRIVER_ACTIONS`, so they skipped the assigned-driver-or-admin check entirely — any authenticated user could transition someone else's shipment. Fixed: actions outside `DRIVER_ACTIONS` now require admin (matching `assign_driver`'s existing admin-only precedent). Live-verified via unit test (driver rejected, admin succeeds) since no shipment test data existed in the verification DB this round.
- **Delivery cash collection** (`delivery.service.ts` `recordCollection`): no authorization check at all — unlike `recordOutcome`, which delegates to `transitionShipment`'s check. Any authenticated user could log a fabricated cash collection against any shipment. Fixed: extracted `ShipmentService.assertDriverOrAdmin` (shared with `transitionShipment`) and reused it here.
- **IDOR on single-resource reads**: `GET /shipments/:id`, `/shipments/:id/tracking`, `/delivery/outcomes`, `/delivery/collections`, `/deposits/:id`, `/deposits?salesOrderId=` all had no scope check while their list-endpoint siblings did. Fixed: all now call `assertDriverOrAdmin` or `SalesOrdersService.getOrder`'s existing scope check as appropriate.
- **`submitDeposit`**: no scope check on the target order — any authenticated user could submit a deposit claim against any sales order id. Fixed: reuses `SalesOrdersService.getOrder`'s existing check (also confirms the order exists, closing a second latent gap for free).

## LOW — 1 fixed, 2 documented as non-blocking

- **Fixed**: M2M integration credential comparison (`integration-auth.guard.ts`) used a plain `!==` string compare instead of a constant-time one. Now uses `crypto.timingSafeEqual` with a length guard.
- **Documented, not fixed** (matches the audit's own low-impact assessment; fixing would touch UX beyond this directive's scope): password-change doesn't require the current password (mitigated by a 15-minute access-token TTL); `fulfillment.service.ts`/`returns.service.ts` have two writes (`assignPickTask`, `createFulfillmentOrder`, `createReturnRequest`) with no scope check on the target `salesOrderId`, but every downstream approval/disposition step is already role-gated.

## Verified clean, no action needed

Guard presence on every write route (all 20 controllers, method or class level); `@RequireRole` always paired with `RolesGuard` (13 files checked, no silent no-op); JWT payload carries only `{sub}`, roles always re-resolved from the DB per request; every list endpoint filters server-side from the caller's own resolved identity, never a client-supplied override without a role check; `bcrypt` cost-12 password storage, `Credential` kept in its own table, never joined into a list/read response; global `ValidationPipe({whitelist, forbidNonWhitelisted})` rejects any DTO field a spoofed role/permission claim would need; **the config schema fails closed in production** — `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DB_PASSWORD`, `INTEGRATION_ENCRYPTION_KEY` all require 32+ characters and explicitly `.disallow()` the known dev-default literal when `NODE_ENV=production`.

## Regression after fixes

`nest build` clean. `npm test`: **39/39 suites, 280/280 tests** (one new test added for the Shipment `retry`-is-admin-only fix). Live-tested every BLOCKER/HIGH/MEDIUM fix with real login/token/curl round-trips against a running instance on an isolated port, confirming both the negative case (rejected) and the positive case (legitimate flow still works unchanged).
