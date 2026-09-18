import { MigrationInterface, QueryRunner } from 'typeorm';

/** Server-generated transaction numbers, never a frontend counter — same numbering_sequences seeding pattern as Warehouse's WH-IN/OUT/TR/ADJ/CNT. */
export class SeedTreasuryNumbering1755848300000 implements MigrationInterface {
  name = 'SeedTreasuryNumbering1755848300000';

  private static readonly SERIES: Array<[string, string]> = [
    ['treasury_cash_in', 'TRS-IN'],
    ['treasury_cash_out', 'TRS-OUT'],
    ['treasury_transfer', 'TRS-TRF'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [documentType, prefix] of SeedTreasuryNumbering1755848300000.SERIES) {
      await queryRunner.query(
        `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
        [documentType, prefix],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "numbering_sequences" WHERE "documentType" = ANY($1)`,
      [SeedTreasuryNumbering1755848300000.SERIES.map(([documentType]) => documentType)],
    );
  }
}
