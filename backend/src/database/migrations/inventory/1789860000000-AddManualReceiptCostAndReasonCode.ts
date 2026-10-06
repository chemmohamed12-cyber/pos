import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D3-B (2026-10-04, CTO-approved Manual Receipt policy). A manual receipt must carry an explicit unit cost and a
 * controlled reason code. Purely additive and nullable (legacy rows and every non-receipt document are unaffected):
 * `warehouse_transaction_lines."unitCostBase"` and `warehouse_transactions."reasonCode"`. The free-text `reason`
 * column stays as a human note; it never drives accounting.
 */
export class AddManualReceiptCostAndReasonCode1789860000000 implements MigrationInterface {
  name = 'AddManualReceiptCostAndReasonCode1789860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" ADD COLUMN "reasonCode" VARCHAR(64)`);
    await queryRunner.query(`ALTER TABLE "warehouse_transaction_lines" ADD COLUMN "unitCostBase" NUMERIC(18,4)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warehouse_transaction_lines" DROP COLUMN "unitCostBase"`);
    await queryRunner.query(`ALTER TABLE "warehouse_transactions" DROP COLUMN "reasonCode"`);
  }
}
