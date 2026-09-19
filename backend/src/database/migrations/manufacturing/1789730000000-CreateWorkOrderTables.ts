import { MigrationInterface, QueryRunner } from 'typeorm';

/** ADR-061 — Manufacturing Work Orders (§3/§18). New tables only; no existing table's schema changes. */
export class CreateWorkOrderTables1789730000000 implements MigrationInterface {
  name = 'CreateWorkOrderTables1789730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "work_orders" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderNumber" VARCHAR(64) NOT NULL,
        "finishedProductId" UUID NOT NULL,
        "quantityPlanned" INT NOT NULL,
        "quantityProduced" INT NOT NULL DEFAULT 0,
        "warehouseId" UUID NOT NULL,
        "wipWarehouseId" UUID,
        "createdByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_work_orders_quantity_planned_positive" CHECK ("quantityPlanned" > 0),
        CONSTRAINT "CHK_work_orders_quantity_produced_bounds" CHECK ("quantityProduced" >= 0 AND "quantityProduced" <= "quantityPlanned")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_work_orders_number" ON "work_orders" ("workOrderNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_work_orders_finished_product" ON "work_orders" ("finishedProductId")`);
    await queryRunner.query(`CREATE INDEX "IDX_work_orders_warehouse" ON "work_orders" ("warehouseId")`);

    await queryRunner.query(`
      CREATE TABLE "work_order_components" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "workOrderId" UUID NOT NULL,
        "componentProductId" UUID NOT NULL,
        "quantityRequired" INT NOT NULL,
        "quantityIssued" INT NOT NULL DEFAULT 0,
        "unitCostAtRelease" NUMERIC(20,4),
        CONSTRAINT "CHK_work_order_components_quantity_required_positive" CHECK ("quantityRequired" > 0),
        CONSTRAINT "CHK_work_order_components_quantity_issued_bounds" CHECK ("quantityIssued" >= 0 AND "quantityIssued" <= "quantityRequired")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_work_order_components_wo_product" ON "work_order_components" ("workOrderId", "componentProductId")`);
    await queryRunner.query(`CREATE INDEX "IDX_work_order_components_wo" ON "work_order_components" ("workOrderId")`);

    // ADR-061 §16 — NumberingService document type for WorkOrder.workOrderNumber, the same
    // precedent `assembly`/`ASM` used (1755845900000-CreateBomTables.ts).
    await queryRunner.query(`
      INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear", "lastNumber", "lastYear")
      VALUES ('work_order', 'WO', true, 0, NULL)
      ON CONFLICT ("documentType") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'work_order'`);
    await queryRunner.query(`DROP TABLE "work_order_components"`);
    await queryRunner.query(`DROP TABLE "work_orders"`);
  }
}
