-- Q1  stock that has no (or a different) valuation row: quantity without value
WITH s AS (SELECT "warehouseId", "productId", sum(quantity) AS on_hand FROM stock_movements GROUP BY 1,2)
SELECT s."warehouseId", s."productId", s.on_hand, v."onHandQuantity" AS valuation_qty, v."totalValueBase"
FROM s LEFT JOIN inventory_valuation_state v ON v."warehouseId" = s."warehouseId" AND v."productId" = s."productId"
WHERE s.on_hand > 0 AND (v."productId" IS NULL OR v."onHandQuantity" <> s.on_hand);
-- Q2  movements that require a financial event but have none (and none pending in the outbox)
SELECT m.id, m."movementType", m."referenceType", m.quantity, m."createdAt"
FROM stock_movements m
WHERE (m."movementType" IN ('dispatch','adjustment','return_in') OR (m."movementType" = 'receipt' AND m."referenceType" IN ('excel_import','manual_receipt')))
  AND NOT EXISTS (SELECT 1 FROM accounting_financial_events fe WHERE fe."idempotencyKey" = 'inventory:movement:' || m.id || ':recorded')
  AND NOT EXISTS (SELECT 1 FROM event_outbox o WHERE o.topic = 'inventory.movement.recorded' AND o.payload->>'idempotencyKey' = 'inventory:movement:' || m.id || ':recorded' AND o.status IN ('pending','processing'));
-- Q3  financial events by type, status and rejection reason
SELECT "eventType", status, left(coalesce("rejectionReason", ''), 90) AS reason, count(*)::int AS n FROM accounting_financial_events GROUP BY 1,2,3 ORDER BY 1,2,3;
-- Q4  valuation total vs the posted balance of the inventory control account(s)
SELECT (SELECT coalesce(sum("totalValueBase"), 0) FROM inventory_valuation_state) AS valuation_total,
       (SELECT coalesce(sum(l."debitBase" - l."creditBase"), 0) FROM accounting_journal_lines l
          JOIN accounting_journal_entries e ON e.id = l."journalEntryId"
          JOIN accounting_gl_accounts a ON a.id = l."accountId"
         WHERE a."controlFunction" = 'inventory'
           AND EXISTS (SELECT 1 FROM process_instances pi WHERE pi."definitionKey" = 'accounting_journal_entry' AND pi."entityType" = 'JournalEntry' AND pi."entityId" = e.id::text AND pi."currentState" IN ('POSTED','REVERSED'))) AS gl_inventory_posted;
-- Q5  outbox rows not yet dispatched (pending / processing / failed)
SELECT topic, status, count(*)::int AS n, min("createdAt") AS oldest FROM event_outbox WHERE status <> 'dispatched' GROUP BY 1,2 ORDER BY 1,2;
-- Q6  how stock entered: receipts by reference type
SELECT "referenceType", count(*)::int AS movements, sum(quantity)::int AS quantity FROM stock_movements WHERE "movementType" = 'receipt' GROUP BY 1 ORDER BY 1;
