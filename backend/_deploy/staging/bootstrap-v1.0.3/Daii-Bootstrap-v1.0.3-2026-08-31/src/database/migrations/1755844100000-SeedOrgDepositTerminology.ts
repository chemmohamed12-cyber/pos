import { MigrationInterface, QueryRunner } from 'typeorm';

/** Terminology for Organization UI + Deposit Reject/Resubmit (CTO finalization directive §2). */
export class SeedOrgDepositTerminology1755844100000 implements MigrationInterface {
  name = 'SeedOrgDepositTerminology1755844100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.organization', 'nav', 'الهيكل التنظيمي', 'Organization'],
      ['field.parent', 'field', 'الوحدة الأعلى', 'Parent'],
      ['unit_type.company', 'unit_type', 'شركة', 'Company'],
      ['unit_type.branch', 'unit_type', 'فرع', 'Branch'],
      ['unit_type.department', 'unit_type', 'إدارة', 'Department'],
      ['unit_type.team', 'unit_type', 'فريق', 'Team'],
      ['unit_type.warehouse', 'unit_type', 'مخزن', 'Warehouse'],
      ['panel.no_org_units_yet', 'panel', 'لا توجد وحدات تنظيمية بعد', 'No organization units yet.'],
      ['panel.members', 'panel', 'الأعضاء', 'Members'],
      ['deposit.status.rejected', 'workflow_status', 'مرفوض', 'Rejected'],
      ['action.reject_deposit', 'action', 'رفض العربون', 'Reject Deposit'],
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
    const codes = [
      'nav.organization', 'field.parent', 'unit_type.company', 'unit_type.branch', 'unit_type.department',
      'unit_type.team', 'unit_type.warehouse', 'panel.no_org_units_yet', 'panel.members',
      'deposit.status.rejected', 'action.reject_deposit',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
