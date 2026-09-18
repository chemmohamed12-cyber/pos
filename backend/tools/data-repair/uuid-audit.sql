-- Daii — UUID PK Audit (read-only, safe to run directly against production)
--
-- Answers CTO requirement #1/#2: "حصر جميع الـUUIDs الموجودة فعليًا في قاعدة
-- البيانات" / "تحديد السجلات التي لا تتوافق مع UUID الصحيح".
--
-- For every table whose primary key defaults to gen_random_uuid() or
-- uuid_generate_v4() (both share the exact same defect — see
-- 1755852500000-FixGenRandomUuidRfc4122Compliance.ts — uuid_generate_v4()
-- is a thin wrapper over gen_random_uuid()), counts total rows and rows
-- whose id is NOT a valid RFC4122 UUID (the same check class-validator's
-- @IsUUID() performs: 8-4-4-4-12 hex, version nibble 1-5, variant nibble
-- 8/9/a/b). Read-only — a temp table + per-table SELECT COUNT(*), no
-- writes to any real table, no locks beyond an ordinary read. Uses a
-- PL/pgSQL DO block with dynamic SQL rather than query_to_xml()/similar,
-- so it doesn't depend on Postgres having been built with XML support.
--
-- Run this FIRST, before any repair, against the real database (or a
-- scratch restore of it) to get real numbers instead of the ~7.7%
-- estimate from the simulation. See DATA_REPAIR_RUNBOOK.md.

DO $$
DECLARE
  tbl TEXT;
  total BIGINT;
  bad BIGINT;
  tables TEXT[] := ARRAY[
    -- gen_random_uuid()-defaulted (44)
    'users', 'roles', 'user_roles', 'role_permissions', 'scope_assignments',
    'org_units', 'org_memberships', 'terminology_entries', 'process_instances',
    'process_transition_records', 'media_assets', 'customers', 'customer_assignments',
    'products', 'sales_orders', 'sales_order_lines', 'deposits', 'warehouses',
    'stock_movements', 'stock_reservations', 'fulfillment_orders', 'pick_tasks',
    'pack_tasks', 'shipments', 'tracking_events', 'delivery_outcomes', 'collections',
    'return_requests', 'return_dispositions', 'price_lists', 'price_list_items',
    'bill_of_materials', 'bom_components', 'integration_connectors',
    'integration_credentials', 'integration_product_mappings', 'integration_sync_logs',
    'warehouse_transactions', 'warehouse_transaction_lines', 'shipping_companies',
    'vehicles', 'pick_task_lines', 'idempotency_records', 'refresh_tokens',
    -- uuid_generate_v4()-defaulted (8) — same defect, different spelling
    'treasury_accounts', 'treasury_transactions', 'treasury_account_types',
    'return_credits', 'customer_ledger_entries', 'sales_invoices',
    'sales_invoice_lines', 'customer_payments'
    -- NOT included (intentionally): credentials, user_locale_preferences,
    -- sales_rep_profiles — their PK is a shared FK to users.id, not an
    -- independently generated value; they are only ever wrong if users.id
    -- itself is wrong, and get repaired in lockstep with it, not audited
    -- separately here.
  ];
BEGIN
  DROP TABLE IF EXISTS uuid_audit_results;
  CREATE TEMP TABLE uuid_audit_results (
    table_name TEXT,
    total_rows BIGINT,
    non_compliant_rows BIGINT
  );

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I', tbl) INTO total;
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE id::text !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''',
      tbl
    ) INTO bad;
    INSERT INTO uuid_audit_results VALUES (tbl, total, bad);
  END LOOP;
END $$;

SELECT
  table_name,
  total_rows,
  non_compliant_rows,
  CASE WHEN total_rows = 0 THEN 0
       ELSE round(100.0 * non_compliant_rows / total_rows, 1)
  END AS non_compliant_pct
FROM uuid_audit_results
ORDER BY non_compliant_rows DESC, table_name;

-- Reading the output:
--   non_compliant_rows = 0            -> table is clean, nothing to repair
--   non_compliant_rows = total_rows   -> every row in this table needs repair
--   0 < non_compliant_rows < total_rows -> a mix; the repair migration handles
--                                          this correctly either way (it only
--                                          ever touches rows that actually fail
--                                          the check, never a compliant row)
