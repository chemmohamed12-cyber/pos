import { MigrationInterface, QueryRunner } from 'typeorm';

/** Treasury Payment Types (CTO directive) — Account Type hierarchy + wallet payment method terminology. */
export class SeedTreasuryAccountTypeTerminology1755848900000 implements MigrationInterface {
  name = 'SeedTreasuryAccountTypeTerminology1755848900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.treasury_account_types', 'nav', 'أنواع الحسابات', 'Account Types'],
      ['field.account_type_code', 'field', 'كود النوع', 'Type Code'],
      ['field.account_type_name', 'field', 'اسم النوع', 'Type Name'],
      ['action.create_account_type', 'action', 'إنشاء نوع حساب', 'Create Account Type'],
      ['method.wallet', 'method', 'محفظة', 'Wallet'],
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
    const codes = ['nav.treasury_account_types', 'field.account_type_code', 'field.account_type_name', 'action.create_account_type', 'method.wallet'];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
