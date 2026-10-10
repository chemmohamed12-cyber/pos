# Known Limitations — V1 Release

## Named by the CTO, verified against actual code (not redesigned, not hidden)

1. **Historical Sales Order lines lack a true historical `priceListPrice`.** Rows created before this column existed were backfilled from `listPrice` (the base price), since their true price-list-adjusted price at the time of creation is not reconstructable after the fact. Confirmed in the migration itself (`1755847300000-AddSalesOrderWarehouseAndPriceListPrice.ts`).
2. **QR order intake picks the first active warehouse.** `IntegrationsService` has no human present at intake time to choose a warehouse, so it falls back to `warehouses.find(w => w.status === 'active')` — literally the first one, with a disclosed doc comment marking real multi-warehouse QR routing as out of scope for V1.
3. **Reservation-at-creation-time compatibility.** Orders created before stock reservation moved to order-creation time may have `warehouseId = null`. Every downstream read already handles this gracefully (`order.warehouseId ? ... : null`) — no crash risk, just no reservation exists against those older rows.

## Found this round (resolved)

4. **Dev Postgres outage, resolved.** Mid-session, the real dev Postgres (port 5432 — a portable, no-installer install running from inside a different, concurrently-active Claude Code session's own scratchpad directory) was killed abruptly and became unreachable. It was located and restarted in place (`pg_ctl start`, standard automatic crash recovery, no data loss — confirmed the original dataset, 22 sales orders and all original customers/fixtures, was intact immediately after). An earlier round of this session's own verification mistakenly ran against a separate, unrelated native Windows Postgres service found on port 5433 during the outage — that instance has no connection to this project. All release documentation and live-test evidence in this package has been corrected to reflect verification against the real database only. Test data this correction round's re-verification touched (`newstaff@daii.example`, created in an earlier legitimate security-fix verification pass against the real DB) remains in place — see item 5.
5. **A small number of test accounts exist in the real dev database from this session's live verification work** (e.g. `newstaff@daii.example`, `rep2-verify@daii.example`, a "Concurrency Test Warehouse", "Excel Test Warehouse", assorted `*TEST*`-named products). No user-deletion endpoint exists in the API, so these were left in place rather than removed via a raw database write (consistent with this session's standing rule against unauthorized direct database mutation). All are unmistakably named as test artifacts. Recommend a cleanup pass (or a proper admin user/product-deactivation endpoint) before using this database as a customer-facing demo seed.
6. **Warehouse reporting has no dedicated cross-warehouse "activity by user/date-range" report screen.** The underlying data fully supports it (every movement carries user, date, reason, reference), but no new aggregate report UI was added this round — not requested as an explicit gap, and adding one would have been new-feature scope beyond this directive's "no unnecessary scope expansion" instruction.

## Carried forward from the security audit (non-blocking)

7. Password-change doesn't require re-entering the current password (mitigated by a 15-minute access-token TTL).
8. `fulfillment.service.ts`/`returns.service.ts` have two writes with no scope check on the target `salesOrderId`; every downstream approval/disposition step is already role-gated, so practical impact is low.
9. Nine pairs of migrations share a timestamp (cosmetic — no functional dependency between any pair); the warehouse-transaction-era migrations dropped the `REFERENCES` FK discipline the rest of the schema uses (entity-consistent, service-layer-validated, but worth tightening).
10. `.env.example` documents only the database variables, not `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`INTEGRATION_ENCRYPTION_KEY`/`MEDIA_STORAGE_PATH` — the app fails closed on missing/default values in production regardless, but the file should list them for a deploying operator's benefit.

## Design clarification, not a defect

11. "Discount" and "price variance" are two separate, independently-tracked values in this system (discount is a manual, server-bounded entry; variance is the automatic effect of choosing a rep/manager price), rather than one being derived from the other. Both are fully persisted and displayed. See `SALES_ORDER_COMPLETION_REPORT.md` §12 for detail.
