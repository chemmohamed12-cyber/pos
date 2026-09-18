import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `procurement`-tagged (ADR-025). Purchase Order (no `status` column —
 * Process Engine owns state, same discipline as `shipments`) + Goods
 * Receipt, the one controlled bridge into Inventory (ADR-048 §"Decision").
 */
export class CreatePurchaseOrderAndGoodsReceiptTables1789700400000 implements MigrationInterface {
  name = 'CreatePurchaseOrderAndGoodsReceiptTables1789700400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "purchase_orders" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "poNumber" VARCHAR(32) NOT NULL,
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "warehouseId" UUID NOT NULL,
        "totalAmountBase" NUMERIC(18,2) NOT NULL DEFAULT 0,
        "notes" VARCHAR(500),
        "orgUnitId" UUID,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_purchase_orders_po_number" ON "purchase_orders" ("poNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_orders_supplier" ON "purchase_orders" ("supplierId")`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_orders_warehouse" ON "purchase_orders" ("warehouseId")`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_orders_org_unit" ON "purchase_orders" ("orgUnitId")`);

    await queryRunner.query(`
      CREATE TABLE "purchase_order_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "purchaseOrderId" UUID NOT NULL REFERENCES "purchase_orders"("id") ON DELETE CASCADE,
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantity" NUMERIC(18,3) NOT NULL,
        "unitCostBase" NUMERIC(18,4) NOT NULL,
        "lineTotalBase" NUMERIC(18,2) NOT NULL,
        "quantityReceived" NUMERIC(18,3) NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_order_lines_po" ON "purchase_order_lines" ("purchaseOrderId")`);
    await queryRunner.query(`CREATE INDEX "IDX_purchase_order_lines_product" ON "purchase_order_lines" ("productId")`);

    await queryRunner.query(`
      CREATE TABLE "goods_receipts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "grNumber" VARCHAR(32) NOT NULL,
        "purchaseOrderId" UUID NOT NULL REFERENCES "purchase_orders"("id"),
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "warehouseId" UUID NOT NULL,
        "notes" VARCHAR(500),
        "receivedByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_goods_receipts_gr_number" ON "goods_receipts" ("grNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_goods_receipts_po" ON "goods_receipts" ("purchaseOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "goods_receipt_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "goodsReceiptId" UUID NOT NULL REFERENCES "goods_receipts"("id") ON DELETE CASCADE,
        "purchaseOrderLineId" UUID NOT NULL REFERENCES "purchase_order_lines"("id"),
        "productId" UUID NOT NULL REFERENCES "products"("id"),
        "quantityReceived" NUMERIC(18,3) NOT NULL,
        "unitCostBase" NUMERIC(18,4) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_goods_receipt_lines_gr" ON "goods_receipt_lines" ("goodsReceiptId")`);
    await queryRunner.query(`CREATE INDEX "IDX_goods_receipt_lines_po_line" ON "goods_receipt_lines" ("purchaseOrderLineId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "goods_receipt_lines"`);
    await queryRunner.query(`DROP TABLE "goods_receipts"`);
    await queryRunner.query(`DROP TABLE "purchase_order_lines"`);
    await queryRunner.query(`DROP TABLE "purchase_orders"`);
  }
}
