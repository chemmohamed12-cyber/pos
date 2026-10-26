import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Direct sale from the company (2026-10-20) - labels for the new `direct_sale` sales-order shipping method and the shipment's counter hand-over action. Data only; every code is NEW and the insert never rewrites an existing label
 * (ON CONFLICT DO NOTHING); `down` removes exactly these rows.
 */
export class SeedDirectSaleTerminology1790019000000 implements MigrationInterface {
  name = 'SeedDirectSaleTerminology1790019000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['shipping_method.direct_sale', 'field', 'بيع مباشر من الشركة', 'Direct sale from the company'],
    ['shipment_lifecycle.action.direct_handover', 'workflow_action', 'تسليم مباشر للعميل', 'Hand over to the customer'],
    ['shipment_lifecycle.state.ready_for_handover', 'workflow_status', 'جاهز للتسليم', 'Ready for hand-over'],
    ['panel.direct_sale_notice', 'panel', 'بيع مباشر من الشركة: يتسلّم العميل البضاعة من الشركة — لا سائق ولا سيارة ولا شركة شحن ولا عهدة. يُسجَّل التسليم بخطوة واحدة، وتخرج البضاعة من المخزن (وتُحتسب تكلفتها) عند التسليم، ويُورَّد المبلغ المحصَّل مباشرة إلى خزينة الشركة.', 'Direct sale: the customer takes the goods from the company - no driver, vehicle, carrier or custody. Hand-over is one step; stock leaves the warehouse (cost booked) at hand-over and the cash goes straight to the company treasury.'],
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
