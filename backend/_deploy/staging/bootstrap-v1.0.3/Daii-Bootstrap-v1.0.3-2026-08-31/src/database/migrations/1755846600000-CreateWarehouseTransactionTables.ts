import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive) — the header +
 * line tables backing multi-line Receipt/Issue/Transfer/Adjustment/Count
 * documents (§9), plus their Numbering series (§12: WH-IN/WH-OUT/WH-TR/
 * WH-ADJ/WH-CNT). No status column on the header — lifecycle lives in
 * the existing `process_instances` table via `ProcessEngineService`
 * (directive §11, same pattern as Sales Orders/Shipments).
 */
export class CreateWarehouseTransactionTables1755846600000 implements MigrationInterface {
  name = 'CreateWarehouseTransactionTables1755846600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "warehouse_transactions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "transactionNumber" VARCHAR(32) NOT NULL,
        "type" VARCHAR(16) NOT NULL,
        "warehouseId" UUID NOT NULL,
        "destinationWarehouseId" UUID,
        "reference" VARCHAR(255),
        "reason" VARCHAR(255),
        "notes" TEXT,
        "reversalOfTransactionId" UUID,
        "createdByUserId" UUID NOT NULL,
        "approvedByUserId" UUID,
        "postedByUserId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_wh_txn_number" ON "warehouse_transactions" ("transactionNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_wh_txn_warehouseId" ON "warehouse_transactions" ("warehouseId")`);
    await queryRunner.query(`CREATE INDEX "IDX_wh_txn_reversalOf" ON "warehouse_transactions" ("reversalOfTransactionId")`);

    await queryRunner.query(`
      CREATE TABLE "warehouse_transaction_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "warehouseTransactionId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "quantity" INT NOT NULL,
        "systemQuantity" INT,
        "physicalQuantity" INT,
        "notes" VARCHAR(255)
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_wh_txn_line_txnId" ON "warehouse_transaction_lines" ("warehouseTransactionId")`);

    const series: Array<[string, string]> = [
      ['warehouse_receipt', 'WH-IN'],
      ['warehouse_issue', 'WH-OUT'],
      ['warehouse_transfer', 'WH-TR'],
      ['warehouse_adjustment', 'WH-ADJ'],
      ['warehouse_count', 'WH-CNT'],
    ];
    for (const [documentType, prefix] of series) {
      await queryRunner.query(
        `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ($1, $2, true)`,
        [documentType, prefix],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "numbering_sequences" WHERE "documentType" = ANY($1)`,
      [['warehouse_receipt', 'warehouse_issue', 'warehouse_transfer', 'warehouse_adjustment', 'warehouse_count']],
    );
    await queryRunner.query(`DROP TABLE "warehouse_transaction_lines"`);
    await queryRunner.query(`DROP TABLE "warehouse_transactions"`);
  }
}
