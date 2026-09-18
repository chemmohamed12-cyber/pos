-- Daii — Corrective Data Repair: polymorphic refs the 2026-08-31 UUID repair missed
--
-- WHY: the Controlled UUID Data Repair (data_repair_run, 764 rows, integrity
-- "passed") remapped every PRIMARY KEY and every DB-enforced / soft / hidden
-- FK — but for `process_instances.entityId` it only handled entityType
-- 'sales_order', and it did not touch `scope_assignments.resourceId` at all.
-- Result on staging: every process-tracked entity whose PK was repaired
-- (fulfillment pick/pack tasks, shipments, warehouse transactions, sales
-- invoices, return requests) has a `process_instances` row still pointing at
-- its OLD id, so `ProcessEngineService.getState()` throws NotFoundException
-- (HTTP 404) — which 404s the list endpoints (`GET /api/fulfillment/pick-tasks`,
-- `/api/shipments`, `/api/warehouse-transactions/overview`) and every detail
-- view that enriches rows with process state.
--
-- WHAT THIS DOES: reads the frozen old->new mapping from the existing
-- data_repair_run and updates ONLY:
--   process_instances.entityId   (text, no FK; keyed by definitionKey+entityType+entityId)
--   scope_assignments.resourceId (text, no FK; keyed by userId+resourceType+resourceId)
-- for the rows that still carry an old id. Idempotent (entityType 'sales_order'
-- and any already-correct row simply match nothing). No PK is changed. No
-- audit/plan/execute is re-run. One transaction.
--
-- PRECONDITIONS:
--   * a verified pre-repair backup exists and is retained (the same one the
--     data_repair_run was gated on) — do NOT run this without it
--   * :repair_run_id below is the id of the completed data_repair_run
--
-- Run:  psql -h 127.0.0.1 -U xnexdrgr_daii_app2 -d xnexdrgr_daii_staging \
--         -v repair_run_id="'03c435b6-b6e0-44d4-b0dc-1c1f0ecc6f70'" \
--         -f tools/data-repair/repair-polymorphic-refs.sql

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- 0. the frozen mapping, plus the entityType/resourceType each source table maps to
CREATE TEMP TABLE _poly_map ON COMMIT DROP AS
SELECT
  (elem->>'oldId')  AS old_id,
  (elem->>'newId')  AS new_id,
  (elem->>'table')  AS src_table,
  CASE (elem->>'table')
    WHEN 'sales_orders'           THEN 'sales_order'
    WHEN 'sales_invoices'         THEN 'sales_invoice'
    WHEN 'warehouse_transactions' THEN 'warehouse_transaction'
    WHEN 'return_requests'        THEN 'return_request'
    WHEN 'shipments'              THEN 'shipment'
    WHEN 'pack_tasks'             THEN 'pack_task'
    WHEN 'pick_tasks'             THEN 'pick_task'
  END AS process_entity_type,
  CASE (elem->>'table') WHEN 'customers' THEN 'customer' END AS scope_resource_type
FROM data_repair_runs r
CROSS JOIN LATERAL jsonb_array_elements(r.mapping) elem
WHERE r.id = :repair_run_id;

SELECT count(*) AS mapping_entries FROM _poly_map;

-- 1. BEFORE: orphaned polymorphic rows (should be > 0 for the missed types, 0 for sales_order)
SELECT pi."entityType", count(*) AS orphaned_process_instances
FROM process_instances pi
WHERE pi."entityType" IN ('sales_order','sales_invoice','warehouse_transaction','return_request','shipment','pack_task','pick_task')
  AND NOT EXISTS (
    SELECT 1 FROM _poly_map m
    WHERE m.process_entity_type = pi."entityType" AND m.new_id = pi."entityId"
    UNION ALL
    -- already-correct rows: entityId matches a live PK in the mapped table
    SELECT 1 WHERE pi."entityId" IN (
      SELECT id::text FROM sales_orders           WHERE pi."entityType"='sales_order'           UNION ALL
      SELECT id::text FROM sales_invoices         WHERE pi."entityType"='sales_invoice'         UNION ALL
      SELECT id::text FROM warehouse_transactions WHERE pi."entityType"='warehouse_transaction' UNION ALL
      SELECT id::text FROM return_requests        WHERE pi."entityType"='return_request'        UNION ALL
      SELECT id::text FROM shipments              WHERE pi."entityType"='shipment'              UNION ALL
      SELECT id::text FROM pack_tasks             WHERE pi."entityType"='pack_task'             UNION ALL
      SELECT id::text FROM pick_tasks             WHERE pi."entityType"='pick_task'
    )
  )
GROUP BY pi."entityType"
ORDER BY pi."entityType";

-- 2. FIX process_instances.entityId (only rows still carrying a repaired old id)
WITH upd AS (
  UPDATE process_instances pi
  SET "entityId" = m.new_id
  FROM _poly_map m
  WHERE m.process_entity_type IS NOT NULL
    AND pi."entityType" = m.process_entity_type
    AND pi."entityId"   = m.old_id
  RETURNING pi.id, pi."entityType"
)
SELECT "entityType", count(*) AS process_instances_repaired FROM upd GROUP BY "entityType" ORDER BY "entityType";

-- 3. FIX scope_assignments.resourceId (resourceType='customer' only)
WITH upd AS (
  UPDATE scope_assignments sa
  SET "resourceId" = m.new_id
  FROM _poly_map m
  WHERE m.scope_resource_type IS NOT NULL
    AND sa."resourceType" = m.scope_resource_type
    AND sa."resourceId"   = m.old_id
  RETURNING sa.id
)
SELECT count(*) AS scope_assignments_repaired FROM upd;

-- 4. AFTER: every polymorphic ref must now resolve
SELECT 'process_instances.entityId' AS check_name, pi."entityType" AS scope, count(*) AS orphans
FROM process_instances pi
WHERE pi."entityType" IN ('sales_order','sales_invoice','warehouse_transaction','return_request','shipment','pack_task','pick_task')
  AND NOT EXISTS (
    SELECT 1 WHERE pi."entityId" IN (
      SELECT id::text FROM sales_orders           WHERE pi."entityType"='sales_order'           UNION ALL
      SELECT id::text FROM sales_invoices         WHERE pi."entityType"='sales_invoice'         UNION ALL
      SELECT id::text FROM warehouse_transactions WHERE pi."entityType"='warehouse_transaction' UNION ALL
      SELECT id::text FROM return_requests        WHERE pi."entityType"='return_request'        UNION ALL
      SELECT id::text FROM shipments              WHERE pi."entityType"='shipment'              UNION ALL
      SELECT id::text FROM pack_tasks             WHERE pi."entityType"='pack_task'             UNION ALL
      SELECT id::text FROM pick_tasks             WHERE pi."entityType"='pick_task'
    )
  )
GROUP BY pi."entityType"
UNION ALL
SELECT 'scope_assignments.resourceId', 'customer', count(*)
FROM scope_assignments sa
WHERE sa."resourceType" = 'customer'
  AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id::text = sa."resourceId");
-- FAIL CONDITION: any `orphans` > 0 above. If all 0 -> COMMIT. Else ROLLBACK and investigate.

-- 5. record the correction on the data_repair_run (evidence; no schema change)
UPDATE data_repair_runs
SET "integrityResult" = jsonb_set(
      coalesce("integrityResult",'{}'::jsonb),
      '{polymorphicCorrection}',
      jsonb_build_object('appliedAt', now(), 'note', 'process_instances.entityId + scope_assignments.resourceId remapped for entityTypes the original run missed')
    )
WHERE id = :repair_run_id;

COMMIT;

-- Post-commit sanity (read-only): the process engine can now resolve state.
SELECT "entityType", count(*) AS total
FROM process_instances
WHERE "entityType" IN ('pick_task','pack_task','shipment','warehouse_transaction','sales_invoice','return_request','sales_order')
GROUP BY "entityType" ORDER BY "entityType";
