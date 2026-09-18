import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO directive — "يجب أن يكون لدينا أساس واضح لتسجيل أن المبلغ
 * مستحق/تم تحصيله/تم توريده" (due/collected/remitted). Existing
 * `collections` rows backfill to 'pending' (the column default) — their
 * true historical remittance state isn't reconstructable, same disclosed
 * limitation as the Sales Order `priceListPrice` backfill earlier this
 * session.
 */
export class AddCollectionRemittanceStatus1755848600000 implements MigrationInterface {
  name = 'AddCollectionRemittanceStatus1755848600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN "remittanceStatus" VARCHAR(16) NOT NULL DEFAULT 'pending'`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN "remittedAt" TIMESTAMPTZ`);
    await queryRunner.query(`ALTER TABLE "collections" ADD COLUMN "treasuryTransactionId" UUID`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN "treasuryTransactionId"`);
    await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN "remittedAt"`);
    await queryRunner.query(`ALTER TABLE "collections" DROP COLUMN "remittanceStatus"`);
  }
}
