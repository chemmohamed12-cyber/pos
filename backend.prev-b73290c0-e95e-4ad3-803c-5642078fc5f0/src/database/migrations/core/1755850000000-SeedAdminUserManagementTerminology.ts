import { MigrationInterface, QueryRunner } from 'typeorm';

/** Admin user controls: revoke role, activate/deactivate, reset password. */
export class SeedAdminUserManagementTerminology1755850000000 implements MigrationInterface {
  name = 'SeedAdminUserManagementTerminology1755850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['action.revoke', 'action', 'إلغاء', 'Revoke'],
      ['action.reset_password', 'action', 'إعادة تعيين كلمة المرور', 'Reset Password'],
      ['action.activate', 'action', 'تفعيل', 'Activate'],
      ['action.deactivate', 'action', 'تعطيل', 'Deactivate'],
      ['field.current_roles', 'field', 'الأدوار الحالية', 'Current Roles'],
      ['field.new_password', 'field', 'كلمة المرور الجديدة', 'New Password'],
      ['status.pending', 'status', 'قيد الانتظار', 'Pending'],
      ['status.active', 'status', 'نشط', 'Active'],
      ['status.disabled', 'status', 'موقوف', 'Disabled'],
      ['status.suspended', 'status', 'معلّق', 'Suspended'],
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
        'action.revoke',
        'action.reset_password',
        'action.activate',
        'action.deactivate',
        'field.current_roles',
        'field.new_password',
        'status.pending',
        'status.active',
        'status.disabled',
        'status.suspended',
      ],
    ]);
  }
}
