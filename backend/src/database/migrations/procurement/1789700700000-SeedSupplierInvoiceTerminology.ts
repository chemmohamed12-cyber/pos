import { MigrationInterface, QueryRunner } from 'typeorm';

/** `procurement`-tagged (ADR-025). Supplier Invoice / AP / Supplier Ledger / Supplier Payment UI/API strings. */
export class SeedSupplierInvoiceTerminology1789700700000 implements MigrationInterface {
  name = 'SeedSupplierInvoiceTerminology1789700700000';

  // `field.invoice_number`, `field.due_date`, `field.remaining`, `field.payment_method`,
  // `field.treasury_account`, `field.payment_number`, `field.amount`, `field.balance` already exist
  // (finance/core/accounting seeds) — reused as-is in the frontend, not re-seeded here to avoid an
  // `ON CONFLICT DO UPDATE` touching unrelated screens (and `field.treasury_account` already has
  // THREE different pre-existing Arabic wordings across older seeds — picking one here would be
  // arbitrary, so it's left alone).
  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.supplier_invoices', 'field', 'فواتير الموردين', 'Supplier Invoices'],
    ['nav.supplier_payments', 'field', 'مدفوعات الموردين', 'Supplier Payments'],
    ['nav.ap_aging', 'field', 'أعمار ذمم الموردين', 'AP Aging'],

    ['field.supplier_reference', 'field', 'مرجع المورد', 'Supplier Reference'],
    ['field.price_variance', 'field', 'فرق السعر', 'Price Variance'],
    ['field.days_overdue', 'field', 'أيام التأخير', 'Days Overdue'],

    // `action.post_invoice`/`action.void_invoice`/`action.record_payment` already exist
    // (finance seed) with matching wording — reused as-is, not re-seeded.
    ['action.create_supplier_invoice', 'field', 'إنشاء فاتورة مورد', 'Create Supplier Invoice'],

    ['supplier_invoice_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['supplier_invoice_lifecycle.state.posted', 'field', 'مرحّلة', 'Posted'],
    ['supplier_invoice_lifecycle.state.partially_paid', 'field', 'مدفوعة جزئيًا', 'Partially Paid'],
    ['supplier_invoice_lifecycle.state.paid', 'field', 'مدفوعة بالكامل', 'Paid'],
    ['supplier_invoice_lifecycle.state.void', 'field', 'ملغاة', 'Void'],

    ['value.aging_bucket.current', 'field', 'حالي', 'Current'],
    ['value.aging_bucket.1-30', 'field', '١-٣٠ يوم', '1-30 days'],
    ['value.aging_bucket.31-60', 'field', '٣١-٦٠ يوم', '31-60 days'],
    ['value.aging_bucket.61-90', 'field', '٦١-٩٠ يوم', '61-90 days'],
    ['value.aging_bucket.90+', 'field', 'أكثر من ٩٠ يوم', '90+ days'],

    ['panel.no_supplier_invoices_yet', 'panel', 'لا توجد فواتير موردين بعد', 'No supplier invoices yet'],
    ['panel.no_supplier_payments_yet', 'panel', 'لا توجد مدفوعات موردين بعد', 'No supplier payments yet'],
    ['panel.no_ap_aging_rows', 'panel', 'لا توجد أرصدة مستحقة', 'No outstanding balances'],
    ['panel.no_ledger_entries', 'panel', 'لا توجد حركات', 'No ledger entries'],
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
