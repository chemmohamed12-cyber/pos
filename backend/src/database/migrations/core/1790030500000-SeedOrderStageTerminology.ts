import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Order stage labels (2026-10-22) - the sales-order screens now show where a released order is (in preparation / ready for shipping / in shipping / delivered) and the
 * Sales order list gets completed / incomplete tiles. Data only; every code is NEW and the insert never rewrites an existing row (ON CONFLICT DO NOTHING); `down`
 * removes exactly these rows. Each label stays within the column's 255 characters.
 */
export class SeedOrderStageTerminology1790030500000 implements MigrationInterface {
  name = 'SeedOrderStageTerminology1790030500000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['order_stage.in_preparation', 'workflow_status', 'قيد التجهيز', 'In preparation'],
    ['order_stage.ready_for_shipping', 'workflow_status', 'تم التجهيز - جاهز للشحن', 'Prepared - ready for shipping'],
    ['order_stage.in_shipping', 'workflow_status', 'في مرحلة الشحن', 'In shipping'],
    ['order_stage.delivered', 'workflow_status', 'تم التسليم', 'Delivered'],
    ['panel.orders_completed', 'panel', 'الطلبات المكتملة (اعتُمدت وأُرسلت للتجهيز)', 'Completed orders (approved and sent to preparation)'],
    ['panel.orders_incomplete', 'panel', 'الطلبات غير المكتملة (لم تُرسل للتجهيز بعد)', 'Incomplete orders (not yet sent to preparation)'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(`INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`, [code, category, ar, en]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
