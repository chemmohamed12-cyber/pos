import { MigrationInterface, QueryRunner } from 'typeorm';

/** CTO directive ("SHIPPING & CUSTODY MANAGEMENT") — Company Vehicles UI + custody visibility labels. */
export class SeedShippingCustodyTerminology1755849600000 implements MigrationInterface {
  name = 'SeedShippingCustodyTerminology1755849600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.responsible_person', 'field', 'الشخص المسؤول', 'Responsible Person'],
      ['panel.vehicles', 'panel', 'سيارات الشركة', 'Company Vehicles'],
      ['field.vehicle', 'field', 'السيارة', 'Vehicle'],
      ['field.vehicle_code', 'field', 'كود السيارة', 'Vehicle Code'],
      ['field.plate_number', 'field', 'رقم اللوحة', 'Plate Number'],
      ['field.branch', 'field', 'الفرع', 'Branch'],
      ['field.no_vehicle', 'field', 'بدون سيارة', 'No vehicle'],
      ['action.add_vehicle', 'action', 'إضافة سيارة', 'Add Vehicle'],
      ['action.change_driver', 'action', 'تغيير السائق', 'Change Driver'],
      ['action.retire', 'action', 'إخراج من الخدمة', 'Retire'],
      ['field.custody_balance', 'field', 'الأموال تحت العهدة', 'Money Under Custody'],
      ['field.active_shipments', 'field', 'الشحنات الحالية', 'Active Shipments'],
      ['vehicle_status.active', 'status', 'فى الخدمة', 'Active'],
      ['vehicle_status.retired', 'status', 'خارج الخدمة', 'Retired'],
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
      'field.responsible_person',
      'panel.vehicles',
      'field.vehicle',
      'field.vehicle_code',
      'field.plate_number',
      'field.branch',
      'field.no_vehicle',
      'action.add_vehicle',
      'action.change_driver',
      'action.retire',
      'field.custody_balance',
      'field.active_shipments',
      'vehicle_status.active',
      'vehicle_status.retired',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
