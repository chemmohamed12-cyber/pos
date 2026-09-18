/**
 * Release Center — Controlled Data Repair. Single source of truth for the
 * RFC4122 UUID primary-key repair: the SQL-level algorithm, the table /
 * FK / soft-reference / polymorphic-reference inventory, the read-only
 * audit, and the post-repair integrity verification.
 *
 * Imported by BOTH:
 *  - `tools/data-repair/deferred-migrations/1755852700000-RepairNonCompliantUuids.ts`
 *    (the migration path, kept for operators who want it), and
 *  - `DataRepairService` (the Release Center's first-class Controlled Data
 *    Repair capability: pre-repair backup gate -> audit -> mapping -> repair
 *    -> integrity verify -> evidence),
 * so the two can never diverge.
 *
 * WHY a repair is needed at all: `1755840100000-CreateUsers.ts` defined
 * `gen_random_uuid()` as `md5(random()::text || clock_timestamp()::text)::uuid`
 * (this hosting plan has no pgcrypto and no PG13 core UUID). That produces
 * UUID-shaped strings whose version and variant nibbles are random, so only
 * ~7.7% pass RFC4122 validation (`class-validator`'s `@IsUUID()`). Every
 * `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` row created before
 * `1755852500000-FixGenRandomUuidRfc4122Compliance.ts` ran has a ~92%
 * chance of being non-compliant. `1755852500000` fixed GENERATION going
 * forward; this module repairs the EXISTING rows.
 *
 * SAFETY MODEL (identical to the original migration's):
 *  1. Deferred-FK-constraint technique — every FK touching a repaired table
 *     is discovered dynamically via `information_schema` and made
 *     `DEFERRABLE INITIALLY DEFERRED` for the transaction, then restored to
 *     `NOT DEFERRABLE`. Postgres validates all constraints at COMMIT, so PK
 *     updates and child updates can run in any order.
 *  2. ~90 "soft" (uuid, no DB constraint) and ~12 "hidden" (VARCHAR storing
 *     an id) FK columns are not discoverable from `information_schema` — they
 *     are enumerated exhaustively in `SOFT_REFERENCES`, compiled from the
 *     full migration/entity audit. Missing one would silently orphan a
 *     reference.
 *  3. Genuinely polymorphic columns are rewritten only where their
 *     discriminator column matches — never a blind cross-table id match.
 *  4. Ids embedded in JSON/JSONB (`audit_records.before/after`,
 *     `event_outbox.payload`, `idempotency_records.responseBody`,
 *     `integration_connectors.config`) are deliberately NOT rewritten —
 *     point-in-time history, not live references.
 *  5. Every id change is returned as an `old -> new` mapping entry AND
 *     logged via `RAISE NOTICE`, for the repair evidence record.
 */

/** Minimal shape shared by TypeORM's `QueryRunner` and `EntityManager` — lets this module run inside a migration or inside a `DataSource.transaction()` callback with no adapter. */
export interface RepairSqlExecutor {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

/**
 * The strict RFC4122 check — 8-4-4-4-12 hex with version nibble 1-5 and
 * variant nibble 8/9/a/b. This is exactly what `class-validator`'s
 * `@IsUUID()` (default, "all" versions) enforces, and what
 * `treasury.controller.ts` / `deposits.controller.ts` reject a legacy id
 * against. Kept as a string so it can be interpolated into SQL (`!~*`) and
 * compiled to a `RegExp` in JS/tests.
 */
export const STRICT_UUID_REGEX_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const STRICT_UUID_REGEX = new RegExp(STRICT_UUID_REGEX_SQL, 'i');

export function isRfc4122Uuid(value: unknown): boolean {
  return typeof value === 'string' && STRICT_UUID_REGEX.test(value);
}

/** Every table whose primary key defaults to `gen_random_uuid()` / `uuid_generate_v4()` — same 52-table list as `tools/data-repair/uuid-audit.sql`. */
export const PK_TABLES: readonly string[] = [
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
  'treasury_accounts', 'treasury_transactions', 'treasury_account_types',
  'return_credits', 'customer_ledger_entries', 'sales_invoices',
  'sales_invoice_lines', 'customer_payments',
];

/** Shared-PK tables whose id is a copy of `users.id`, not independently generated — repaired in lockstep with `users`, never audited on their own. */
export const SHARED_PK_FROM_USERS: readonly string[] = ['credentials', 'user_locale_preferences', 'sales_rep_profiles'];

export interface SoftReference {
  table: string;
  column: string;
  /** true = column is declared VARCHAR (not uuid) but stores an id string. */
  text?: boolean;
}

/** Soft (unenforced) FK columns, keyed by TARGET table — compiled from the exhaustive migration/entity audit. */
export const SOFT_REFERENCES: Readonly<Record<string, readonly SoftReference[]>> = {
  users: [
    { table: 'warehouse_transactions', column: 'createdByUserId' },
    { table: 'warehouse_transactions', column: 'approvedByUserId' },
    { table: 'warehouse_transactions', column: 'postedByUserId' },
    { table: 'treasury_transactions', column: 'createdByUserId' },
    { table: 'vehicles', column: 'driverUserId' },
    { table: 'pick_task_lines', column: 'preparedByUserId' },
    { table: 'customer_ledger_entries', column: 'createdByUserId' },
    { table: 'sales_invoices', column: 'createdByUserId' },
    { table: 'sales_invoices', column: 'postedByUserId' },
    { table: 'customer_payments', column: 'recordedByUserId' },
    { table: 'sales_orders', column: 'createdByUserId' },
    { table: 'shipments', column: 'driverUserId' },
    { table: 'shipments', column: 'salesRepUserId' },
    { table: 'warehouses', column: 'responsibleUserId' },
    { table: 'media_assets', column: 'uploadedByUserId' },
    { table: 'pick_tasks', column: 'assignedToUserId' },
    { table: 'pack_tasks', column: 'assignedToUserId' },
    { table: 'stock_movements', column: 'createdByUserId' },
    { table: 'process_transition_records', column: 'actorUserId' },
    { table: 'audit_records', column: 'actorUserId' },
  ],
  warehouses: [
    { table: 'warehouse_transactions', column: 'warehouseId' },
    { table: 'warehouse_transactions', column: 'destinationWarehouseId' },
    { table: 'warehouses', column: 'parentWarehouseId' },
    { table: 'sales_orders', column: 'warehouseId' },
    { table: 'shipping_companies', column: 'warehouseId' },
    { table: 'vehicles', column: 'warehouseId' },
  ],
  shipments: [
    { table: 'customer_ledger_entries', column: 'shipmentId' },
    { table: 'sales_invoices', column: 'shipmentId' },
    { table: 'return_requests', column: 'shipmentId' },
    { table: 'delivery_outcomes', column: 'shipmentId', text: true },
    { table: 'collections', column: 'shipmentId', text: true },
  ],
  fulfillment_orders: [
    { table: 'pick_task_lines', column: 'fulfillmentOrderId' },
    { table: 'shipments', column: 'fulfillmentOrderId', text: true },
  ],
  shipping_companies: [
    { table: 'shipments', column: 'shippingCompanyId' },
    { table: 'vehicles', column: 'shippingCompanyId' },
  ],
  vehicles: [
    { table: 'shipments', column: 'vehicleId' },
  ],
  deposits: [
    { table: 'customer_ledger_entries', column: 'depositId' },
    { table: 'treasury_transactions', column: 'depositId' },
  ],
  return_requests: [
    { table: 'return_credits', column: 'returnRequestId' },
  ],
  sales_invoices: [
    { table: 'sales_invoice_lines', column: 'salesInvoiceId' },
    { table: 'customer_ledger_entries', column: 'invoiceId' },
    { table: 'customer_payments', column: 'invoiceId' },
    { table: 'return_credits', column: 'appliedToInvoiceId' },
  ],
  customer_payments: [
    { table: 'customer_ledger_entries', column: 'paymentId' },
  ],
  customer_ledger_entries: [
    { table: 'customer_ledger_entries', column: 'reversalOfEntryId' },
  ],
  treasury_account_types: [
    { table: 'treasury_accounts', column: 'accountTypeId' },
  ],
  treasury_accounts: [
    { table: 'customer_payments', column: 'treasuryAccountId' },
    { table: 'treasury_transactions', column: 'treasuryAccountId' },
    { table: 'collections', column: 'custodyAccountId' },
    { table: 'shipping_companies', column: 'custodyAccountId' },
    { table: 'shipping_companies', column: 'treasuryAccountId' },
    { table: 'vehicles', column: 'custodyAccountId' },
    { table: 'vehicles', column: 'settlementAccountId' },
  ],
  treasury_transactions: [
    { table: 'customer_ledger_entries', column: 'treasuryTransactionId' },
    { table: 'customer_payments', column: 'treasuryTransactionId' },
    { table: 'collections', column: 'custodyTransactionId' },
    { table: 'collections', column: 'treasuryTransactionId' },
    { table: 'treasury_transactions', column: 'reversalOfTransactionId' },
  ],
  warehouse_transactions: [
    { table: 'warehouse_transaction_lines', column: 'warehouseTransactionId' },
    { table: 'warehouse_transactions', column: 'reversalOfTransactionId' },
  ],
  org_units: [
    { table: 'audit_records', column: 'organizationId' },
    { table: 'org_units', column: 'parentId' },
  ],
  customers: [
    { table: 'customer_ledger_entries', column: 'customerId' },
    { table: 'customer_payments', column: 'customerId' },
    { table: 'sales_invoices', column: 'customerId' },
    { table: 'treasury_transactions', column: 'customerId' },
    { table: 'return_credits', column: 'customerId' },
  ],
  sales_orders: [
    { table: 'customer_ledger_entries', column: 'salesOrderId' },
    { table: 'sales_invoices', column: 'salesOrderId' },
    { table: 'shipments', column: 'salesOrderId' },
    { table: 'treasury_transactions', column: 'salesOrderId' },
    { table: 'fulfillment_orders', column: 'salesOrderId', text: true },
    { table: 'stock_reservations', column: 'salesOrderId', text: true },
    { table: 'return_requests', column: 'salesOrderId', text: true },
    { table: 'return_credits', column: 'originalSalesOrderId', text: true },
    { table: 'return_credits', column: 'appliedToSalesOrderId', text: true },
  ],
  sales_order_lines: [
    { table: 'sales_invoice_lines', column: 'salesOrderLineId' },
    { table: 'return_requests', column: 'salesOrderLineId' },
  ],
  products: [
    { table: 'sales_invoice_lines', column: 'productId' },
    { table: 'pick_task_lines', column: 'productId' },
    { table: 'warehouse_transaction_lines', column: 'productId' },
  ],
  media_assets: [
    { table: 'deposits', column: 'evidenceMediaAssetId' },
    { table: 'shipments', column: 'waybillImageMediaAssetId' },
  ],
  pick_tasks: [
    { table: 'pick_task_lines', column: 'pickTaskId' },
  ],
};

export interface PolymorphicReference {
  targetTable: string;
  referencingTable: string;
  idColumn: string;
  discriminatorColumn: string;
  discriminatorValue: string;
}

/**
 * Genuinely polymorphic columns: rewrite only rows whose discriminator matches.
 *
 * `process_instances.entityId` (text, no FK) is keyed by
 * `(definitionKey, entityType, entityId)` and the process engine's
 * `getState()` throws `NotFoundException` (→ HTTP 404) if the row for an
 * entity's CURRENT id is missing — so every process-tracked table whose PK
 * is repaired MUST have its `process_instances.entityId` remapped too, or
 * every list/detail view that enriches rows with process state 404s. The
 * full `entityType` vocabulary was compiled from every
 * `processEngine.start/getState/transition(...)` call site (2026-08-31,
 * after a real staging repair left fulfillment tasks / shipments /
 * warehouse transactions orphaned from their process instances).
 *
 * `scope_assignments.resourceId` (text, no FK, keyed by
 * `(userId, resourceType, resourceId)`) is only ever used with
 * `resourceType = 'customer'` (every `scope.assign/assertAccess/...` call
 * site) → `resourceId` is a `customers.id`.
 */
export const POLYMORPHIC_REFERENCES: readonly PolymorphicReference[] = [
  // process_instances.entityId — one entry per entityType the process engine uses
  { targetTable: 'sales_orders', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'sales_order' },
  { targetTable: 'sales_invoices', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'sales_invoice' },
  { targetTable: 'warehouse_transactions', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'warehouse_transaction' },
  { targetTable: 'return_requests', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'return_request' },
  { targetTable: 'shipments', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'shipment' },
  { targetTable: 'pack_tasks', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'pack_task' },
  { targetTable: 'pick_tasks', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'pick_task' },
  // return_requests.custodianId — company vs vehicle
  { targetTable: 'shipping_companies', referencingTable: 'return_requests', idColumn: 'custodianId', discriminatorColumn: 'custodianType', discriminatorValue: 'company' },
  { targetTable: 'vehicles', referencingTable: 'return_requests', idColumn: 'custodianId', discriminatorColumn: 'custodianType', discriminatorValue: 'vehicle' },
  // scope_assignments.resourceId — only ever 'customer'
  { targetTable: 'customers', referencingTable: 'scope_assignments', idColumn: 'resourceId', discriminatorColumn: 'resourceType', discriminatorValue: 'customer' },
];

export interface RepairMappingEntry {
  table: string;
  oldId: string;
  newId: string;
}

export interface UuidAuditTableResult {
  table: string;
  totalRows: number;
  nonCompliantRows: number;
  /** Up to 10 example non-compliant ids, for the reviewable audit report. */
  sampleNonCompliantIds: string[];
}

export interface UuidAuditResult {
  generatedAt: string;
  strictRegex: string;
  tables: UuidAuditTableResult[];
  totalNonCompliant: number;
  /** True only if `zero_baseline` conditions are met — i.e. business tables carry non-compliant rows that a repair would rewrite in bulk; purely advisory, never triggers a cleanup. */
  zeroBaselineCleanupAdvised: boolean;
}

export interface UuidIntegrityResult {
  passed: boolean;
  checks: Array<{ name: string; count: number; ok: boolean }>;
  remainingNonCompliant: number;
}

async function tableExists(x: RepairSqlExecutor, table: string): Promise<boolean> {
  const rows = await x.query<Array<{ exists: boolean }>>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${table}`],
  );
  return rows[0]?.exists === true;
}

/**
 * READ-ONLY. Per-table total + non-compliant counts + sample ids. Writes
 * nothing, takes only ordinary read locks. Skips tables that don't exist
 * (a partially-migrated scratch DB), never throws on a missing table.
 */
export async function auditNonCompliantUuids(x: RepairSqlExecutor): Promise<UuidAuditResult> {
  const tables: UuidAuditTableResult[] = [];
  let totalNonCompliant = 0;

  for (const table of PK_TABLES) {
    if (!(await tableExists(x, table))) continue;
    const [{ count: totalRows }] = await x.query<Array<{ count: string }>>(`SELECT count(*)::text AS count FROM "${table}"`);
    const bad = await x.query<Array<{ id: string }>>(
      `SELECT id::text AS id FROM "${table}" WHERE id::text !~* '${STRICT_UUID_REGEX_SQL}' LIMIT 10`,
    );
    const [{ count: nonCompliantRows }] = await x.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM "${table}" WHERE id::text !~* '${STRICT_UUID_REGEX_SQL}'`,
    );
    const n = Number(nonCompliantRows);
    totalNonCompliant += n;
    tables.push({
      table,
      totalRows: Number(totalRows),
      nonCompliantRows: n,
      sampleNonCompliantIds: bad.map((r) => r.id),
    });
  }

  // "Advised" only when the non-identity business tables carry a large
  // share of non-compliant rows — a signal the operator may prefer a Zero
  // Baseline cleanup over a bulk rewrite. Advisory only; ZeroBaselineCleanup
  // is never run automatically.
  const businessTables = new Set(['customers', 'products', 'sales_orders', 'sales_order_lines', 'deposits', 'shipments']);
  const businessNonCompliant = tables.filter((t) => businessTables.has(t.table)).reduce((s, t) => s + t.nonCompliantRows, 0);
  const zeroBaselineCleanupAdvised = businessNonCompliant > 200;

  return {
    generatedAt: new Date().toISOString(),
    strictRegex: STRICT_UUID_REGEX_SQL,
    tables: tables.sort((a, b) => b.nonCompliantRows - a.nonCompliantRows || a.table.localeCompare(b.table)),
    totalNonCompliant,
    zeroBaselineCleanupAdvised,
  };
}

/**
 * READ-ONLY. For every non-compliant id in every repairable table, allocate
 * a fresh `gen_random_uuid()` (now RFC4122-compliant, post-`1755852500000`)
 * as its replacement. Returns the full reviewable `old -> new` map without
 * writing anything — the "Dry Run / Mapping" step of a Controlled Data
 * Repair.
 */
export async function planUuidRepairMapping(x: RepairSqlExecutor): Promise<RepairMappingEntry[]> {
  const mapping: RepairMappingEntry[] = [];
  for (const table of PK_TABLES) {
    if (!(await tableExists(x, table))) continue;
    const rows = await x.query<Array<{ id: string }>>(
      `SELECT id::text AS id FROM "${table}" WHERE id::text !~* '${STRICT_UUID_REGEX_SQL}'`,
    );
    for (const { id: oldId } of rows) {
      const [{ id: newId }] = await x.query<Array<{ id: string }>>(`SELECT gen_random_uuid()::text AS id`);
      mapping.push({ table, oldId, newId });
    }
  }
  return mapping;
}

interface DbEnforcedChild {
  childTable: string;
  childColumn: string;
  parentTable: string;
}

/**
 * The actual repair. MUST run inside a transaction (the caller opens it —
 * a migration's implicit transaction, or `DataSource.transaction()`).
 * Rewrites every non-compliant primary key to a fresh RFC4122 UUID and
 * updates every DB-enforced, soft, hidden, polymorphic, and shared-PK
 * reference to match. Returns the `old -> new` mapping actually applied.
 *
 * If `predefinedMapping` is supplied (from `planUuidRepairMapping`, reviewed
 * and approved), those exact new ids are used; otherwise fresh ids are
 * allocated inline. Supplying the reviewed mapping is the recommended path
 * for a Controlled Data Repair so the evidence file and the applied change
 * are provably identical.
 */
export async function runUuidRfc4122Repair(
  x: RepairSqlExecutor,
  predefinedMapping?: RepairMappingEntry[],
): Promise<{ mapping: RepairMappingEntry[]; totalRepaired: number }> {
  const allReferencingTables = new Set<string>([
    ...PK_TABLES,
    ...Object.values(SOFT_REFERENCES).flatMap((refs) => refs.map((r) => r.table)),
    ...POLYMORPHIC_REFERENCES.map((r) => r.referencingTable),
    ...SHARED_PK_FROM_USERS,
  ]);

  const constraints = await x.query<Array<{ table: string; constraint: string }>>(
    `
    SELECT DISTINCT tc.table_name AS table, tc.constraint_name AS constraint
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.constraint_schema = 'public'
      AND (tc.table_name = ANY($1::text[]) OR ccu.table_name = ANY($1::text[]))
    `,
    [[...allReferencingTables]],
  );
  for (const { table, constraint } of constraints) {
    await x.query(`ALTER TABLE "${table}" ALTER CONSTRAINT "${constraint}" DEFERRABLE INITIALLY DEFERRED`);
  }
  await x.query(`SET CONSTRAINTS ALL DEFERRED`);

  const dbEnforcedChildren = await x.query<DbEnforcedChild[]>(
    `
    SELECT
      kcu.table_name AS "childTable",
      kcu.column_name AS "childColumn",
      ccu.table_name AS "parentTable"
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_schema = 'public'
    `,
  );

  const mapping: RepairMappingEntry[] = [];
  const predefinedByTable = new Map<string, Map<string, string>>();
  for (const m of predefinedMapping ?? []) {
    if (!predefinedByTable.has(m.table)) predefinedByTable.set(m.table, new Map());
    predefinedByTable.get(m.table)!.set(m.oldId, m.newId);
  }

  let totalRepaired = 0;
  for (const pkTable of PK_TABLES) {
    if (!(await tableExists(x, pkTable))) continue;
    const nonCompliant = await x.query<Array<{ id: string }>>(
      `SELECT id::text AS id FROM "${pkTable}" WHERE id::text !~* '${STRICT_UUID_REGEX_SQL}'`,
    );
    if (nonCompliant.length === 0) continue;

    for (const { id: oldId } of nonCompliant) {
      let newId = predefinedByTable.get(pkTable)?.get(oldId);
      if (!newId) {
        const [{ id }] = await x.query<Array<{ id: string }>>(`SELECT gen_random_uuid()::text AS id`);
        newId = id;
      }

      for (const child of dbEnforcedChildren.filter((c) => c.parentTable === pkTable)) {
        await x.query(`UPDATE "${child.childTable}" SET "${child.childColumn}" = $1 WHERE "${child.childColumn}" = $2`, [newId, oldId]);
      }
      for (const ref of SOFT_REFERENCES[pkTable] ?? []) {
        await x.query(`UPDATE "${ref.table}" SET "${ref.column}" = $1 WHERE "${ref.column}" = $2`, [newId, oldId]);
      }
      for (const poly of POLYMORPHIC_REFERENCES.filter((p) => p.targetTable === pkTable)) {
        await x.query(
          `UPDATE "${poly.referencingTable}" SET "${poly.idColumn}" = $1 WHERE "${poly.idColumn}" = $2 AND "${poly.discriminatorColumn}" = $3`,
          [newId, oldId, poly.discriminatorValue],
        );
      }
      if (pkTable === 'users') {
        for (const sharedTable of SHARED_PK_FROM_USERS) {
          if (await tableExists(x, sharedTable)) {
            await x.query(`UPDATE "${sharedTable}" SET "userId" = $1 WHERE "userId" = $2`, [newId, oldId]);
          }
        }
      }
      await x.query(`UPDATE "${pkTable}" SET id = $1 WHERE id = $2`, [newId, oldId]);

      await x.query(
        `DO $$ BEGIN RAISE NOTICE 'UuidRfc4122Repair: % % -> %', $tag$${pkTable}$tag$, $tag$${oldId}$tag$, $tag$${newId}$tag$; END $$;`,
      );
      mapping.push({ table: pkTable, oldId, newId });
      totalRepaired++;
    }
  }

  // Force every deferred FK to be re-checked NOW, while still in the
  // transaction — a real violation surfaces here (and rolls the whole
  // repair back) rather than at COMMIT. Also required before the ALTER
  // below: Postgres refuses `ALTER TABLE ... ALTER CONSTRAINT` while the
  // table has pending (unresolved deferred) trigger events
  // (`cannot ALTER TABLE ... because it has pending trigger events`,
  // SQLSTATE 55006 — caught by the scratch rehearsal, 2026-08-31).
  await x.query(`SET CONSTRAINTS ALL IMMEDIATE`);
  for (const { table, constraint } of constraints) {
    await x.query(`ALTER TABLE "${table}" ALTER CONSTRAINT "${constraint}" NOT DEFERRABLE`);
  }
  await x.query(`DO $$ BEGIN RAISE NOTICE 'UuidRfc4122Repair: % row(s) repaired in total', ${totalRepaired}; END $$;`);

  return { mapping, totalRepaired };
}

/**
 * READ-ONLY post-repair verification. FK-orphan sweep across the
 * DB-enforced + soft/hidden references, auth/role integrity, and a re-audit
 * expecting zero remaining non-compliant ids. `passed` is true only when
 * every check is `ok`.
 */
export async function verifyUuidRepairIntegrity(x: RepairSqlExecutor): Promise<UuidIntegrityResult> {
  const checks: UuidIntegrityResult['checks'] = [];

  const addCheck = async (name: string, sql: string, params?: unknown[]) => {
    try {
      const rows = await x.query<Array<{ count: string }>>(sql, params);
      const count = Number(rows[0]?.count ?? 0);
      checks.push({ name, count, ok: count === 0 });
    } catch (err) {
      checks.push({ name: `${name} (query failed: ${err instanceof Error ? err.message : String(err)})`, count: -1, ok: false });
    }
  };

  // DB-enforced FK orphans, auto-discovered.
  const dbEnforcedChildren = await x.query<DbEnforcedChild[]>(
    `
    SELECT kcu.table_name AS "childTable", kcu.column_name AS "childColumn", ccu.table_name AS "parentTable"
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_schema = 'public'
    `,
  );
  for (const c of dbEnforcedChildren) {
    await addCheck(
      `orphan: ${c.childTable}.${c.childColumn} -> ${c.parentTable}`,
      `SELECT count(*)::text AS count FROM "${c.childTable}" ch
        WHERE ch."${c.childColumn}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "${c.parentTable}" p WHERE p.id = ch."${c.childColumn}")`,
    );
  }

  // Soft/hidden FK orphans (not discoverable from information_schema).
  for (const [parentTable, refs] of Object.entries(SOFT_REFERENCES)) {
    if (!(await tableExists(x, parentTable))) continue;
    for (const ref of refs) {
      if (!(await tableExists(x, ref.table))) continue;
      const cmp = ref.text ? `p.id::text = ch."${ref.column}"` : `p.id = ch."${ref.column}"`;
      await addCheck(
        `orphan (soft): ${ref.table}.${ref.column} -> ${parentTable}`,
        `SELECT count(*)::text AS count FROM "${ref.table}" ch
          WHERE ch."${ref.column}" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "${parentTable}" p WHERE ${cmp})`,
      );
    }
  }

  // Polymorphic (text, discriminator-scoped, no FK) orphans — the class the
  // 2026-08-31 staging repair missed: a repaired PK whose
  // process_instances.entityId / scope_assignments.resourceId row was left
  // pointing at the old id, which the process engine / scope guard then
  // can't resolve (HTTP 404).
  for (const poly of POLYMORPHIC_REFERENCES) {
    if (!(await tableExists(x, poly.referencingTable)) || !(await tableExists(x, poly.targetTable))) continue;
    await addCheck(
      `orphan (polymorphic): ${poly.referencingTable}.${poly.idColumn} [${poly.discriminatorColumn}=${poly.discriminatorValue}] -> ${poly.targetTable}`,
      `SELECT count(*)::text AS count FROM "${poly.referencingTable}" ch
        WHERE ch."${poly.discriminatorColumn}" = $1
          AND ch."${poly.idColumn}" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "${poly.targetTable}" p WHERE p.id::text = ch."${poly.idColumn}")`,
      [poly.discriminatorValue],
    );
  }

  // Auth/role integrity.
  if (await tableExists(x, 'credentials')) {
    await addCheck(
      'users without matching credentials',
      `SELECT count(*)::text AS count FROM users u WHERE NOT EXISTS (SELECT 1 FROM credentials c WHERE c."userId" = u.id)`,
    );
  }
  await addCheck(
    'orphan user_roles (bad userId)',
    `SELECT count(*)::text AS count FROM user_roles ur WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ur."userId")`,
  );
  await addCheck(
    'orphan user_roles (bad roleId)',
    `SELECT count(*)::text AS count FROM user_roles ur WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = ur."roleId")`,
  );
  await addCheck(
    'orphan role_permissions (bad roleId)',
    `SELECT count(*)::text AS count FROM role_permissions rp WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = rp."roleId")`,
  );

  // Re-audit: zero non-compliant ids anywhere.
  const audit = await auditNonCompliantUuids(x);
  checks.push({ name: 'remaining non-compliant primary keys', count: audit.totalNonCompliant, ok: audit.totalNonCompliant === 0 });

  return {
    passed: checks.every((c) => c.ok),
    checks,
    remainingNonCompliant: audit.totalNonCompliant,
  };
}
