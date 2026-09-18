import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * Two brand-new, additive aggregates — `shipment_returns`/
 * `shipment_return_lines` and `sales_returns`/`sales_return_lines`.
 * `return_requests` and its dependents are NOT touched by this
 * migration (CTO ratification: leave ReturnRequest completely
 * untouched — no rename, no repurpose, no shared table).
 */
export class CreateShipmentAndSalesReturns1755863200000 implements MigrationInterface {
  name = 'CreateShipmentAndSalesReturns1755863200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "shipment_returns" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "returnNumber" VARCHAR(32) NOT NULL,
        "shipmentId" UUID NOT NULL REFERENCES "shipments"("id"),
        "customerId" UUID NOT NULL REFERENCES "customers"("id"),
        "salesOrderId" UUID NOT NULL REFERENCES "sales_orders"("id"),
        "returnMode" VARCHAR(8) NOT NULL CHECK ("returnMode" IN ('full', 'partial')),
        "reason" VARCHAR(255),
        "requestedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_shipment_returns_returnNumber" ON "shipment_returns" ("returnNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_returns_shipmentId" ON "shipment_returns" ("shipmentId")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_returns_customerId" ON "shipment_returns" ("customerId")`);

    await queryRunner.query(`
      CREATE TABLE "shipment_return_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "shipmentReturnId" UUID NOT NULL REFERENCES "shipment_returns"("id") ON DELETE CASCADE,
        "shipmentLineId" UUID NOT NULL REFERENCES "shipment_lines"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "returnQuantity" INTEGER NOT NULL CHECK ("returnQuantity" > 0),
        "returnPrice" NUMERIC(12,2) NOT NULL CHECK ("returnPrice" >= 0),
        "lineTotal" NUMERIC(14,2) NOT NULL CHECK ("lineTotal" >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_return_lines_shipmentReturnId" ON "shipment_return_lines" ("shipmentReturnId")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_return_lines_shipmentLineId" ON "shipment_return_lines" ("shipmentLineId")`);

    await queryRunner.query(`
      CREATE TABLE "sales_returns" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "returnNumber" VARCHAR(32) NOT NULL,
        "customerId" UUID NOT NULL REFERENCES "customers"("id"),
        "salesOrderId" UUID REFERENCES "sales_orders"("id"),
        "returnDate" TIMESTAMPTZ NOT NULL,
        "totalAmount" NUMERIC(14,2) NOT NULL CHECK ("totalAmount" >= 0),
        "reason" VARCHAR(255),
        "requestedByUserId" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_sales_returns_returnNumber" ON "sales_returns" ("returnNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_returns_customerId" ON "sales_returns" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_returns_salesOrderId" ON "sales_returns" ("salesOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "sales_return_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "salesReturnId" UUID NOT NULL REFERENCES "sales_returns"("id") ON DELETE CASCADE,
        "sourceSalesOrderId" UUID NOT NULL REFERENCES "sales_orders"("id"),
        "sourceSalesOrderLineId" UUID NOT NULL REFERENCES "sales_order_lines"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "returnQuantity" INTEGER NOT NULL CHECK ("returnQuantity" > 0),
        "originalUnitPrice" NUMERIC(12,2) NOT NULL CHECK ("originalUnitPrice" >= 0),
        "returnPrice" NUMERIC(12,2) NOT NULL CHECK ("returnPrice" >= 0),
        "lineTotal" NUMERIC(14,2) NOT NULL CHECK ("lineTotal" >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_sales_return_lines_salesReturnId" ON "sales_return_lines" ("salesReturnId")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_return_lines_sourceSalesOrderLineId" ON "sales_return_lines" ("sourceSalesOrderLineId")`);

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('shipment_return', 'SRT', true), ('sales_return', 'SLR', true)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" IN ('shipment_return', 'sales_return')`);
    await queryRunner.query(`DROP TABLE "sales_return_lines"`);
    await queryRunner.query(`DROP TABLE "sales_returns"`);
    await queryRunner.query(`DROP TABLE "shipment_return_lines"`);
    await queryRunner.query(`DROP TABLE "shipment_returns"`);
  }
}
