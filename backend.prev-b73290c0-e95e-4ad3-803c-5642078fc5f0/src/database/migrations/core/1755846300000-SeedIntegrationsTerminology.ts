import { MigrationInterface, QueryRunner } from 'typeorm';

/** External Integrations (Control Center) — CTO handover directive "Daii <-> QR Store Integration". */
export class SeedIntegrationsTerminology1755846300000 implements MigrationInterface {
  name = 'SeedIntegrationsTerminology1755846300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.integrations', 'nav', 'التكاملات الخارجية', 'External Integrations'],
      ['field.connector_type', 'field', 'نوع التكامل', 'Connector Type'],
      ['field.api_url', 'field', 'رابط الواجهة البرمجية', 'API URL'],
      ['field.system_user', 'field', 'مستخدم النظام', 'System User'],
      ['field.pairing_token', 'field', 'رمز الإقران', 'Pairing Token'],
      ['field.external_id', 'field', 'المعرف الخارجي', 'External ID'],
      ['connector_status.pending', 'workflow_status', 'بانتظار الإقران', 'Pending'],
      ['connector_status.connected', 'workflow_status', 'متصل', 'Connected'],
      ['connector_status.error', 'workflow_status', 'خطأ في الاتصال', 'Error'],
      ['connector_status.disconnected', 'workflow_status', 'غير متصل', 'Disconnected'],
      ['action.pair', 'action', 'إقران', 'Pair'],
      ['action.test_connection', 'action', 'اختبار الاتصال', 'Test Connection'],
      ['action.disconnect', 'action', 'قطع الاتصال', 'Disconnect'],
      ['action.publish_products', 'action', 'نشر المنتجات', 'Publish Products'],
      ['action.publish_availability', 'action', 'نشر التوافر', 'Publish Availability'],
      ['action.view_logs', 'action', 'عرض السجل', 'View Log'],
      ['action.view_mappings', 'action', 'عرض الربط', 'View Mappings'],
      ['panel.no_connectors_yet', 'panel', 'لا توجد تكاملات بعد', 'No integrations yet.'],
      ['panel.no_mappings_yet', 'panel', 'لا يوجد ربط منتجات بعد', 'No product mappings yet.'],
      ['panel.no_logs_yet', 'panel', 'لا يوجد سجل بعد', 'No sync log yet.'],
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
      'nav.integrations', 'field.connector_type', 'field.api_url', 'field.system_user', 'field.pairing_token',
      'field.external_id', 'connector_status.pending', 'connector_status.connected', 'connector_status.error',
      'connector_status.disconnected', 'action.pair', 'action.test_connection', 'action.disconnect',
      'action.publish_products', 'action.publish_availability', 'action.view_logs', 'action.view_mappings',
      'panel.no_connectors_yet', 'panel.no_mappings_yet', 'panel.no_logs_yet',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
