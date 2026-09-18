import { MigrationInterface, QueryRunner } from 'typeorm';

/** `procurement`-tagged (ADR-025). Path B (Purchase Request / RFQ / Supplier Quotation) UI/API strings. */
export class SeedPurchaseRequestRfqTerminology1789701000000 implements MigrationInterface {
  name = 'SeedPurchaseRequestRfqTerminology1789701000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.purchase_requests', 'field', 'طلبات الشراء', 'Purchase Requests'],
    ['nav.rfqs', 'field', 'طلبات عروض الأسعار', 'RFQs'],

    ['field.pr_number', 'field', 'رقم طلب الشراء', 'PR Number'],
    ['field.rfq_number', 'field', 'رقم طلب عرض السعر', 'RFQ Number'],
    ['field.quotation_number', 'field', 'رقم عرض السعر', 'Quotation Number'],
    ['field.needed_by_date', 'field', 'مطلوب بحلول', 'Needed By'],
    ['field.invited_suppliers', 'field', 'الموردون المدعوون', 'Invited Suppliers'],
    ['field.quotations', 'field', 'عروض الأسعار', 'Quotations'],
    ['field.total_quotation_amount', 'field', 'إجمالي عرض السعر', 'Quotation Total'],

    ['action.create_purchase_request', 'field', 'إنشاء طلب شراء', 'Create Purchase Request'],
    ['action.add_pr_line', 'field', 'إضافة بند', 'Add Line'],
    ['action.create_rfq', 'field', 'إنشاء طلب عرض سعر', 'Create RFQ'],
    ['action.send_rfq', 'field', 'إرسال طلب عرض السعر', 'Send RFQ'],
    ['action.record_quotation', 'field', 'تسجيل عرض سعر', 'Record Quotation'],
    ['action.award', 'field', 'ترسية', 'Award'],

    ['purchase_request_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['purchase_request_lifecycle.state.submitted', 'field', 'بانتظار الاعتماد', 'Submitted'],
    ['purchase_request_lifecycle.state.approved', 'field', 'معتمد', 'Approved'],
    ['purchase_request_lifecycle.state.rejected', 'field', 'مرفوض', 'Rejected'],
    ['purchase_request_lifecycle.state.cancelled', 'field', 'ملغى', 'Cancelled'],
    ['purchase_request_lifecycle.state.converted_to_rfq', 'field', 'تم التحويل لطلب عرض سعر', 'Converted to RFQ'],

    ['rfq_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['rfq_lifecycle.state.sent', 'field', 'تم الإرسال', 'Sent'],
    ['rfq_lifecycle.state.awarded', 'field', 'تمت الترسية', 'Awarded'],
    ['rfq_lifecycle.state.cancelled', 'field', 'ملغى', 'Cancelled'],

    ['panel.no_purchase_requests_yet', 'panel', 'لا توجد طلبات شراء بعد', 'No purchase requests yet'],
    ['panel.no_rfqs_yet', 'panel', 'لا توجد طلبات عروض أسعار بعد', 'No RFQs yet'],
    ['panel.no_quotations_yet', 'panel', 'لا توجد عروض أسعار بعد', 'No quotations yet'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = this.rows.map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`).join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const codes = this.rows.map(([code]) => `'${code}'`).join(', ');
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code IN (${codes})`);
  }
}
