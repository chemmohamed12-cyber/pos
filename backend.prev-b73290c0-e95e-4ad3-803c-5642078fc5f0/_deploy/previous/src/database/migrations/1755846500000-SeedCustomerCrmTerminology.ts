import { MigrationInterface, QueryRunner } from 'typeorm';

/** Gap G-5 (EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) — real CRM master sheet fields, UI terminology. */
export class SeedCustomerCrmTerminology1755846500000 implements MigrationInterface {
  name = 'SeedCustomerCrmTerminology1755846500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.governorate', 'field', 'المحافظة', 'Governorate'],
      ['field.manager_name', 'field', 'اسم المدير', 'Manager Name'],
      ['field.address', 'field', 'العنوان', 'Address'],
      ['field.whatsapp_phone', 'field', 'رقم الواتس', 'WhatsApp'],
      ['field.contact_method', 'field', 'طريقة التواصل', 'Contact Method'],
      ['field.responsiveness_level', 'field', 'مدى الاستجابة', 'Responsiveness'],
      ['field.disinterest_notes', 'field', 'ملاحظات عدم الاهتمام', 'Disinterest Notes'],
      ['field.price_satisfaction_level', 'field', 'مدى الرضا عن الأسعار', 'Price Satisfaction'],
      ['field.top_brand', 'field', 'البراند الأكثر طلبًا', 'Top Brand'],
      ['field.mid_brand', 'field', 'البراند المتوسط الطلب', 'Mid Brand'],
      ['field.low_brand', 'field', 'البراند الأقل طلبًا', 'Low Brand'],
      ['field.shipping_method_preference', 'field', 'طريقة الشحن', 'Shipping Method'],
      ['field.location_url', 'field', 'الموقع', 'Location'],
      ['action.view_details', 'action', 'التفاصيل', 'Details'],
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
      'field.governorate', 'field.manager_name', 'field.address', 'field.whatsapp_phone', 'field.contact_method',
      'field.responsiveness_level', 'field.disinterest_notes', 'field.price_satisfaction_level', 'field.top_brand',
      'field.mid_brand', 'field.low_brand', 'field.shipping_method_preference', 'field.location_url', 'action.view_details',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
