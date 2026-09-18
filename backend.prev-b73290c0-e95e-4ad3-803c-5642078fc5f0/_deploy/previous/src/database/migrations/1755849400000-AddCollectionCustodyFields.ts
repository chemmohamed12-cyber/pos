import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive ("SHIPPING & CUSTODY MANAGEMENT" §6/§7) — the two-leg
 * custody flow: collection posts into custody immediately, remittance
 * later transfers out of custody into settlement.
 */
export class AddCollectionCustodyFields1755849400000 implements MigrationInterface {
  name = 'AddCollectionCustodyFields1755849400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN "custodyAccountId" UUID`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN "custodyTransactionId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN "custodyTransactionId"`);
    await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN "custodyAccountId"`);
  }
}
