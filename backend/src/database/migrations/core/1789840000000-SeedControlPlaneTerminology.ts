import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Company Control Plane UI (2026-09-27, P1.3-P1.6, CTO-authorized).
 * XNEXUS Control Plane / Company Registry / Create Company / Company
 * Details-Lifecycle screens — the Frontend track's own UI strings, same
 * idempotent seed shape as every other terminology migration.
 */
export class SeedControlPlaneTerminology1789840000000 implements MigrationInterface {
  name = 'SeedControlPlaneTerminology1789840000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.control_plane', 'module', 'لوحة تحكم XNEXUS', 'XNEXUS Control Plane'],
    ['nav.company_registry', 'nav', 'سجل الشركات', 'Company Registry'],

    ['field.company_name', 'field', 'اسم الشركة', 'Company Name'],
    ['field.initial_admin', 'field', 'المسؤول الأولي', 'Initial Administrator'],
    ['field.database_status', 'field', 'حالة قاعدة البيانات', 'Database Status'],
    ['field.company_details', 'field', 'تفاصيل الشركة', 'Company Details'],

    ['action.create_company', 'action', 'إنشاء شركة', 'Create Company'],
    ['action.open_company', 'action', 'فتح', 'Open'],
    ['action.suspend_company', 'action', 'إيقاف الشركة', 'Suspend Company'],
    ['action.reactivate_company', 'action', 'إعادة تفعيل الشركة', 'Reactivate Company'],
    ['action.decommission_company', 'action', 'إخراج الشركة من الخدمة', 'Decommission Company'],

    ['panel.no_companies_yet', 'panel', 'لا توجد شركات بعد', 'No companies yet'],
    ['panel.confirm_suspend_company', 'panel', 'هل أنت متأكد من إيقاف هذه الشركة؟', 'Suspend this company?'],
    ['panel.confirm_reactivate_company', 'panel', 'هل أنت متأكد من إعادة تفعيل هذه الشركة؟', 'Reactivate this company?'],
    [
      'panel.confirm_decommission_company',
      'panel',
      'هل أنت متأكد من إخراج هذه الشركة من الخدمة نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.',
      'Decommission this company? This cannot be undone.',
    ],
    ['panel.company_provisioning_wait', 'panel', 'جارٍ تجهيز الشركة… قد يستغرق هذا بعض الوقت.', 'Provisioning company… this may take a moment.'],

    ['value.company_status.provisioning', 'value', 'قيد التجهيز', 'Provisioning'],
    ['value.company_status.ready', 'value', 'جاهزة', 'Ready'],
    ['value.company_status.degraded', 'value', 'متدهورة', 'Degraded'],
    ['value.company_status.suspended', 'value', 'موقوفة', 'Suspended'],
    ['value.company_status.migrating', 'value', 'قيد الترحيل', 'Migrating'],
    ['value.company_status.failed', 'value', 'فشل التجهيز', 'Failed'],
    ['value.company_status.decommissioned', 'value', 'خارج الخدمة', 'Decommissioned'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = this.rows.map(([code]) => code);
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
