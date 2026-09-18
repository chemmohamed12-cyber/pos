import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terminology Registry — Stage 2, UI vertical-slice work (CTO directive
 * §5). The original seed (1755841000000) only proved the registry
 * end-to-end with the blueprint's worked example (generic ALL_CAPS
 * codes). This migration adds the REAL vocabulary the operational UI
 * needs: every state/action from all four live Process Definitions
 * (Sales Order Approval, Fulfillment Task, Shipment Lifecycle, Return),
 * role labels, and common navigation/action chrome.
 *
 * Codes are namespaced `<process_key>.state.<state>` /
 * `<process_key>.action.<action>` — a bare code like "assigned" is used
 * by BOTH Fulfillment Task and Shipment Lifecycle, and the registry's
 * code column is globally unique, so namespacing is required to avoid a
 * real collision, not a style preference.
 *
 * Arabic wording: professional Egyptian business Arabic per ADR-011 —
 * independently authored for natural business usage, not a literal
 * word-for-word translation of the English column.
 */
export class SeedOperationalTerminology1755842500000 implements MigrationInterface {
  name = 'SeedOperationalTerminology1755842500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      // --- Sales Order Approval (sales_order_approval) ---
      ['sales_order_approval.state.draft', 'workflow_status', 'مسودة', 'Draft'],
      ['sales_order_approval.state.submitted', 'workflow_status', 'تم الإرسال', 'Submitted'],
      ['sales_order_approval.state.supervisor_review', 'workflow_status', 'مراجعة المشرف', 'Supervisor Review'],
      ['sales_order_approval.state.manager_approval', 'workflow_status', 'موافقة المدير', 'Manager Approval'],
      ['sales_order_approval.state.pending_resubmission', 'workflow_status', 'بانتظار إعادة الإرسال', 'Pending Resubmission'],
      ['sales_order_approval.state.deposit_verification', 'workflow_status', 'التحقق من العربون', 'Deposit Verification'],
      ['sales_order_approval.state.released', 'workflow_status', 'جاهز للتنفيذ', 'Released'],
      ['sales_order_approval.action.submit', 'workflow_action', 'إرسال للمراجعة', 'Submit for Review'],
      ['sales_order_approval.action.supervisor_approve', 'workflow_action', 'موافقة المشرف', 'Supervisor Approve'],
      ['sales_order_approval.action.supervisor_reject', 'workflow_action', 'رفض المشرف', 'Supervisor Reject'],
      ['sales_order_approval.action.resubmit', 'workflow_action', 'إعادة الإرسال', 'Resubmit'],
      ['sales_order_approval.action.manager_approve', 'workflow_action', 'موافقة المدير', 'Manager Approve'],
      ['sales_order_approval.action.manager_reject', 'workflow_action', 'رفض المدير', 'Manager Reject'],

      // --- Fulfillment Task (fulfillment_task) — shared by pick_task and pack_task ---
      ['fulfillment_task.state.assigned', 'workflow_status', 'تم الإسناد', 'Assigned'],
      ['fulfillment_task.state.accepted', 'workflow_status', 'تم القبول', 'Accepted'],
      ['fulfillment_task.state.in_progress', 'workflow_status', 'قيد التنفيذ', 'In Progress'],
      ['fulfillment_task.state.pending_verification', 'workflow_status', 'بانتظار التحقق', 'Pending Verification'],
      ['fulfillment_task.state.closed', 'workflow_status', 'مكتمل', 'Closed'],
      ['fulfillment_task.state.cancelled', 'workflow_status', 'ملغي', 'Cancelled'],
      ['fulfillment_task.action.accept', 'workflow_action', 'قبول المهمة', 'Accept'],
      ['fulfillment_task.action.start', 'workflow_action', 'بدء التنفيذ', 'Start'],
      ['fulfillment_task.action.complete', 'workflow_action', 'إنهاء التنفيذ', 'Complete'],
      ['fulfillment_task.action.verify', 'workflow_action', 'تأكيد المطابقة', 'Verify'],
      ['fulfillment_task.action.reject_verification', 'workflow_action', 'رفض المطابقة', 'Reject Verification'],
      ['fulfillment_task.action.cancel', 'workflow_action', 'إلغاء المهمة', 'Cancel'],
      ['fulfillment.pick_task', 'entity_label', 'مهمة التجهيز', 'Pick Task'],
      ['fulfillment.pack_task', 'entity_label', 'مهمة التعبئة', 'Pack Task'],
      ['fulfillment.order', 'entity_label', 'أمر التجهيز', 'Fulfillment Order'],

      // --- Shipment Lifecycle (shipment_lifecycle) ---
      ['shipment_lifecycle.state.created', 'workflow_status', 'تم الإنشاء', 'Created'],
      ['shipment_lifecycle.state.assigned', 'workflow_status', 'تم إسناد السائق', 'Driver Assigned'],
      ['shipment_lifecycle.state.picked_up', 'workflow_status', 'تم الاستلام من المخزن', 'Picked Up'],
      ['shipment_lifecycle.state.in_transit', 'workflow_status', 'في الطريق', 'In Transit'],
      ['shipment_lifecycle.state.out_for_delivery', 'workflow_status', 'خارج للتسليم', 'Out for Delivery'],
      ['shipment_lifecycle.state.delivered', 'workflow_status', 'تم التسليم', 'Delivered'],
      ['shipment_lifecycle.state.failed', 'workflow_status', 'فشل التسليم', 'Delivery Failed'],
      ['shipment_lifecycle.state.returned', 'workflow_status', 'تم الإرجاع للمرسل', 'Returned to Sender'],
      ['shipment_lifecycle.action.assign_driver', 'workflow_action', 'إسناد سائق', 'Assign Driver'],
      ['shipment_lifecycle.action.pickup', 'workflow_action', 'استلام الشحنة', 'Pick Up'],
      ['shipment_lifecycle.action.depart', 'workflow_action', 'مغادرة المخزن', 'Depart'],
      ['shipment_lifecycle.action.arrive_for_delivery', 'workflow_action', 'الوصول للتسليم', 'Arrive for Delivery'],
      ['shipment_lifecycle.action.deliver', 'workflow_action', 'تسليم', 'Deliver'],
      ['shipment_lifecycle.action.fail_delivery', 'workflow_action', 'تعذر التسليم', 'Fail Delivery'],
      ['shipment_lifecycle.action.retry', 'workflow_action', 'إعادة المحاولة', 'Retry'],
      ['shipment_lifecycle.action.return_to_sender', 'workflow_action', 'إرجاع للمرسل', 'Return to Sender'],

      // --- Return Process (return_request) ---
      ['return_request.state.requested', 'workflow_status', 'طلب مرتجع', 'Requested'],
      ['return_request.state.authorized', 'workflow_status', 'تم اعتماد المرتجع', 'Authorized'],
      ['return_request.state.rejected', 'workflow_status', 'مرفوض', 'Rejected'],
      ['return_request.state.received', 'workflow_status', 'تم الاستلام بالمخزن', 'Received at Warehouse'],
      ['return_request.state.inspected', 'workflow_status', 'تم الفحص', 'Inspected'],
      ['return_request.state.dispositioned', 'workflow_status', 'تم البت في المرتجع', 'Dispositioned'],
      ['return_request.action.authorize', 'workflow_action', 'اعتماد المرتجع', 'Authorize'],
      ['return_request.action.reject', 'workflow_action', 'رفض المرتجع', 'Reject'],
      ['return_request.action.receive_at_warehouse', 'workflow_action', 'استلام بالمخزن', 'Receive at Warehouse'],
      ['return_request.action.inspect', 'workflow_action', 'فحص', 'Inspect'],
      ['return_request.action.disposition', 'workflow_action', 'تسجيل القرار', 'Record Disposition'],
      ['disposition.restock', 'disposition_type', 'إعادة للمخزون', 'Restock'],
      ['disposition.damaged', 'disposition_type', 'تالف', 'Damaged'],
      ['disposition.repair', 'disposition_type', 'يحتاج صيانة', 'Needs Repair'],
      ['disposition.scrap', 'disposition_type', 'إتلاف', 'Scrap'],
      ['disposition.replacement', 'disposition_type', 'استبدال', 'Replacement'],

      // --- Deposit Control (plain status, not process-engine driven) ---
      ['deposit.status.submitted', 'workflow_status', 'تم إرسال العربون', 'Submitted'],
      ['deposit.status.approved', 'workflow_status', 'تم اعتماد العربون', 'Approved'],

      // --- Roles ---
      ['role.admin', 'role_label', 'مدير النظام', 'Administrator'],
      ['role.sales_rep', 'role_label', 'مندوب مبيعات', 'Sales Representative'],
      ['role.sales_supervisor', 'role_label', 'مشرف مبيعات', 'Sales Supervisor'],
      ['role.sales_manager', 'role_label', 'مدير مبيعات', 'Sales Manager'],
      ['role.warehouse_worker', 'role_label', 'عامل مخزن', 'Warehouse Worker'],
      ['role.driver', 'role_label', 'سائق التوصيل', 'Driver'],

      // --- Navigation ---
      ['nav.dashboard', 'nav', 'الرئيسية', 'Dashboard'],
      ['nav.customers', 'nav', 'العملاء', 'Customers'],
      ['nav.sales_orders', 'nav', 'أوامر البيع', 'Sales Orders'],
      ['nav.products', 'nav', 'المنتجات', 'Products'],
      ['nav.warehouses', 'nav', 'المخازن', 'Warehouses'],
      ['nav.inventory', 'nav', 'المخزون', 'Inventory'],
      ['nav.fulfillment', 'nav', 'التجهيز', 'Fulfillment'],
      ['nav.shipments', 'nav', 'الشحنات', 'Shipments'],
      ['nav.returns', 'nav', 'المرتجعات', 'Returns'],
      ['nav.deliveries', 'nav', 'التسليمات', 'Deliveries'],
      ['nav.admin', 'nav', 'إدارة النظام', 'Administration'],

      // --- Common actions / chrome ---
      ['action.login', 'action', 'تسجيل الدخول', 'Log In'],
      ['action.logout', 'action', 'تسجيل الخروج', 'Log Out'],
      ['action.create', 'action', 'إنشاء', 'Create'],
      ['action.save', 'action', 'حفظ', 'Save'],
      ['action.cancel', 'action', 'إلغاء', 'Cancel'],
      ['action.search', 'action', 'بحث', 'Search'],
      ['action.details', 'action', 'التفاصيل', 'Details'],
      ['action.back', 'action', 'رجوع', 'Back'],
      ['action.refresh', 'action', 'تحديث', 'Refresh'],
      ['field.status', 'field', 'الحالة', 'Status'],
      ['field.customer', 'field', 'العميل', 'Customer'],
      ['field.total_amount', 'field', 'الإجمالي', 'Total Amount'],
      ['field.order_number', 'field', 'رقم الطلب', 'Order Number'],
      ['field.created_at', 'field', 'تاريخ الإنشاء', 'Created At'],
      ['field.actions', 'field', 'الإجراءات', 'Actions'],
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
    await queryRunner.query(`
      DELETE FROM "terminology_entries" WHERE category IN
      ('workflow_status', 'workflow_action', 'entity_label', 'disposition_type', 'role_label', 'nav', 'action', 'field')
      AND code LIKE '%.%'
    `);
  }
}
