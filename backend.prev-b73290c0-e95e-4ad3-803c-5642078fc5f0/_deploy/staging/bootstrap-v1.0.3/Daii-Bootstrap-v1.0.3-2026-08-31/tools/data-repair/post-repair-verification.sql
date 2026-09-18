-- Daii — Post-Repair Verification (read-only, safe to run directly)
--
-- Run this AFTER both ZeroBaselineCleanup and RepairNonCompliantUuids
-- have completed (on a scratch DB first, per DATA_REPAIR_RUNBOOK.md, then
-- again on production after those pass). Answers CTO requirement #7:
-- confirm nothing is broken across every listed domain, plus #6
-- ("verify zero orphan records").

-- ============================================================
-- 1. UUID compliance — every table should now show 0 non-compliant rows.
-- (Re-run uuid-audit.sql for the full per-table breakdown; this is a
-- single pass/fail summary.)
-- ============================================================
-- (See uuid-audit.sql — re-run it here; omitted from this file to avoid
-- duplicating ~50 lines. A non-zero result anywhere after the repair
-- migration ran means STOP and investigate before proceeding.)

-- ============================================================
-- 2. Identity/access baseline — confirm it survived byte-for-byte.
-- ============================================================
-- 2a. Every user can still resolve to their credentials (auth still works structurally).
SELECT u.id, u.email, u.status,
       c."passwordHash" IS NOT NULL AS has_credentials
FROM users u
LEFT JOIN credentials c ON c."userId" = u.id
ORDER BY u.email;
-- FAIL condition: any row where has_credentials = false (a user with no
-- matching credentials row means either the repair mis-cascaded users.id
-- -> credentials.userId, or something deleted a credentials row it
-- shouldn't have).

-- 2b. Every user's roles still resolve.
SELECT u.email, string_agg(r.key, ', ' ORDER BY r.key) AS roles
FROM users u
LEFT JOIN user_roles ur ON ur."userId" = u.id
LEFT JOIN roles r ON r.id = ur."roleId"
GROUP BY u.id, u.email
ORDER BY u.email;
-- Compare this output against the SAME query run on the pre-operation
-- backup (zero-baseline-deletion-report.sql section 1) — every user and
-- every role assignment must match exactly.

-- 2c. No orphaned user_roles / role_permissions (a roleId or userId that
-- doesn't resolve would mean the repair missed a cascade).
SELECT 'orphaned user_roles (bad userId)' AS check_name, count(*) FROM user_roles ur
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ur."userId")
UNION ALL
SELECT 'orphaned user_roles (bad roleId)', count(*) FROM user_roles ur
  WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = ur."roleId")
UNION ALL
SELECT 'orphaned role_permissions (bad roleId)', count(*) FROM role_permissions rp
  WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = rp."roleId");
-- FAIL condition: any count > 0.

-- ============================================================
-- 3. Zero Baseline — confirm the delete-list tables are actually empty
-- (except warehouses, which keeps MAIN-WH).
-- ============================================================
SELECT 'customers' AS table_name, count(*) FROM customers
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'sales_orders', count(*) FROM sales_orders
UNION ALL SELECT 'sales_order_lines', count(*) FROM sales_order_lines
UNION ALL SELECT 'deposits', count(*) FROM deposits
UNION ALL SELECT 'sales_invoices', count(*) FROM sales_invoices
UNION ALL SELECT 'customer_payments', count(*) FROM customer_payments
UNION ALL SELECT 'customer_ledger_entries', count(*) FROM customer_ledger_entries
UNION ALL SELECT 'stock_movements', count(*) FROM stock_movements
UNION ALL SELECT 'stock_reservations', count(*) FROM stock_reservations
UNION ALL SELECT 'shipments', count(*) FROM shipments
UNION ALL SELECT 'return_requests', count(*) FROM return_requests
UNION ALL SELECT 'vehicles', count(*) FROM vehicles
UNION ALL SELECT 'shipping_companies', count(*) FROM shipping_companies
UNION ALL SELECT 'warehouses (excl. MAIN-WH)', count(*) FROM warehouses WHERE code <> 'MAIN-WH'
UNION ALL SELECT 'warehouses (MAIN-WH present?)', count(*) FROM warehouses WHERE code = 'MAIN-WH';
-- FAIL condition: any row above 0 EXCEPT the last one, which should be
-- exactly 1 (MAIN-WH present and preserved).

-- ============================================================
-- 4. Domain-by-domain FK-orphan sweep — CTO requirement #7's explicit
-- list: customers, accounts, orders, warehouses, financial transactions,
-- inventory, shipments, returns, audit. Since business tables are empty
-- post-cleanup, this doubles as a check that the SURVIVING config rows
-- (e.g. treasury_accounts, if kept) have no dangling references into the
-- now-empty business tables.
-- ============================================================
SELECT 'treasury_accounts.accountTypeId orphans' AS check_name, count(*) FROM treasury_accounts ta
  WHERE ta."accountTypeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM treasury_account_types t WHERE t.id = ta."accountTypeId")
UNION ALL
SELECT 'price_list_items referencing a nonexistent product', count(*) FROM price_list_items pli
  WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = pli."productId")
UNION ALL
SELECT 'org_memberships referencing a nonexistent org_unit', count(*) FROM org_memberships om
  WHERE NOT EXISTS (SELECT 1 FROM org_units o WHERE o.id = om."orgUnitId")
UNION ALL
SELECT 'org_memberships referencing a nonexistent user', count(*) FROM org_memberships om
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = om."userId")
UNION ALL
SELECT 'scope_assignments referencing a nonexistent user', count(*) FROM scope_assignments sa
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sa."userId");
-- FAIL condition: any count > 0.

-- ============================================================
-- 5. Audit trail — confirm it was preserved untouched (row count same
-- before/after; this migration never deletes or rewrites it).
-- ============================================================
SELECT 'audit_records' AS table_name, count(*) FROM audit_records
UNION ALL SELECT 'event_outbox', count(*) FROM event_outbox
UNION ALL SELECT 'idempotency_records', count(*) FROM idempotency_records;
-- Compare against the pre-operation count — should be equal or, for
-- audit_records specifically, may have grown by exactly the number of
-- DELETE/UPDATE audit entries these two migrations themselves generate
-- IF the application's own audit hooks fire for direct SQL (they do not
-- — these migrations write raw SQL, not through AuditService — so the
-- expected answer is: unchanged).
