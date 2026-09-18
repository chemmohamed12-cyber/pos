import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terminology Registry — Stage 2 build-order item 16. Seeds the exact
 * worked example from Daii_Platform_Architecture_Blueprint_V1.md §36,
 * plus its immediate neighbors in the same status vocabulary — proves
 * the registry end-to-end without prematurely designing every domain's
 * full vocabulary (that's each domain's job as it's built, Phase B).
 */
export class CreateTerminologyEntries1755841000000 implements MigrationInterface {
  name = 'CreateTerminologyEntries1755841000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "terminology_entries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(128) NOT NULL,
        "category" VARCHAR(64) NOT NULL,
        "ar" VARCHAR(255) NOT NULL,
        "en" VARCHAR(255) NOT NULL,
        "version" INT NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_terminology_entries_code" ON "terminology_entries" ("code")`);

    const seed: Array<[string, string, string, string]> = [
      ['PENDING_REVIEW', 'workflow_status', 'بانتظار المراجعة', 'Pending Review'],
      ['SUBMITTED', 'workflow_status', 'تم الإرسال', 'Submitted'],
      ['APPROVED', 'workflow_status', 'تمت الموافقة', 'Approved'],
      ['REJECTED', 'workflow_status', 'مرفوض', 'Rejected'],
      ['PENDING_RESUBMISSION', 'workflow_status', 'بانتظار إعادة الإرسال', 'Pending Resubmission'],
    ];
    for (const [code, category, ar, en] of seed) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4)`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "terminology_entries"`);
  }
}
