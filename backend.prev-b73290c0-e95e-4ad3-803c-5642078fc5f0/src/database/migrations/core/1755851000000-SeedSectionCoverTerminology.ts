import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("Section Cover / Main Dashboard System") — per-section KPI tile labels, reusing existing nav/field/panel codes wherever one already fits. */
export class SeedSectionCoverTerminology1755851000000 implements MigrationInterface {
  name = 'SeedSectionCoverTerminology1755851000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.total_custody_balance', 'field', 'إجمالي الأموال تحت العهدة', 'Total Custody Balance'],
      ['field.active_products', 'field', 'الأصناف النشطة', 'Active Products'],
      ['field.total_treasury_balance', 'field', 'إجمالي أرصدة الخزينة', 'Total Treasury Balance'],
      ['field.todays_transactions', 'field', 'حركات اليوم', "Today's Transactions"],
      ['field.total_users', 'field', 'إجمالي المستخدمين', 'Total Users'],
      ['field.active_integrations', 'field', 'التكاملات النشطة', 'Active Integrations'],
      ['field.top_accounts_by_balance', 'field', 'أعلى الحسابات رصيدًا', 'Top Accounts by Balance'],
      ['field.users_by_role', 'field', 'المستخدمون حسب الدور', 'Users by Role'],
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
      [[
        'field.total_custody_balance',
        'field.active_products',
        'field.total_treasury_balance',
        'field.todays_transactions',
        'field.total_users',
        'field.active_integrations',
        'field.top_accounts_by_balance',
        'field.users_by_role',
      ]],
    );
  }
}
