import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-INV-04 (2026-10-19) - the document-level reference: which record justifies a warehouse document (the stock count behind a count-variance adjustment, the opening batch behind a correction,
 * the source document of an issue ...). Two NULLABLE columns plus an index; the existing free-text `reference` stays as a note, legacy documents keep NULLs and are never rewritten.
 * Purely additive, reversible, idempotent. Company databases receive it through the release-engine fan-out.
 */
export class AddWarehouseTransactionReference1790018300000 implements MigrationInterface {
  name = 'AddWarehouseTransactionReference1790018300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" ADD COLUMN IF NOT EXISTS "referenceType" VARCHAR(32)`);
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" ADD COLUMN IF NOT EXISTS "referenceId" UUID`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wh_txn_reference" ON "warehouse_transactions" ("referenceType", "referenceId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wh_txn_reference"`);
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" DROP COLUMN IF EXISTS "referenceId"`);
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" DROP COLUMN IF EXISTS "referenceType"`);
  }
}
