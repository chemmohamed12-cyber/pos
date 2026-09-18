import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Post-v1.0.2 Hotfix 3 — "Product Price Selection During Sales Order
 * Creation" price-list priority chain (Customer -> Main -> General).
 *
 * Adds `role` to `price_lists` ('main' | 'general' | null) — a nullable
 * flag, not a new table, since a Main/General list is still an ordinary
 * `PriceList` row with ordinary `PriceListItem`s; only which one gets
 * consulted (and in what order) changes. A partial unique index enforces
 * at most one list holds each role at a time (`PriceListsService.setRole`
 * also auto-clears the previous holder before assigning a new one — this
 * index is the defensive DB-level backstop, not the only enforcement).
 *
 * Also creates the single system-owned General list and backfills it with
 * every existing product's CURRENT price. Every product created from here
 * on gets added automatically at creation time
 * (`PriceListsService`'s subscription to `commerce.product.created`, same
 * event `IntegrationsService` already subscribes to) — this migration
 * only needs to cover products that already existed before this hotfix.
 *
 * Known limitation, stated plainly (per the CTO directive's requirement
 * that Known Issues never be hidden): there is no historical
 * "true creation-time price" recoverable for pre-existing products —
 * `Product.unitPrice` is a live field `updatePrice` overwrites in place,
 * with no prior snapshot kept anywhere. Each pre-existing product's
 * CURRENT price is used as the best available proxy. Every product
 * created AFTER this migration runs gets its actual real creation-time
 * price captured correctly, going forward.
 */
export class AddPriceListRoleAndGeneralList1755852400000 implements MigrationInterface {
  name = 'AddPriceListRoleAndGeneralList1755852400000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['field.price_list_role', 'field', 'دور قائمة الأسعار', 'Price List Role'],
    ['price_list_role.main', 'price_list_role', 'رئيسية', 'Main'],
    ['price_list_role.general', 'price_list_role', 'عامة', 'General'],
    ['action.set_main_price_list', 'action', 'تعيين كقائمة رئيسية', 'Set as Main'],
    ['action.unset_main_price_list', 'action', 'إلغاء التعيين كقائمة رئيسية', 'Unset as Main'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "price_lists" ADD COLUMN "role" VARCHAR(16) NULL`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_price_lists_role" ON "price_lists" ("role") WHERE "role" IS NOT NULL`,
    );

    // One system-owned General list, backfilled with every existing
    // product's current price in the same statement.
    await queryRunner.query(`
      WITH general_list AS (
        INSERT INTO "price_lists" ("code", "name", "status", "role")
        VALUES ('PL-GENERAL', 'General Price List', 'active', 'general')
        RETURNING "id"
      )
      INSERT INTO "price_list_items" ("priceListId", "productId", "price")
      SELECT general_list."id", p."id", p."unitPrice"
      FROM "products" p, general_list
    `);

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
    await queryRunner.query(`DELETE FROM "price_lists" WHERE "code" = 'PL-GENERAL'`); // cascades to its items (ON DELETE CASCADE)
    await queryRunner.query(`DROP INDEX "IDX_price_lists_role"`);
    await queryRunner.query(`ALTER TABLE "price_lists" DROP COLUMN "role"`);
  }
}
