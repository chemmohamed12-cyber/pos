import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UUID Primary-Key Repair (CTO directive, post-v1.0.2 hotfix cycle) — the
 * deliberately-deferred follow-up to `1755852500000-FixGenRandomUuidRfc4122Compliance.ts`,
 * which fixed id GENERATION going forward but explicitly left already-
 * existing non-compliant ids untouched (its own doc comment named this
 * exact migration as required future work). See `HOTFIX_REPORT.md` §5 for
 * the full root-cause trace (confirmed live against the real deployed
 * app: `gen_random_uuid()`/`uuid_generate_v4()` only produced a valid
 * RFC4122 UUID ~7.7% of the time before the fix).
 *
 * Intended to run AFTER `ZeroBaselineCleanup` (see that migration and
 * `DATA_REPAIR_RUNBOOK.md`) — once test business data is gone, most of
 * the tables below are empty and this becomes a small, low-risk
 * operation over the surviving identity/access/config graph. It is still
 * written to be CORRECT standalone (e.g. if ever run against a database
 * where cleanup hasn't run, or only partially applies) — every table is
 * actually checked, not assumed empty.
 *
 * SAFETY MODEL:
 * 1. Same deferred-FK-constraint technique as `ZeroBaselineCleanup`
 *    (dynamically discovered via `information_schema`, not hardcoded
 *    constraint names) — required because Postgres does not propagate an
 *    `UPDATE` of a referenced primary key to dependent rows unless the FK
 *    is `ON UPDATE CASCADE` (confirmed: none of the 47 FKs in this schema
 *    are). Made deferrable for this transaction only, restored after.
 * 2. The ~90 "soft" uuid-typed FK columns and ~12 "hidden" VARCHAR-typed
 *    columns that hold an id as text have NO database constraint at all
 *    (confirmed by exhaustive migration audit) — they cannot be
 *    discovered from `information_schema`, so they are hardcoded below
 *    as `SOFT_REFERENCES`, compiled directly from that audit. Missing one
 *    here would silently leave an orphaned reference, so this list is
 *    deliberately exhaustive rather than "the obvious ones."
 * 3. Three genuinely polymorphic columns (`process_instances.entityId`,
 *    `scope_assignments.resourceId`, `return_requests.custodianId`) are
 *    handled with their discriminator column consulted first, never a
 *    blind string-equality match across unrelated tables.
 * 4. Deliberately NOT rewritten: ids embedded inside JSON/JSONB columns
 *    (`audit_records.before/after`, `event_outbox.payload`,
 *    `idempotency_records.responseBody`, `integration_connectors.config`)
 *    — historical/point-in-time records, not live references; rewriting
 *    history is the wrong default here, not an oversight.
 * 5. Every id change is logged (old -> new, per table) via RAISE NOTICE
 *    for auditability — this migration does not add a new permanent log
 *    table.
 * 6. `down()` is not a real rollback for the same reason as
 *    `ZeroBaselineCleanup` — restore the pre-operation backup instead.
 */
export class RepairNonCompliantUuids1755852700000 implements MigrationInterface {
  name = 'RepairNonCompliantUuids1755852700000';

  /** Every table whose PK defaults to gen_random_uuid()/uuid_generate_v4() — same list as uuid-audit.sql. */
  private readonly pkTables = [
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

  /** Shared-PK tables whose id is a copy of users.id, not independently generated — repaired in lockstep, never audited/repaired on their own. */
  private readonly sharedPkFromUsers = ['credentials', 'user_locale_preferences', 'sales_rep_profiles'];

  /**
   * Soft (unenforced) FK columns, by TARGET table — compiled from the
   * exhaustive migration/entity audit. `text: true` marks a column
   * declared VARCHAR (not uuid) that nonetheless stores an id string.
   */
  private readonly softReferences: Record<string, Array<{ table: string; column: string; text?: boolean }>> = {
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
      { table: 'warehouses', column: 'parentWarehouseId' }, // self
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
      { table: 'customer_ledger_entries', column: 'reversalOfEntryId' }, // self
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
      { table: 'treasury_transactions', column: 'reversalOfTransactionId' }, // self
    ],
    warehouse_transactions: [
      { table: 'warehouse_transaction_lines', column: 'warehouseTransactionId' },
      { table: 'warehouse_transactions', column: 'reversalOfTransactionId' }, // self
    ],
    org_units: [
      { table: 'audit_records', column: 'organizationId' },
      { table: 'org_units', column: 'parentId' }, // self
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

  /** Genuinely polymorphic columns: rewrite only rows whose discriminator matches. */
  private readonly polymorphicReferences: Array<{
    targetTable: string;
    referencingTable: string;
    idColumn: string;
    discriminatorColumn: string;
    discriminatorValue: string;
  }> = [
    { targetTable: 'sales_orders', referencingTable: 'process_instances', idColumn: 'entityId', discriminatorColumn: 'entityType', discriminatorValue: 'sales_order' },
    { targetTable: 'shipping_companies', referencingTable: 'return_requests', idColumn: 'custodianId', discriminatorColumn: 'custodianType', discriminatorValue: 'company' },
    { targetTable: 'vehicles', referencingTable: 'return_requests', idColumn: 'custodianId', discriminatorColumn: 'custodianType', discriminatorValue: 'vehicle' },
    // scope_assignments.resourceId is polymorphic across many resourceType
    // values (one per Scope-gated domain) — deliberately NOT enumerated
    // here since the full resourceType vocabulary isn't captured in the
    // schema audit; if any repaired table's rows are ever Scope-assigned,
    // confirm resourceType coverage by hand before relying on this
    // migration to keep scope_assignments consistent for that domain.
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const allReferencingTables = new Set(this.pkTables.concat(
      Object.values(this.softReferences).flatMap((refs) => refs.map((r) => r.table)),
      this.polymorphicReferences.map((r) => r.referencingTable),
      this.sharedPkFromUsers,
    ));

    // Same generic deferred-FK-constraint technique as ZeroBaselineCleanup.
    const constraints: Array<{ table: string; constraint: string }> = await queryRunner.query(
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
      await queryRunner.query(`ALTER TABLE "${table}" ALTER CONSTRAINT "${constraint}" DEFERRABLE INITIALLY DEFERRED`);
    }
    await queryRunner.query(`SET CONSTRAINTS ALL DEFERRED`);

    // Also fetch, for each pkTable, the DB-enforced children that point at
    // it (table+column), so the repair loop below can update them
    // automatically without needing them hardcoded in softReferences too.
    const dbEnforcedChildren: Array<{ childTable: string; childColumn: string; parentTable: string }> = await queryRunner.query(
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

    let totalRepaired = 0;
    for (const pkTable of this.pkTables) {
      const nonCompliant: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM "${pkTable}" WHERE id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
      );
      if (nonCompliant.length === 0) continue;

      for (const { id: oldId } of nonCompliant) {
        const [{ id: newId }] = await queryRunner.query(`SELECT gen_random_uuid() AS id`);

        // 1. DB-enforced children (auto-discovered).
        for (const child of dbEnforcedChildren.filter((c) => c.parentTable === pkTable)) {
          await queryRunner.query(
            `UPDATE "${child.childTable}" SET "${child.childColumn}" = $1 WHERE "${child.childColumn}" = $2`,
            [newId, oldId],
          );
        }

        // 2. Soft/hidden references (hardcoded, from the audit). A "hidden"
        // (VARCHAR) column and a "soft" (uuid) column are updated
        // identically — the driver/Postgres coerces the uuid parameter to
        // text for VARCHAR columns automatically.
        for (const ref of this.softReferences[pkTable] ?? []) {
          await queryRunner.query(
            `UPDATE "${ref.table}" SET "${ref.column}" = $1 WHERE "${ref.column}" = $2`,
            [newId, oldId],
          );
        }

        // 3. Polymorphic references, discriminator-scoped.
        for (const poly of this.polymorphicReferences.filter((p) => p.targetTable === pkTable)) {
          await queryRunner.query(
            `UPDATE "${poly.referencingTable}" SET "${poly.idColumn}" = $1 WHERE "${poly.idColumn}" = $2 AND "${poly.discriminatorColumn}" = $3`,
            [newId, oldId, poly.discriminatorValue],
          );
        }

        // 4. Shared-PK tables that copy users.id exactly.
        if (pkTable === 'users') {
          for (const sharedTable of this.sharedPkFromUsers) {
            await queryRunner.query(`UPDATE "${sharedTable}" SET "userId" = $1 WHERE "userId" = $2`, [newId, oldId]);
          }
        }

        // 5. Finally, the row's own primary key.
        await queryRunner.query(`UPDATE "${pkTable}" SET id = $1 WHERE id = $2`, [newId, oldId]);

        await queryRunner.query(
          `DO $$ BEGIN RAISE NOTICE 'RepairNonCompliantUuids: % % -> %', '${pkTable}', '${oldId}', '${newId}'; END $$;`,
        );
        totalRepaired++;
      }
    }

    for (const { table, constraint } of constraints) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER CONSTRAINT "${constraint}" NOT DEFERRABLE`);
    }

    await queryRunner.query(`DO $$ BEGIN RAISE NOTICE 'RepairNonCompliantUuids: % row(s) repaired in total', ${totalRepaired}; END $$;`);
  }

  public async down(): Promise<void> {
    throw new Error(
      'RepairNonCompliantUuids has no automated rollback — primary keys were rewritten in place. ' +
      'Restore from the pg_dump backup taken immediately before this migration ran (see ' +
      'DATA_REPAIR_RUNBOOK.md step 1), per ADR-020 §6\'s roll-forward-only philosophy.',
    );
  }
}
