# F-INV-001 — read-only usage measurement (to be run by an authorised operator; D-9)

Purpose: establish whether any real Company data shows use of the movement types that `POST /api/inventory/movements` now refuses (410). NOT executed by the agent: it requires a real/staging Company database, which is outside the approved local scope. Read-only (SELECT only). Run per Company database; save the output with a timestamp and the database name.

```sql
-- Q1: movements created through the HTTP endpoint (the controller passed referenceType/referenceId = NULL); by type, with first/last use and negative rows
SELECT "movementType", count(*) AS n, min("createdAt") AS first_use, max("createdAt") AS last_use, count(*) FILTER (WHERE quantity < 0) AS negative_rows
FROM stock_movements
WHERE "referenceType" IS NULL AND "referenceId" IS NULL
GROUP BY 1 ORDER BY 1;

-- Q2: the actors behind non-receipt HTTP-origin movements (identifies the consumer: a person, or a service/API-key identity)
SELECT sm."movementType", sm."createdByUserId", count(*) AS n, max(sm."createdAt") AS last_use
FROM stock_movements sm
WHERE sm."referenceType" IS NULL AND sm."referenceId" IS NULL AND sm."movementType" <> 'receipt'
GROUP BY 1, 2 ORDER BY n DESC;

-- Q3: audit trail of the same calls (action = inventory.movement.<type>)
SELECT action, count(*) AS n, min("timestamp") AS first_use, max("timestamp") AS last_use
FROM audit_records
WHERE action LIKE 'inventory.movement.%' AND action <> 'inventory.movement.receipt'
GROUP BY 1 ORDER BY 1;

-- Q4: negative on-hand pairs (a symptom of the closed path)
SELECT "warehouseId", "productId", sum(quantity) AS on_hand FROM stock_movements GROUP BY 1, 2 HAVING sum(quantity) < 0;
```
Decision rule (from `F-INV-001-FINAL-CONTRACT-AND-T09-CRITERIA §3`): zero rows in Q1/Q2 for non-receipt types (apart from rows explained by internal flows) ⇒ closure can proceed; any real consumer ⇒ identify it first and decide between a deprecation window and migrating the consumer. Interpretation caveat: Q1 also matches rows written by internal callers that pass NULL references; Q2/Q3 identify actors. Absence of rows in one database does not prove absence of external consumers elsewhere.
