import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ERP UI Integration (CTO directive — "Customer Financial Account / Invoice
 * / AR" navigation gap). New nav group, new dedicated screens (Customer
 * Accounts list, Customer Statement, Invoices, Payments, AR Aging), and the
 * new print document titles they need. No new domain terminology — every
 * financial concept (`customer_ledger_entry_type.*`, `sales_invoice_lifecycle.*`,
 * `field.balance`, `field.remaining`, etc.) already exists from the earlier
 * Customer Financial Core phase and is reused as-is.
 */
export class SeedCustomersAccountsUiTerminology1755851300000 implements MigrationInterface {
  name = 'SeedCustomersAccountsUiTerminology1755851300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav_group.customers_accounts', 'nav_group', 'العملاء والحسابات', 'Customers & Accounts'],
      ['nav.customer_accounts', 'nav', 'حسابات العملاء', 'Customer Accounts'],
      ['nav.customer_statement', 'nav', 'كشف حساب العميل', 'Customer Statement'],
      ['nav.invoices', 'nav', 'الفواتير', 'Invoices'],
      ['nav.payments', 'nav', 'التحصيلات والمدفوعات', 'Collections & Payments'],
      ['nav.ar_aging', 'nav', 'أعمار الديون', 'AR Aging'],

      ['field.sales_representative', 'field', 'مندوب المبيعات', 'Sales Representative'],
      ['field.last_invoice', 'field', 'آخر فاتورة', 'Last Invoice'],
      ['field.last_payment', 'field', 'آخر دفعة', 'Last Payment'],
      ['field.document_type', 'field', 'نوع المستند', 'Document Type'],
      ['field.date_from', 'field', 'من تاريخ', 'Date From'],
      ['field.date_to', 'field', 'إلى تاريخ', 'Date To'],
      ['field.all_document_types', 'field', 'كل الأنواع', 'All Types'],
      ['field.total_customers', 'field', 'إجمالي العملاء', 'Total Customers'],
      ['field.total_customer_balances', 'field', 'إجمالي أرصدة العملاء', 'Total Customer Balances'],
      ['field.total_outstanding_all', 'field', 'إجمالي المستحقات', 'Total Outstanding'],
      ['field.total_overdue_all', 'field', 'إجمالي المتأخرات', 'Total Overdue'],
      ['field.open_invoices_count', 'field', 'الفواتير المفتوحة', 'Open Invoices'],
      ['field.collections_count', 'field', 'التحصيلات', 'Collections'],
      ['field.overdue_invoices_count', 'field', 'فواتير متأخرة', 'Overdue Invoices'],
      ['field.available_return_credits', 'field', 'أرصدة مرتجعات متاحة', 'Available Return Credits'],
      ['field.credit_amount', 'field', 'قيمة الرصيد', 'Credit Amount'],
      ['field.available_amount', 'field', 'المتاح', 'Available Amount'],
      ['field.used_amount', 'field', 'المستخدم', 'Used Amount'],
      ['field.original_sales_order', 'field', 'أمر البيع الأصلي', 'Original Sales Order'],
      ['field.recorded_by', 'field', 'بواسطة', 'Recorded By'],
      ['field.no_customer_selected', 'field', 'الرجاء اختيار عميل', 'Please select a customer'],

      ['action.export', 'action', 'تصدير', 'Export'],
      ['action.view_invoice', 'action', 'عرض الفاتورة', 'View Invoice'],
      ['action.view_statement', 'action', 'كشف الحساب', 'Statement'],
      ['action.view_customer_account', 'action', 'الحساب المالي', 'Customer Account'],

      ['panel.no_credits_available', 'panel', 'لا توجد أرصدة مرتجعات متاحة', 'No available return credits'],
      ['panel.no_customer_accounts_yet', 'panel', 'لا يوجد عملاء بعد', 'No customers yet'],
      ['panel.select_customer_to_view_statement', 'panel', 'اختر عميلاً لعرض كشف الحساب', 'Select a customer to view their statement'],

      ['document.invoice_title', 'document', 'فاتورة مبيعات', 'Sales Invoice'],
      ['document.payment_receipt_title', 'document', 'إيصال تحصيل', 'Payment Receipt'],
      ['document.customer_statement_title', 'document', 'كشف حساب عميل', 'Customer Statement'],

      ['return_credit_status.active', 'return_credit_status', 'متاح', 'Available'],
      ['return_credit_status.partially_used', 'return_credit_status', 'مستخدم جزئيًا', 'Partially Used'],
      ['return_credit_status.fully_used', 'return_credit_status', 'مستخدم بالكامل', 'Fully Used'],
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
        'nav_group.customers_accounts',
        'nav.customer_accounts',
        'nav.customer_statement',
        'nav.invoices',
        'nav.payments',
        'nav.ar_aging',
        'field.sales_representative',
        'field.last_invoice',
        'field.last_payment',
        'field.document_type',
        'field.date_from',
        'field.date_to',
        'field.all_document_types',
        'field.total_customers',
        'field.total_customer_balances',
        'field.total_outstanding_all',
        'field.total_overdue_all',
        'field.open_invoices_count',
        'field.collections_count',
        'field.overdue_invoices_count',
        'field.available_return_credits',
        'field.credit_amount',
        'field.available_amount',
        'field.used_amount',
        'field.original_sales_order',
        'field.recorded_by',
        'field.no_customer_selected',
        'action.export',
        'action.view_invoice',
        'action.view_statement',
        'action.view_customer_account',
        'panel.no_credits_available',
        'panel.no_customer_accounts_yet',
        'panel.select_customer_to_view_statement',
        'document.invoice_title',
        'document.payment_receipt_title',
        'document.customer_statement_title',
        'return_credit_status.active',
        'return_credit_status.partially_used',
        'return_credit_status.fully_used',
      ],
    ]);
  }
}
