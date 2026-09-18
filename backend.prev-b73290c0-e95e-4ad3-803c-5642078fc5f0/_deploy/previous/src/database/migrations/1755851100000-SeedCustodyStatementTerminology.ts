import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("Printing Extensions") — the one print document type this backlog never had: a Custody Statement per Shipping Company / Company Vehicle. */
export class SeedCustodyStatementTerminology1755851100000 implements MigrationInterface {
  name = 'SeedCustodyStatementTerminology1755851100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // field.custodian / field.on_hand already exist (seeded by earlier
    // sessions) — reused as-is by the new print page, not reseeded here to
    // avoid clobbering their existing wording.
    const seed: Array<[string, string, string, string]> = [
      ['document.custody_statement_title', 'document', 'كشف عهدة', 'Custody Statement'],
    ];
    for (const [code, category, ar, en] of seed) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "terminology_entries" WHERE code = ANY($1)`,
      [['document.custody_statement_title']],
    );
  }
}
