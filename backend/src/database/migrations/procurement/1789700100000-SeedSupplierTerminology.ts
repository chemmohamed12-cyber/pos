import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `procurement`-tagged (ADR-025). Supplier Master UI/API strings —
 * idempotent (`ON CONFLICT`) shape, same as every other terminology seed.
 */
export class SeedSupplierTerminology1789700100000 implements MigrationInterface {
  name = 'SeedSupplierTerminology1789700100000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['module.procurement', 'module', 'المشتريات', 'Procurement'],
    ['nav_group.procurement', 'field', 'المشتريات', 'Procurement'],
    ['nav.suppliers', 'field', 'الموردون', 'Suppliers'],

    ['field.supplier', 'field', 'المورد', 'Supplier'],
    ['field.supplier_code', 'field', 'كود المورد', 'Supplier Code'],
    ['field.legal_name', 'field', 'الاسم القانوني', 'Legal Name'],
    ['field.trading_name', 'field', 'الاسم التجاري', 'Trading Name'],
    ['field.supplier_type', 'field', 'نوع المورد', 'Supplier Type'],
    ['value.supplier_type.company', 'field', 'شركة', 'Company'],
    ['value.supplier_type.individual', 'field', 'فرد', 'Individual'],
    ['field.tax_registration_number', 'field', 'الرقم الضريبي', 'Tax Registration No.'],
    ['field.vat_registration_number', 'field', 'رقم التسجيل الضريبي (ق.م.ض)', 'VAT Registration No.'],
    ['field.commercial_registration_number', 'field', 'رقم السجل التجاري', 'Commercial Registration No.'],
    ['field.payment_terms_days', 'field', 'مدة السداد (أيام)', 'Payment Terms (Days)'],
    ['field.credit_limit', 'field', 'حد الائتمان', 'Credit Limit'],
    ['field.search_supplier_placeholder', 'field', 'ابحث باسم المورد…', 'Search by supplier name…'],

    ['action.add_supplier', 'field', 'إضافة مورد', 'Add Supplier'],
    ['action.add_contact', 'field', 'إضافة جهة اتصال', 'Add Contact'],
    ['action.add_address', 'field', 'إضافة عنوان', 'Add Address'],
    ['action.add_bank_account', 'field', 'إضافة حساب بنكي', 'Add Bank Account'],
    ['action.supplier_bank_account_change', 'field', 'اعتماد تغيير حساب بنكي لمورد', 'Approve Supplier Bank-Account Change'],

    ['field.contact_name', 'field', 'اسم جهة الاتصال', 'Contact Name'],
    ['field.contact_title', 'field', 'المسمى الوظيفي', 'Title'],
    ['field.phone', 'field', 'الهاتف', 'Phone'],
    ['field.email', 'field', 'البريد الإلكتروني', 'Email'],

    ['field.address_line', 'field', 'العنوان', 'Address'],
    ['field.city', 'field', 'المدينة', 'City'],
    ['field.governorate', 'field', 'المحافظة', 'Governorate'],

    ['field.bank_name', 'field', 'اسم البنك', 'Bank Name'],
    ['field.account_number', 'field', 'رقم الحساب', 'Account Number'],
    ['field.iban', 'field', 'الآيبان', 'IBAN'],
    ['field.swift', 'field', 'السويفت', 'SWIFT'],
    ['field.approval_status', 'field', 'حالة الاعتماد', 'Approval Status'],
    ['value.approval_status.pending', 'field', 'بانتظار الاعتماد', 'Pending Approval'],
    ['value.approval_status.approved', 'field', 'معتمد', 'Approved'],
    ['value.approval_status.rejected', 'field', 'مرفوض', 'Rejected'],

    ['panel.no_suppliers_yet', 'panel', 'لا يوجد موردون بعد', 'No suppliers yet'],
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
