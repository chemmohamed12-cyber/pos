import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A frozen per-shipment content snapshot — see `ShipmentLine` entity's
 * own doc comment for why this replaces the old "re-derive live from
 * StockReservation" read pattern. Additive only: no existing table is
 * touched. Real FK to `shipments`/`sales_order_lines` (the RBW finding
 * that `shipments.salesOrderId` itself has no DB FK is a separate,
 * still-open decision — see `SALES_ORDER_SHIPMENT_RETURNS_BLUEPRINT.md`
 * §B.18 item 2 — not something this migration silently fixes).
 */
export class CreateShipmentLines1755863100000 implements MigrationInterface {
  name = 'CreateShipmentLines1755863100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "shipment_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "shipmentId" UUID NOT NULL REFERENCES "shipments"("id") ON DELETE CASCADE,
        "salesOrderLineId" UUID NOT NULL REFERENCES "sales_order_lines"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
        "unitPrice" NUMERIC(12,2) NOT NULL CHECK ("unitPrice" >= 0),
        "lineTotal" NUMERIC(14,2) NOT NULL CHECK ("lineTotal" >= 0),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_lines_shipmentId" ON "shipment_lines" ("shipmentId")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_lines_salesOrderLineId" ON "shipment_lines" ("salesOrderLineId")`);
    await queryRunner.query(`CREATE INDEX "IDX_shipment_lines_productId" ON "shipment_lines" ("productId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "shipment_lines"`);
  }
}
