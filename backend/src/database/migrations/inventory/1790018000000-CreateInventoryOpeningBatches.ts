import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory lifecycle, slice C4 (ADR-INV-01, CTO authorisation 2026-10-18) - the Opening Balance Batch: a dated, approved, locked document that is the only
 * governed way for opening stock to enter. Two additive tables (Company databases, `inventory` tag) and one Numbering series (`inventory_opening_batch`, prefix OB).
 *  - No status column: the lifecycle lives in the Process Engine (`inventory_opening_batch`), like every other document.
 *  - `kind`: `opening` | `reversal` (exceptional correction of an untouched opening) | `correction` (approved correction AFTER stock has moved, O-1: equity-side account).
 *  - The partial unique index `UQ_inv_opening_line_active_pair` is the database-level guarantee that a (warehouse, product) pair can hold only ONE active opening line.
 * Purely additive; `down` removes exactly what `up` created. Company databases receive it only through the release-engine fan-out.
 */
export class CreateInventoryOpeningBatches1790018000000 implements MigrationInterface {
  name = 'CreateInventoryOpeningBatches1790018000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_opening_batches" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "batchNumber" VARCHAR(32) NOT NULL,
        "kind" VARCHAR(16) NOT NULL,
        "warehouseId" UUID NOT NULL,
        "cutOffDate" DATE NOT NULL,
        "declaredLineCount" INT,
        "declaredTotalQuantity" INT,
        "declaredTotalValueBase" NUMERIC(20,4),
        "computedTotalValueBase" NUMERIC(20,4),
        "reversalOfBatchId" UUID,
        "reason" TEXT,
        "allowExistingActivity" BOOLEAN NOT NULL DEFAULT false,
        "overrideReason" TEXT,
        "approvalRequestId" UUID,
        "createdByUserId" UUID NOT NULL,
        "submittedAt" TIMESTAMPTZ,
        "postedAt" TIMESTAMPTZ,
        "notes" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_inv_opening_batch_kind" CHECK ("kind" IN ('opening','reversal','correction'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_inv_opening_batch_number" ON "inventory_opening_batches" ("batchNumber")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inv_opening_batch_warehouseId" ON "inventory_opening_batches" ("warehouseId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inv_opening_batch_reversalOf" ON "inventory_opening_batches" ("reversalOfBatchId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_opening_batch_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "batchId" UUID NOT NULL,
        "warehouseId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "quantity" INT NOT NULL,
        "unitCostBase" NUMERIC(20,4),
        "lineValueBase" NUMERIC(20,4) NOT NULL,
        "stockMovementId" UUID,
        "isActive" BOOLEAN NOT NULL DEFAULT false,
        CONSTRAINT "FK_inv_opening_line_batch" FOREIGN KEY ("batchId") REFERENCES "inventory_opening_batches" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_inv_opening_line_quantity" CHECK ("quantity" <> 0),
        CONSTRAINT "CHK_inv_opening_line_cost" CHECK ("unitCostBase" IS NULL OR "unitCostBase" > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_inv_opening_line_batchId" ON "inventory_opening_batch_lines" ("batchId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_inv_opening_line_active_pair" ON "inventory_opening_batch_lines" ("warehouseId", "productId") WHERE "isActive"`,
    );

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear", "lastNumber", "lastYear") VALUES ('inventory_opening_batch', 'OB', true, 0, NULL) ON CONFLICT ("documentType") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'inventory_opening_batch'`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_opening_batch_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_opening_batches"`);
  }
}
