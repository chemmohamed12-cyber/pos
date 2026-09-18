import { MigrationInterface, QueryRunner } from 'typeorm';

/** Warehouse & Inventory Control UX/UI V1 (CTO directive) — terminology for the new transaction lifecycle/types. */
export class SeedWarehouseTransactionTerminology1755846700000 implements MigrationInterface {
  name = 'SeedWarehouseTransactionTerminology1755846700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav.movement_center', 'nav', 'حركات المخزون', 'Inventory Movements'],
      ['nav.stock_count', 'nav', 'الجرد', 'Stock Count'],
      ['nav.warehouse_overview', 'nav', 'نظرة عامة', 'Overview'],

      ['warehouse_txn_type.receipt', 'warehouse_txn_type', 'إذن إضافة', 'Receipt'],
      ['warehouse_txn_type.issue', 'warehouse_txn_type', 'إذن صرف', 'Issue'],
      ['warehouse_txn_type.transfer', 'warehouse_txn_type', 'تحويل', 'Transfer'],
      ['warehouse_txn_type.adjustment', 'warehouse_txn_type', 'تسوية', 'Adjustment'],
      ['warehouse_txn_type.count', 'warehouse_txn_type', 'جرد', 'Count'],

      ['warehouse_txn_state.draft', 'workflow_status', 'مسودة', 'Draft'],
      ['warehouse_txn_state.submitted', 'workflow_status', 'بانتظار الاعتماد', 'Submitted'],
      ['warehouse_txn_state.approved', 'workflow_status', 'معتمد', 'Approved'],
      ['warehouse_txn_state.posted', 'workflow_status', 'مرحّل', 'Posted'],
      ['warehouse_txn_state.reversed', 'workflow_status', 'ملغى بعكس القيد', 'Reversed'],

      ['warehouse_txn_action.submit', 'action', 'إرسال', 'Submit'],
      ['warehouse_txn_action.recall', 'action', 'سحب', 'Recall'],
      ['warehouse_txn_action.approve', 'action', 'اعتماد', 'Approve & Post'],
      ['warehouse_txn_action.reverse', 'action', 'عكس القيد', 'Reverse'],

      ['action.create_receipt', 'action', 'إضافة (استلام)', 'Receipt'],
      ['action.create_issue', 'action', 'صرف', 'Issue'],
      ['action.create_transfer', 'action', 'تحويل', 'Transfer'],
      ['action.create_adjustment', 'action', 'تسوية', 'Adjustment'],
      ['action.start_count', 'action', 'بدء جرد', 'Start Count'],
      ['action.submit_count', 'action', 'إرسال نتيجة الجرد', 'Submit Count'],
      ['action.record_physical_count', 'action', 'تسجيل الجرد الفعلي', 'Record Physical Count'],
      ['action.view_ledger', 'action', 'عرض دفتر الحركة', 'View Ledger'],
      ['action.add_line', 'action', 'إضافة صنف', 'Add Item'],

      ['field.transaction_number', 'field', 'رقم الحركة', 'Transaction Number'],
      ['field.destination_warehouse', 'field', 'المخزن المستلم', 'Destination Warehouse'],
      ['field.system_quantity', 'field', 'الرصيد الدفتري', 'System Qty'],
      ['field.physical_quantity', 'field', 'الرصيد الفعلي', 'Physical Qty'],
      ['field.variance', 'field', 'الفرق', 'Variance'],
      ['field.min_stock', 'field', 'الحد الأدنى', 'Min'],
      ['field.total_inventory_value', 'field', 'إجمالي قيمة المخزون', 'Total Inventory Value'],
      ['field.total_warehouses', 'field', 'عدد المخازن', 'Total Warehouses'],
      ['field.todays_movements', 'field', 'حركات اليوم', 'Today’s Movements'],
      ['field.reserved_stock', 'field', 'المخزون المحجوز', 'Reserved Stock'],
      ['field.low_stock', 'field', 'أصناف منخفضة الرصيد', 'Low Stock'],
      ['field.pending_approvals', 'field', 'بانتظار الاعتماد', 'Pending Approvals'],

      ['panel.exceptions', 'panel', 'استثناءات تحتاج إجراء', 'Exceptions'],
      ['panel.no_transactions_yet', 'panel', 'لا توجد حركات بعد', 'No transactions yet.'],
      ['panel.no_exceptions', 'panel', 'لا توجد استثناءات — كل شيء تحت السيطرة', 'No exceptions — everything is under control.'],
      ['panel.recent_movements', 'panel', 'آخر الحركات', 'Recent Movements'],
      ['panel.warehouse_distribution', 'panel', 'التوزيع على المخازن', 'Warehouse Distribution'],

      ['exception.pending_approval', 'exception', 'حركة بانتظار الاعتماد', 'Pending approval'],
      ['exception.low_stock', 'exception', 'رصيد منخفض', 'Low stock'],
      ['exception.negative_stock_attempt', 'exception', 'محاولة تسجيل رصيد سالب', 'Negative stock attempt'],

      ['document.warehouse_transaction_title', 'document', 'إذن مخزني', 'Warehouse Transaction'],

      ['role.warehouse_supervisor', 'role', 'مشرف المخزن', 'Warehouse Supervisor'],
      ['role.inventory_controller', 'role', 'مراقب المخزون', 'Inventory Controller'],
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
      'nav.movement_center', 'nav.stock_count', 'nav.warehouse_overview',
      'warehouse_txn_type.receipt', 'warehouse_txn_type.issue', 'warehouse_txn_type.transfer', 'warehouse_txn_type.adjustment', 'warehouse_txn_type.count',
      'warehouse_txn_state.draft', 'warehouse_txn_state.submitted', 'warehouse_txn_state.approved', 'warehouse_txn_state.posted', 'warehouse_txn_state.reversed',
      'warehouse_txn_action.submit', 'warehouse_txn_action.recall', 'warehouse_txn_action.approve', 'warehouse_txn_action.reverse',
      'action.create_receipt', 'action.create_issue', 'action.create_transfer', 'action.create_adjustment', 'action.start_count',
      'action.submit_count', 'action.record_physical_count', 'action.view_ledger', 'action.add_line',
      'field.transaction_number', 'field.destination_warehouse', 'field.system_quantity', 'field.physical_quantity', 'field.variance',
      'field.min_stock', 'field.total_inventory_value', 'field.total_warehouses', 'field.todays_movements', 'field.reserved_stock', 'field.low_stock', 'field.pending_approvals',
      'panel.exceptions', 'panel.no_transactions_yet', 'panel.no_exceptions', 'panel.recent_movements', 'panel.warehouse_distribution',
      'exception.pending_approval', 'exception.low_stock', 'exception.negative_stock_attempt',
      'document.warehouse_transaction_title', 'role.warehouse_supervisor', 'role.inventory_controller',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
