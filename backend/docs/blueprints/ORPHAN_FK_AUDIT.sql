-- Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
-- READ-ONLY audit. Run this against the REAL target database before deciding
-- how to handle any orphaned/NULL salesOrderId-family references ahead of a
-- future migration that adds real FK constraints to:
--   shipments.salesOrderId, shipments.fulfillmentOrderId,
--   fulfillment_orders.salesOrderId, return_requests.salesOrderId,
--   return_requests.salesOrderLineId
-- (SALES_ORDER_SHIPMENT_RETURNS_BLUEPRINT.md §B.18 decision 2 — "audit first,
-- report before deciding", ratified 2026-09-16).
--
-- This script was NOT executed as part of this change: no PostgreSQL
-- instance was reachable from the session that wrote it (no .env, no
-- local server listening on 5432, no psql client available). Run it
-- manually against dev/staging/production-copy and report the counts
-- before any FK-adding migration is written.

-- 1. shipments.salesOrderId: NULL or pointing at a non-existent sales_orders.id
SELECT count(*) AS null_salesOrderId
FROM shipments
WHERE "salesOrderId" IS NULL;

SELECT count(*) AS orphaned_salesOrderId
FROM shipments s
WHERE s."salesOrderId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.id = s."salesOrderId");

-- 2. shipments.fulfillmentOrderId (varchar, compared as text): orphaned
SELECT count(*) AS orphaned_fulfillmentOrderId
FROM shipments s
WHERE NOT EXISTS (SELECT 1 FROM fulfillment_orders f WHERE f.id::text = s."fulfillmentOrderId");

-- 3. fulfillment_orders.salesOrderId (varchar, compared as text): orphaned,
--    and separately, any value that ISN'T even a valid UUID shape (which
--    would block a straight varchar->uuid column-type migration outright).
SELECT count(*) AS orphaned_fulfillmentOrders_salesOrderId
FROM fulfillment_orders f
WHERE NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.id::text = f."salesOrderId");

SELECT count(*) AS non_uuid_shaped_salesOrderId
FROM fulfillment_orders
WHERE "salesOrderId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 4. return_requests.salesOrderId (varchar): orphaned + non-UUID-shaped
SELECT count(*) AS orphaned_return_requests_salesOrderId
FROM return_requests r
WHERE NOT EXISTS (SELECT 1 FROM sales_orders o WHERE o.id::text = r."salesOrderId");

SELECT count(*) AS non_uuid_shaped_return_requests_salesOrderId
FROM return_requests
WHERE "salesOrderId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 5. return_requests.salesOrderLineId (uuid, nullable): NULL + orphaned
SELECT count(*) AS null_salesOrderLineId
FROM return_requests
WHERE "salesOrderLineId" IS NULL;

SELECT count(*) AS orphaned_salesOrderLineId
FROM return_requests r
WHERE r."salesOrderLineId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.id = r."salesOrderLineId");

-- Interpretation guide:
--  - Any non-zero "orphaned_*" or "non_uuid_shaped_*" count means a straight
--    `ALTER TABLE ... ADD CONSTRAINT ... REFERENCES ...` will FAIL outright —
--    those rows need a decision (fix, null-out, or delete) before the
--    constraint migration can run.
--  - A non-zero "null_*" count is not necessarily a blocker (a nullable FK
--    column allows NULL under a normal FK constraint) but should still be
--    reviewed — it's exactly the "shipment.customerId unrecoverable" risk
--    flagged in the Blueprint's RBW section A.2.1.
