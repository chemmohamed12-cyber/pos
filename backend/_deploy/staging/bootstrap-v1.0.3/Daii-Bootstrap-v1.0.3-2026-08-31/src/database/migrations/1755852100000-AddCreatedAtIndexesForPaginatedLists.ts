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
 */
export class AddCreatedAtIndexesForPaginatedLists1755852100000 implements MigrationInterface {
  name = 'AddCreatedAtIndexesForPaginatedLists1755852100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_customers_createdAt" ON "customers" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_orders_createdAt" ON "sales_orders" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipments_createdAt" ON "shipments" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_treasury_transactions_createdAt" ON "treasury_transactions" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_warehouse_transactions_createdAt" ON "warehouse_transactions" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_warehouse_transactions_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_treasury_transactions_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_shipments_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_sales_orders_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_customers_createdAt"`);
  }
}
