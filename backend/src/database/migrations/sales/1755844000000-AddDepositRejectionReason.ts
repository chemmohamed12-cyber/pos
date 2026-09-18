import { MigrationInterface, QueryRunner } from 'typeorm';

/** Deposit Reject/Resubmit workflow completion (CTO finalization directive §2). */
export class AddDepositRejectionReason1755844000000 implements MigrationInterface {
  name = 'AddDepositRejectionReason1755844000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deposits" ADD COLUMN "rejectionReason" VARCHAR(255)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deposits" DROP COLUMN "rejectionReason"`);
  }
}
