import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zero Baseline Cleanup (CTO directive, post-v1.0.2 hotfix cycle) —
 * clears TEST BUSINESS DATA while leaving IDENTITY/ACCESS data byte-for-
 * byte untouched: users, credentials, refresh_tokens,
 * user_locale_preferences, sales_rep_profiles, roles, user_roles,
 * role_permissions, org_units, org_memberships, scope_assignments,
 * terminology_entries, numbering_sequences. This migration never issues
 * a DELETE against any of those tables — see `PRESERVED_TABLES` below,
 * checked defensively at runtime, not just by omission.
 *
 * SAFETY MODEL — read before running, see DATA_REPAIR_RUNBOOK.md for the
 * full procedure:
 * 1. This is NOT ordering-dependent. Rather than hand-computing a ~40-
 *    table topological delete order (error-prone at this scale — one
 *    mistake means a mid-transaction FK violation, or worse, a silent
 *    wrong-order success that leaves something orphaned), every FK
 *    constraint pointing at a table on the delete list is discovered
 *    dynamically via `information_schema` and made DEFERRABLE for the
 *    duration of this one transaction, then set back to its original
 *    (NOT DEFERRABLE) state at the end — Postgres then only validates
 *    every constraint at COMMIT, not after each statement, so the
 *    DELETEs below can run in any order safely.
 * 2. Three ambiguous categories from HOTFIX_REPORT.md / DATA_REPAIR_RUNBOOK.md
 *    are intentionally NOT auto-decided here:
 *    - `treasury_accounts`/`treasury_account_types` and `price_lists` —
 *      NOT deleted by this migration at all (kept, whatever they contain
 *      today). `price_list_items` IS deleted (see below — it must be,
 *      once `products` is gone, or every remaining item orphans its
 *      `productId` FK; the price LIST rows themselves survive empty).
 *      If any `treasury_accounts` rows are confirmed test-only after
 *      reviewing `zero-baseline-deletion-report.sql`, delete those
 *      specific rows by hand (or a tiny follow-up migration) — not
 *      silently assumed here.
 *    - `integration_connectors` and its children — NOT deleted here,
 *      same reasoning (a real connector may exist).
 *    - `audit_records`, `event_outbox`, `idempotency_records` —
 *      deliberately PRESERVED (standard practice: never delete audit
 *      history; they become a harmless historical record of test
 *      activity once the business data they describe is gone).
 * 3. `process_instances`/`process_transition_records` ARE deleted, but
 *    only rows whose polymorphic `entityType` matches a domain actually
 *    being cleared (`sales_order` today — extend `PROCESS_ENTITY_TYPES`
 *    below if another workflow-tracked entity type is added later).
 * 4. `down()` is deliberately NOT a real rollback — deleted business
 *    data cannot be un-deleted by a migration. The real undo path is
 *    restoring the pre-operation `pg_dump` backup (ADR-020 §6's own
 *    "roll forward, not down-migration" philosophy for anything beyond
 *    a pure schema change).
 */
export class ZeroBaselineCleanup1755852600000 implements MigrationInterface {
  name = 'ZeroBaselineCleanup1755852600000';

  private readonly preservedTables = [
    'users', 'credentials', 'refresh_tokens', 'user_locale_preferences',
    'sales_rep_profiles', 'roles', 'user_roles', 'role_permissions',
    'org_units', 'org_memberships', 'scope_assignments', 'terminology_entries',
    'numbering_sequences',
  ];

  private readonly deleteTables = [
    'return_dispositions', 'return_credits', 'return_requests',
    'tracking_events', 'delivery_outcomes', 'collections', 'shipments',
    'vehicles', 'shipping_companies',
    'pick_task_lines', 'pick_tasks', 'pack_tasks', 'fulfillment_orders',
    'warehouse_transaction_lines', 'warehouse_transactions',
    'stock_movements', 'stock_reservations',
    'sales_invoice_lines', 'sales_invoices',
    'customer_ledger_entries', 'customer_payments',
    'treasury_transactions',
    'deposits',
    'sales_order_lines', 'sales_orders',
    'customer_assignments', 'customers',
    'bom_components', 'bill_of_materials',
    'price_list_items', // items only — price_lists themselves survive
    'media_assets',
    'products',
    // warehouses handled separately below (excludes MAIN-WH by name)
  ];

  private readonly processEntityTypes = ['sales_order'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive guard: this migration must never even be ABLE to touch a
    // preserved table, regardless of anything above. Fails loudly before
    // doing anything if the two lists ever overlap (a future edit mistake).
    const overlap = this.deleteTables.filter((t) => this.preservedTables.includes(t));
    if (overlap.length > 0) {
      throw new Error(`ZeroBaselineCleanup: table(s) [${overlap.join(', ')}] appear in both the preserved and delete lists — refusing to run.`);
    }

    // Step 1: capture which process_instances are in scope BEFORE their
    // parent business rows (e.g. sales_orders) are deleted, since
    // entityId is a polymorphic text column with no real FK — once the
    // parent row is gone there is no way to re-derive which
    // process_instances belonged to it.
    await queryRunner.query(`
      CREATE TEMP TABLE zero_baseline_process_instance_ids AS
      SELECT pi.id FROM process_instances pi
      WHERE pi."entityType" = ANY($1::text[])
        AND (
          (pi."entityType" = 'sales_order' AND pi."entityId" IN (SELECT id::text FROM sales_orders))
        )
        -- extend with an OR branch per entityType if PROCESS_ENTITY_TYPES grows
    `, [this.processEntityTypes]);

    await queryRunner.query(`
      DELETE FROM process_transition_records
      WHERE "processInstanceId" IN (SELECT id FROM zero_baseline_process_instance_ids)
    `);
    await queryRunner.query(`
      DELETE FROM process_instances
      WHERE id IN (SELECT id FROM zero_baseline_process_instance_ids)
    `);

    // Step 2: discover every FK constraint (in either direction) touching
    // any table on the delete list, and make it deferrable for this
    // transaction only. Doing this generically (not a hardcoded
    // constraint-name list) avoids having to guess Postgres's
    // auto-generated constraint names, and automatically stays correct
    // if a future migration adds a new FK.
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
      [this.deleteTables],
    );

    for (const { table, constraint } of constraints) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER CONSTRAINT "${constraint}" DEFERRABLE INITIALLY DEFERRED`);
    }
    await queryRunner.query(`SET CONSTRAINTS ALL DEFERRED`);

    // Step 3: the actual deletes. Order no longer matters (constraints
    // deferred to commit) — kept in a readable dependency-ish order
    // anyway for a human reviewing this file, not because it's required.
    // Counts are taken via a SELECT immediately before each DELETE rather
    // than trusting the DELETE result's own shape — TypeORM's Postgres
    // query runner doesn't consistently return an affected-row count
    // across versions (that shape is a MySQL-driver convention, not
    // guaranteed here), so counting first is the reliable option.
    const deletionCounts: Record<string, number> = {};
    for (const table of this.deleteTables) {
      const [{ count }] = await queryRunner.query(`SELECT count(*)::int AS count FROM "${table}"`);
      deletionCounts[table] = count;
      await queryRunner.query(`DELETE FROM "${table}"`);
    }
    // warehouses: every row except MAIN-WH (or any other explicitly kept code)
    const [{ count: warehouseCount }] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM "warehouses" WHERE code <> 'MAIN-WH'`,
    );
    deletionCounts['warehouses (excl. MAIN-WH)'] = warehouseCount;
    await queryRunner.query(`DELETE FROM "warehouses" WHERE code <> 'MAIN-WH'`);

    // Step 4: re-check all deferred constraints NOW (a real violation
    // surfaces here and rolls the whole cleanup back), then restore every
    // constraint to its original (NOT DEFERRABLE) state. The IMMEDIATE is
    // also required before the ALTER — Postgres refuses
    // `ALTER TABLE ... ALTER CONSTRAINT` while a table still has pending
    // deferred trigger events (SQLSTATE 55006; caught by the UUID repair
    // scratch rehearsal, 2026-08-31, same generic technique).
    await queryRunner.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    for (const { table, constraint } of constraints) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER CONSTRAINT "${constraint}" NOT DEFERRABLE`);
    }

    // Step 5: log what actually happened, for the delivered report —
    // NOTICE goes to the migration-run console output, not a table (no
    // new permanent table added just for a log line).
    for (const [table, count] of Object.entries(deletionCounts)) {
      await queryRunner.query(`DO $$ BEGIN RAISE NOTICE 'ZeroBaselineCleanup: deleted % row(s) from %', ${count}, '${table}'; END $$;`);
    }
  }

  public async down(): Promise<void> {
    throw new Error(
      'ZeroBaselineCleanup has no automated rollback — deleted business data cannot be un-deleted by a ' +
      'migration. Restore from the pg_dump backup taken immediately before this migration ran (see ' +
      'DATA_REPAIR_RUNBOOK.md step 1), per ADR-020 §6\'s roll-forward-only philosophy.',
    );
  }
}
