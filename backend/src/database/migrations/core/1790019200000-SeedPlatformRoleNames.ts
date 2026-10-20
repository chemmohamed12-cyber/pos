import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CTO decision 2026-10-20 (ROLE KEY LOCALIZATION, option 1) — display names for four platform roles that the page header, the dashboard greeting and the
 * admin overview showed as raw keys (`role.platform_super_admin` …). The names are the CTO-approved ones already defined in code
 * (`foundation/platform/platform-nodes.ts`, PLATFORM_ROLES, 2026-10-07); nothing is invented. Data only — no role, permission, membership or authorization change.
 *
 * Safe to rerun: the insert never rewrites an existing row (ON CONFLICT DO NOTHING), so a customised translation survives. `down` removes only the rows that
 * still hold exactly the seeded text, so a customised row is left alone too.
 */
export class SeedPlatformRoleNames1790019200000 implements MigrationInterface {
  name = 'SeedPlatformRoleNames1790019200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['role.platform_super_admin', 'role_label', 'مدير المنصة الأعلى', 'Platform Super Admin'],
    ['role.company_manager', 'role_label', 'مدير الشركات', 'Company Manager'],
    ['role.support_operations', 'role_label', 'الدعم والتشغيل', 'Support / Operations'],
    ['role.platform_audit_readonly', 'role_label', 'التدقيق / للقراءة فقط', 'Audit / Read-only'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [code, , ar, en] of this.rows) {
      await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = $1 AND ar = $2 AND en = $3`, [code, ar, en]);
    }
  }
}
