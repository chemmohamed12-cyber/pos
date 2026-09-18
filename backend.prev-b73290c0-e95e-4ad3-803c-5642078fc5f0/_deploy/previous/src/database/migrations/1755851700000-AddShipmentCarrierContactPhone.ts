import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shipping Screen Redesign directive §6 — the phone number of the
 * shipping company's own representative who physically received the
 * shipment, captured alongside the existing carrier waybill number/image.
 * Nullable, same precedent as every other additive column on `shipments`.
 */
export class AddShipmentCarrierContactPhone1755851700000 implements MigrationInterface {
  name = 'AddShipmentCarrierContactPhone1755851700000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.carrier_contact_phone', 'field', 'هاتف مندوب شركة الشحن', 'Carrier Contact Phone'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shipments" ADD COLUMN "carrierContactPhone" VARCHAR(32)`);
    for (const [code, category, ar, en] of this.terminology) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
    await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "carrierContactPhone"`);
  }
}
