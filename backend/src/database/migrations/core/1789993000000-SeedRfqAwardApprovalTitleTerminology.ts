import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Browser verification of D6 (2026-10-06) — the Approvals screen showed the raw key `action.award_rfq` as the title of an RFQ award
 * request: `RfqService` registers that title code but no terminology row existed. Same idempotent seed shape as every other
 * terminology migration. (Six other request types in other modules have the same gap — reported, not changed here.)
 */
export class SeedRfqAwardApprovalTitleTerminology1789993000000 implements MigrationInterface {
  name = 'SeedRfqAwardApprovalTitleTerminology1789993000000';

  private readonly rows: Array<[string, string, string, string]> = [['action.award_rfq', 'action', 'اعتماد ترسية طلب عرض أسعار', 'Approve RFQ award']];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
