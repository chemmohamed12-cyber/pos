import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance follow-up to the pagination audit (MASTER_PROJECT_STATUS.md
 * §6). Every paginated list query (`listCustomersPage`, `listOrdersPage`,
 * `listTransactionsPage`, `listShipmentsPage`, `listLedgerPage`) sorts by
 * `ORDER BY "createdAt" DESC` on top of its `take`/`skip`. Every filter
 * column those same queries use already has an index (checked: customerId/
 * salesRepUserId/warehouseId on sales_orders, shippingCompanyId/vehicleId/
 * salesOrderId on shipments, accountId/customerId/salesOrderId on
 * treasury_transactions, warehouseId on warehouse_transactions) — but
 * `createdAt` itself never got one on any of these five tables. At today's
 * data volumes (dozens to low-hundreds of rows) Postgres just sorts in
 * memory and this is invisible; at real future scale a `LIMIT n OFFSET m`
 * page request would force a full-table sort on every single page. Purely
 * additive (new index only, no column/data change) — safe, reversible.
 *
 * ADR-025 / P6: this is a genuinely cross-cutting migration — its five
 * target tables span `sales` (`customers`, `sales_orders`), `logistics`
 * (`shipments`), `finance` (`treasury_transactions`) and `inventory`
 * (`warehouse_transactions`). It stays in `migrations/core/` (§8.2 —
 * cross-cutting migrations live in core) and each statement is guarded by
 * `to_regclass(...)`, so on an Edition that does not have one of those
 * modules the corresponding index is simply skipped, not an error, and
 * every table that IS present still gets its index. Finding F-P6-2.
 */
export class AddCreatedAtIndexesForPaginatedLists1755852100000 implements MigrationInterface {
  name = 'AddCreatedAtIndexesForPaginatedLists1755852100000';

  private static readonly INDEXES: [table: string, index: string][] = [
    ['customers', 'IDX_customers_createdAt'],
    ['sales_orders', 'IDX_sales_orders_createdAt'],
    ['shipments', 'IDX_shipments_createdAt'],
    ['treasury_transactions', 'IDX_treasury_transactions_createdAt'],
    ['warehouse_transactions', 'IDX_warehouse_transactions_createdAt'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, index] of AddCreatedAtIndexesForPaginatedLists1755852100000.INDEXES) {
      await queryRunner.query(
        `DO $$ BEGIN
           IF to_regclass('"${table}"') IS NOT NULL THEN
             EXECUTE 'CREATE INDEX IF NOT EXISTS "${index}" ON "${table}" ("createdAt")';
           END IF;
         END $$;`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [, index] of [...AddCreatedAtIndexesForPaginatedLists1755852100000.INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${index}"`);
    }
  }
}
