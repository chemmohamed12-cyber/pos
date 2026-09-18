import { MigrationInterface, QueryRunner } from 'typeorm';

/** The 'post' retry action's label — surfaces only when a prior posting attempt failed and left a transaction at 'approved'. */
export class SeedWarehouseTxnPostTerminology1755846900000 implements MigrationInterface {
  name = 'SeedWarehouseTxnPostTerminology1755846900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
      ['warehouse_txn_action.post', 'action', 'إعادة محاولة الترحيل', 'Retry Posting'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = 'warehouse_txn_action.post'`);
  }
}
