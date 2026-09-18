-- Daii — Zero Baseline Deletion Report (read-only, safe to run directly)
--
-- Answers CTO requirement #2/#3: "تحديد السجلات التي لا تتوافق... Produce
-- an exact deletion report... Show what will be deleted and what will be
-- preserved." Pure SELECT — does not delete or modify anything. Run this,
-- review it, resolve the five "NEEDS CONFIRMATION" sections below, THEN
-- run the actual ZeroBaselineCleanup migration. See DATA_REPAIR_RUNBOOK.md.

-- ============================================================
-- SECTION 1 — PRESERVED (identity/access/config). Row counts only,
-- to confirm nothing here is accidentally touched by the cleanup
-- migration (it should never change from before to after).
-- ============================================================
SELECT 'PRESERVED: users' AS section, count(*) AS row_count FROM users
UNION ALL SELECT 'PRESERVED: credentials', count(*) FROM credentials
UNION ALL SELECT 'PRESERVED: refresh_tokens', count(*) FROM refresh_tokens
UNION ALL SELECT 'PRESERVED: user_locale_preferences', count(*) FROM user_locale_preferences
UNION ALL SELECT 'PRESERVED: sales_rep_profiles', count(*) FROM sales_rep_profiles
UNION ALL SELECT 'PRESERVED: roles', count(*) FROM roles
UNION ALL SELECT 'PRESERVED: user_roles', count(*) FROM user_roles
UNION ALL SELECT 'PRESERVED: role_permissions', count(*) FROM role_permissions
UNION ALL SELECT 'PRESERVED: org_units', count(*) FROM org_units
UNION ALL SELECT 'PRESERVED: org_memberships', count(*) FROM org_memberships
UNION ALL SELECT 'PRESERVED: scope_assignments', count(*) FROM scope_assignments
UNION ALL SELECT 'PRESERVED: terminology_entries', count(*) FROM terminology_entries
UNION ALL SELECT 'PRESERVED: numbering_sequences', count(*) FROM numbering_sequences;

-- List every user by name/email/role so you can visually confirm the
-- identity baseline is exactly who you expect, before touching anything.
SELECT u.id, u.email, u."fullName", u.status,
       string_agg(r.key, ', ' ORDER BY r.key) AS roles
FROM users u
LEFT JOIN user_roles ur ON ur."userId" = u.id
LEFT JOIN roles r ON r.id = ur."roleId"
GROUP BY u.id, u.email, u."fullName", u.status
ORDER BY u."fullName";

-- ============================================================
-- SECTION 2 — TO BE DELETED (unambiguous test business data).
-- Row counts only, so you can sanity-check the numbers before the
-- real migration runs.
-- ============================================================
SELECT 'DELETE: customers' AS section, count(*) AS row_count FROM customers
UNION ALL SELECT 'DELETE: customer_assignments', count(*) FROM customer_assignments
UNION ALL SELECT 'DELETE: products', count(*) FROM products
UNION ALL SELECT 'DELETE: sales_orders', count(*) FROM sales_orders
UNION ALL SELECT 'DELETE: sales_order_lines', count(*) FROM sales_order_lines
UNION ALL SELECT 'DELETE: deposits', count(*) FROM deposits
UNION ALL SELECT 'DELETE: sales_invoices', count(*) FROM sales_invoices
UNION ALL SELECT 'DELETE: sales_invoice_lines', count(*) FROM sales_invoice_lines
UNION ALL SELECT 'DELETE: customer_payments', count(*) FROM customer_payments
UNION ALL SELECT 'DELETE: customer_ledger_entries', count(*) FROM customer_ledger_entries
UNION ALL SELECT 'DELETE: stock_movements', count(*) FROM stock_movements
UNION ALL SELECT 'DELETE: stock_reservations', count(*) FROM stock_reservations
UNION ALL SELECT 'DELETE: warehouse_transactions', count(*) FROM warehouse_transactions
UNION ALL SELECT 'DELETE: warehouse_transaction_lines', count(*) FROM warehouse_transaction_lines
UNION ALL SELECT 'DELETE: fulfillment_orders', count(*) FROM fulfillment_orders
UNION ALL SELECT 'DELETE: pick_tasks', count(*) FROM pick_tasks
UNION ALL SELECT 'DELETE: pick_task_lines', count(*) FROM pick_task_lines
UNION ALL SELECT 'DELETE: pack_tasks', count(*) FROM pack_tasks
UNION ALL SELECT 'DELETE: shipments', count(*) FROM shipments
UNION ALL SELECT 'DELETE: tracking_events', count(*) FROM tracking_events
UNION ALL SELECT 'DELETE: delivery_outcomes', count(*) FROM delivery_outcomes
UNION ALL SELECT 'DELETE: collections', count(*) FROM collections
UNION ALL SELECT 'DELETE: return_requests', count(*) FROM return_requests
UNION ALL SELECT 'DELETE: return_dispositions', count(*) FROM return_dispositions
UNION ALL SELECT 'DELETE: return_credits', count(*) FROM return_credits
UNION ALL SELECT 'DELETE: vehicles', count(*) FROM vehicles
UNION ALL SELECT 'DELETE: shipping_companies', count(*) FROM shipping_companies
UNION ALL SELECT 'DELETE: warehouses (excluding MAIN-WH)', count(*) FROM warehouses WHERE code <> 'MAIN-WH'
UNION ALL SELECT 'DELETE: bill_of_materials', count(*) FROM bill_of_materials
UNION ALL SELECT 'DELETE: bom_components', count(*) FROM bom_components
UNION ALL SELECT 'DELETE: media_assets', count(*) FROM media_assets
UNION ALL SELECT 'DELETE: process_instances (entityType matching a deleted domain)', count(*)
  FROM process_instances WHERE "entityType" IN ('sales_order') -- extend this list if other entityTypes exist
UNION ALL SELECT 'DELETE: process_transition_records (same scope as above)', count(*)
  FROM process_transition_records ptr
  WHERE ptr."processInstanceId" IN (SELECT id FROM process_instances WHERE "entityType" IN ('sales_order'));

-- ============================================================
-- SECTION 3 — NEEDS YOUR CONFIRMATION before the cleanup migration runs.
-- These are NOT deleted by the migration as written — it will refuse to
-- run until you've reviewed this section and either (a) confirmed the
-- migration's hardcoded real-vs-test list matches what you see below, or
-- (b) told me to adjust it.
-- ============================================================

-- 3a. Treasury accounts — which of these are your real chart of accounts
-- (keep, zero balance is fine) vs. test/demo accounts (delete)?
SELECT ta.id, ta.code, ta.name, ta.status, tat.name AS account_type,
       (SELECT count(*) FROM treasury_transactions tt WHERE tt."treasuryAccountId" = ta.id) AS transaction_count
FROM treasury_accounts ta
LEFT JOIN treasury_account_types tat ON tat.id = ta."accountTypeId"
ORDER BY ta.code;

-- 3b. Price lists — which are real system config (e.g. the Main/General
-- lists from the Hotfix 3 delta) vs. test lists created during testing?
SELECT id, code, name, status, role,
       (SELECT count(*) FROM price_list_items pli WHERE pli."priceListId" = price_lists.id) AS item_count
FROM price_lists
ORDER BY code;

-- 3c. Integration connectors — any real, live connector (e.g. a genuine
-- QR Store pairing) must be preserved; test/demo connectors should go.
SELECT id, "connectorType", status, "createdAt" FROM integration_connectors ORDER BY "createdAt";

-- 3d. Audit / event / idempotency history — recommendation is to PRESERVE
-- these as-is (never rewrite audit history); listed here only so you can
-- see the volume of records this implies keeping.
SELECT 'audit_records (recommend: PRESERVE, not deleted by the migration)' AS section, count(*) FROM audit_records
UNION ALL SELECT 'event_outbox (recommend: PRESERVE)', count(*) FROM event_outbox
UNION ALL SELECT 'idempotency_records (recommend: PRESERVE, or let TTL/expiry handle it if one exists)', count(*) FROM idempotency_records;

-- 3e. Any warehouse other than MAIN-WH currently holding stock — confirm
-- these are genuinely test-only before they're deleted (their
-- stock_movements/stock_reservations rows go with them).
SELECT w.id, w.code, w.name, w.status,
       (SELECT count(*) FROM stock_movements sm WHERE sm."warehouseId" = w.id) AS movement_count
FROM warehouses w
WHERE w.code <> 'MAIN-WH'
ORDER BY w.code;
