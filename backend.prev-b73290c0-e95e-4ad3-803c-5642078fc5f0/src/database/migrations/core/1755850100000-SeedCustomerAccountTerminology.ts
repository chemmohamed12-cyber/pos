import { MigrationInterface, QueryRunner } from 'typeorm';

/** Customer Account Foundation (CTO directive). */
export class SeedCustomerAccountTerminology1755850100000 implements MigrationInterface {
  name = 'SeedCustomerAccountTerminology1755850100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['action.view_account', 'action', 'عرض الحساب', 'View Account'],
      ['field.customer_account', 'field', 'حساب العميل', 'Customer Account'],
      ['field.total_ordered', 'field', 'إجمالي الطلبات', 'Total Ordered'],
      ['field.total_deposited', 'field', 'إجمالي المقدم', 'Total Deposited'],
      ['field.total_collected', 'field', 'إجمالي التحصيل', 'Total Collected'],
      ['field.total_remitted', 'field', 'إجمالي التوريد', 'Total Remitted'],
      ['field.return_count', 'field', 'عدد المرتجعات', 'Returns'],
      ['field.date', 'field', 'التاريخ', 'Date'],
      ['field.description', 'field', 'البيان', 'Description'],
      ['field.deposit', 'field', 'دفعة مقدمة', 'Deposit'],
      ['field.collection', 'field', 'تحصيل', 'Collection'],
      ['panel.no_account_activity', 'panel', 'لا توجد حركات على هذا الحساب', 'No account activity yet'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [
      [
        'action.view_account',
        'field.customer_account',
        'field.total_ordered',
        'field.total_deposited',
        'field.total_collected',
        'field.total_remitted',
        'field.return_count',
        'field.date',
        'field.description',
        'field.deposit',
        'field.collection',
        'panel.no_account_activity',
      ],
    ]);
  }
}
