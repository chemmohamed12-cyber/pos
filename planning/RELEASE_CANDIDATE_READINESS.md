# Daii V1 — Release Candidate Readiness

CTO finalization directive §15 checklist. Verified live against the real local PostgreSQL instance and both running servers, not asserted from code review alone. Dated 2026-08-22.

| Area | Status | Evidence |
|---|---|---|
| Build (backend) | ✅ | `nest build` clean; 37 suites / 223 tests passing |
| Build (frontend) | ✅ | `tsc -b && vite build` clean, zero type errors |
| Database migrations | ✅ | All migrations applied, forward-only, no `synchronize` anywhere (ADR-003) |
| Authentication | ✅ | JWT bootstrap-admin flow, verified across every persona used this session |
| Authorization / Scope | ✅ | Role gates + Scope Engine verified across Sales Orders, Customers, Fulfillment, Shipments; two Scope-vs-Role gaps found and fixed this session |
| Core business workflow | ✅ | Full Customer→Order→Approval→Deposit→Reservation→Fulfillment→Shipment→Delivery→Collection cycle driven live through the real UI, twice (single-line and multi-line orders) |
| Multi-line Sales Orders | ✅ | Domain model fixed (per-line reservations, no singular `reservationId`); live-verified both products dispatched from one pack confirmation |
| Inventory integrity | ✅ | Advisory-lock concurrency verified; opening-stock Excel import verified against the real ledger (`recordMovement`) |
| Excel import/export | ✅ | Products, Customers, Warehouses, Inventory opening stock — real `.xlsx` files built and parsed with `exceljs`, validation/duplicate-detection/reference-checks all exercised live; one real bug found and fixed (binary buffers were being corrupted by the global JSON response-envelope interceptor) |
| Printing | ✅ | Reusable document-contract → renderer architecture; Sales Order and Waybill documents rendered live with correct cross-referenced data (customer, warehouse, driver names — not raw ids) |
| Arabic / English | ✅ | RTL/LTR verified across every screen and every print document; ~180 Terminology Registry codes added this session, no hardcoded per-screen strings in the areas touched |
| Local startup | ✅ | README Quickstart: Postgres → env → migrations → backend → frontend → first-admin bootstrap, no manual table creation, no raw-API dependency for normal operation |
| **Backup / restore** | ✅ | `pg_dump -Fc` → `pg_restore` into a fresh `daii_restore_test` database → row counts compared across `sales_orders`, `products`, `customers`, `audit_records`, `terminology_entries` — **exact match on every table** (10/13/3/123/277 rows respectively) → test database dropped |

## Known, disclosed gaps (not blockers, tracked as follow-up)

- Organization hierarchy UI is minimal (CRUD + membership only, no reporting-line logic) — Organization was never load-bearing for any V1 business flow.
- Sync Engine, Daii.exe packaging: intentionally not built — see ADR-021 / `DAII_SYNC_READINESS_NOTE.md`. Today's identity/ledger choices were verified sync-compatible without building the sync layer itself.
- A separate, concurrent workstream (Reports domain, QR Platform integration bridge) was in progress on this same codebase outside this directive's scope — see that thread's own handover note for status. Verified compatible with everything in this table (combined test suite: 37/37, 223/223).
