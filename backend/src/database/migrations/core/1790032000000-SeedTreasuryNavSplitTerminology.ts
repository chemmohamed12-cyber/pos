import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Treasury Hotfix (2026-10-24) - the Treasury menu is split into Settings / Balances / Ledger. Data only: two NEW navigation labels, ON CONFLICT DO NOTHING (an
 * existing row is never rewritten); `down` removes exactly these rows. No schema change.
 */
export class SeedTreasuryNavSplitTerminology1790032000000 implements MigrationInterface {
  name = 'SeedTreasuryNavSplitTerminology1790032000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.treasury_settings', 'nav', 'إعدادات الخزينة', 'Treasury Settings'],
    ['nav.treasury_balances', 'nav', 'أرصدة حسابات الخزينة', 'Treasury Account Balances'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
