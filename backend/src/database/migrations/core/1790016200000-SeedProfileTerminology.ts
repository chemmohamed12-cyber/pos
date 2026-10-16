import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer / supplier profile screens (master-data gap matrix §5, M7) — the labels that did not exist yet (each code was checked against
 * every earlier migration; labels that already existed, e.g. `field.legal_name`, `field.email`, `field.contact_title`, are reused as they
 * are). Data only — no schema change. `up` never overwrites an existing label (`ON CONFLICT DO NOTHING`); `down` removes exactly these rows.
 */
export class SeedProfileTerminology1790016200000 implements MigrationInterface {
  name = 'SeedProfileTerminology1790016200000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['panel.customer_profile', 'panel', 'ملف العميل', 'Customer profile'],
    ['panel.profile', 'panel', 'الملف', 'Profile'],
    ['panel.contacts', 'panel', 'جهات الاتصال', 'Contacts'],
    ['panel.addresses', 'panel', 'العناوين', 'Addresses'],
    ['panel.no_contacts_yet', 'panel', 'لا توجد جهات اتصال بعد', 'No contacts yet'],
    ['panel.no_addresses_yet', 'panel', 'لا توجد عناوين بعد', 'No addresses yet'],
    ['field.party_type', 'field', 'نوع الطرف', 'Party type'],
    ['field.language', 'field', 'اللغة', 'Language'],
    ['field.website', 'field', 'الموقع الإلكتروني', 'Website'],
    ['field.internal_notes', 'field', 'ملاحظات داخلية', 'Internal notes'],
    ['field.label', 'field', 'الوصف', 'Label'],
    ['field.is_primary', 'field', 'رئيسي', 'Primary'],
    ['field.is_default', 'field', 'افتراضي', 'Default'],
    ['field.is_billing', 'field', 'عنوان فواتير', 'Billing address'],
    ['field.is_shipping', 'field', 'عنوان شحن', 'Shipping address'],
    ['action.add', 'action', 'إضافة', 'Add'],
    ['action.set_primary', 'action', 'تعيين كرئيسي', 'Make primary'],
    ['action.set_default', 'action', 'تعيين كافتراضي', 'Make default'],
    ['value.party_type.company', 'value', 'شركة', 'Company'],
    ['value.party_type.individual', 'value', 'فرد', 'Individual'],
    ['value.language.ar', 'value', 'العربية', 'Arabic'],
    ['value.language.en', 'value', 'الإنجليزية', 'English'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
