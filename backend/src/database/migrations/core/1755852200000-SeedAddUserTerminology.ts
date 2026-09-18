import { MigrationInterface, QueryRunner } from 'typeorm';

/** "Add New User" panel on the Admin screen (شاشة الاسناد) — reuses field.name/field.email/action.create, adds the two codes it doesn't already have. */
export class SeedAddUserTerminology1755852200000 implements MigrationInterface {
  name = 'SeedAddUserTerminology1755852200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['panel.add_new_user', 'panel', 'إضافة مستخدم جديد', 'Add New User'],
      ['field.password', 'field', 'كلمة المرور', 'Password'],
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
      ['panel.add_new_user', 'field.password'],
    ]);
  }
}
