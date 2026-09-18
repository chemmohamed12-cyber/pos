import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Master continuation directive (Company Vehicle Shipping §3) — a shipment
 * must "stay linked to the responsible sales rep throughout." The Sales
 * Order already tracks `salesRepUserId`, but a Shipment carried no
 * corresponding column — once goods moved from Sales Order into Shipping/
 * Custody, the responsible rep became unrecoverable without a manual join
 * back through `salesOrderId`. Snapshotted at creation, same rationale and
 * precedent as `salesOrderNumber` (migration 1755850700000). Reuses the
 * already-seeded `field.sales_rep` terminology code — no new terminology
 * needed.
 */
export class AddShipmentSalesRepTraceability1755851500000 implements MigrationInterface {
  name = 'AddShipmentSalesRepTraceability1755851500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "salesRepUserId" UUID`);
    await queryRunner.query(
      `UPDATE "shipments" s SET "salesRepUserId" = so."salesRepUserId" FROM "sales_orders" so WHERE so.id = s."salesOrderId" AND s."salesOrderId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "salesRepUserId"`);
  }
}
