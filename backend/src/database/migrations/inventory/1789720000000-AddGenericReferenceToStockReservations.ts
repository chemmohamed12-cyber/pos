import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-061 (Manufacturing) — CTO-ratified Option A resolution of the
 * `stock_reservations` gap found during ADR-061 implementation:
 * ADR-061 §5 describes Work Orders reserving components via a generic
 * `referenceType`/`referenceId` pair, but `stock_reservations` only ever
 * had a hardcoded `salesOrderId` column. This is a purely ADDITIVE
 * extension — `salesOrderId` and every existing Sales Order reservation
 * row/query/method is untouched; a Work Order reservation instead
 * populates the new `referenceType`/`referenceId` pair and leaves
 * `salesOrderId` NULL. No second reservation table/mechanism is created
 * (ADR-061's own explicit constraint).
 *
 * `salesOrderId` becomes nullable so a Work Order row need not carry a
 * fake Sales Order id. A CHECK constraint enforces that every row is
 * addressed EXACTLY one way (Sales Order XOR generic reference) — never
 * both, never neither.
 */
export class AddGenericReferenceToStockReservations1789720000000 implements MigrationInterface {
  name = 'AddGenericReferenceToStockReservations1789720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "stock_reservations"
        ALTER COLUMN "salesOrderId" DROP NOT NULL,
        ADD COLUMN "referenceType" VARCHAR(32),
        ADD COLUMN "referenceId" VARCHAR(255)
    `);

    await queryRunner.query(`
      ALTER TABLE "stock_reservations"
        ADD CONSTRAINT "CHK_stock_reservations_reference_xor" CHECK (
          ("salesOrderId" IS NOT NULL AND "referenceType" IS NULL AND "referenceId" IS NULL)
          OR
          ("salesOrderId" IS NULL AND "referenceType" IS NOT NULL AND "referenceId" IS NOT NULL)
        )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_stock_reservations_reference" ON "stock_reservations" ("referenceType", "referenceId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_stock_reservations_reference"`);
    await queryRunner.query(`ALTER TABLE "stock_reservations" DROP CONSTRAINT "CHK_stock_reservations_reference_xor"`);
    await queryRunner.query(`
      ALTER TABLE "stock_reservations"
        DROP COLUMN "referenceType",
        DROP COLUMN "referenceId"
    `);
    // Not restoring the NOT NULL on "salesOrderId" here — by the time a
    // down-migration runs, generic-reference rows may already exist and
    // would violate it; reverting that far is an operator decision, not
    // an automatic one.
  }
}
