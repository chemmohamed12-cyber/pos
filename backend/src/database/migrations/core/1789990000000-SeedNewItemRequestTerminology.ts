import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D7 (2026-10-05, CTO: Draft Product = New Item Request, approval by one `sales.catalog.edit` holder, gate at Purchase Request
 * approval) — Purchase Requests screen + the Approvals screen's request-type title. Same idempotent seed shape as every other
 * terminology migration. (field.unit / field.reason already exist and are reused as-is.)
 */
export class SeedNewItemRequestTerminology1789990000000 implements MigrationInterface {
  name = 'SeedNewItemRequestTerminology1789990000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['action.new_item_request', 'action', 'طلب صنف جديد', 'New item request'],
    ['action.request_new_item', 'action', 'طلب صنف جديد', 'Request a new item'],
    ['panel.new_item_request_hint', 'panel', 'الصنف غير الموجود في دليل الأصناف يُطلب هنا: يُنشأ كمسوّدة ولا يمكن اعتماد طلب الشراء المرتبط به قبل اعتماد الصنف (من شاشة الموافقات، بواسطة مستخدم يملك صلاحية تعديل الكتالوج).', 'An item missing from the catalog is requested here: it is created as a draft, and a Purchase Request that uses it cannot be approved until the item is approved (on the Approvals screen, by a user holding catalog-edit authority).'],
    ['panel.new_item_request_submitted', 'panel', 'تم إرسال الطلب للاعتماد — كود الصنف المؤقت:', 'Request submitted for approval — item code:'],
    ['panel.item_pending_approval', 'panel', 'بانتظار اعتماد الصنف', 'Item pending approval'],
    ['field.item_name', 'field', 'اسم الصنف', 'Item name'],
    ['field.item_request_status', 'field', 'حالة الطلب', 'Request status'],
    ['value.item_request_status.pending', 'value', 'بانتظار الاعتماد', 'Pending approval'],
    ['value.item_request_status.approved', 'value', 'معتمد', 'Approved'],
    ['value.item_request_status.rejected', 'value', 'مرفوض', 'Rejected'],
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
