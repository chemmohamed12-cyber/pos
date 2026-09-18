import { MigrationInterface, QueryRunner } from 'typeorm';

/** Warehouse ERP V1 / Phase 1 Integration (CTO directive §3/§13) — Warehouse Master + Product Unit + Movement Date. */
export class SeedWarehouseMasterTerminology1755847600000 implements MigrationInterface {
  name = 'SeedWarehouseMasterTerminology1755847600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['field.location', 'field', 'الموقع', 'Location'],
      ['field.responsible_user', 'field', 'المسؤول', 'Responsible User'],
      ['field.unit', 'field', 'الوحدة', 'Unit'],
      ['field.movement_date', 'field', 'تاريخ الحركة', 'Movement Date'],
      ['action.activate_warehouse', 'action', 'تفعيل', 'Activate'],
      ['action.deactivate_warehouse', 'action', 'تعطيل', 'Deactivate'],
      ['warehouse_status.active', 'workflow_status', 'مفعّل', 'Active'],
      ['warehouse_status.inactive', 'workflow_status', 'معطّل', 'Inactive'],
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
      'field.location', 'field.responsible_user', 'field.unit', 'field.movement_date',
      'action.activate_warehouse', 'action.deactivate_warehouse',
      'warehouse_status.active', 'warehouse_status.inactive',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
