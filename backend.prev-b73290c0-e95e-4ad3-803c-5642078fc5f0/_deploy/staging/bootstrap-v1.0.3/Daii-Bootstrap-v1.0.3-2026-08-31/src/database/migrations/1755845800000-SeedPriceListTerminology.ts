import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap G-3 (EXCEL_BUSINESS_MAPPING_PACKAGE.md) — Price List UI terminology.
 *
 * Also frees `document.price_list_title` ("قائمة الأسعار" / "Price List")
 * for its terminologically-correct use — the new Price List entity this
 * migration introduces — by giving the PRODUCT CATALOG print (which was
 * using that code, but is really just a printed catalog, not a
 * customer-specific price list) its own accurate
 * `document.product_catalog_title` code instead. Frontend usages
 * (`Products.tsx`, `ProductListPrint.tsx`) are repointed in the same
 * change. `document.price_list_title` itself is left untouched — its
 * existing Arabic/English text is already exactly right for the new
 * feature's own print page.
 */
export class SeedPriceListTerminology1755845800000 implements MigrationInterface {
  name = 'SeedPriceListTerminology1755845800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['document.product_catalog_title', 'document', 'كتالوج المنتجات', 'Product Catalog'],
      ['nav.price_lists', 'nav', 'قوائم الأسعار', 'Price Lists'],
      ['field.price', 'field', 'السعر', 'Price'],
      ['field.list_price', 'field', 'سعر القائمة', 'List Price'],
      ['field.price_variance', 'field', 'انحراف السعر', 'Price Variance'],
      ['field.customer_price_list', 'field', 'قائمة أسعار العميل', 'Customer Price List'],
      ['field.no_override', 'field', 'بدون قائمة (السعر الأساسي)', 'None (Base Price)'],
      ['panel.no_price_lists_yet', 'panel', 'لا توجد قوائم أسعار بعد', 'No price lists yet.'],
      ['panel.no_price_list_items_yet', 'panel', 'لا توجد أصناف في هذه القائمة بعد', 'No items in this price list yet.'],
      ['action.add_item', 'action', 'إضافة صنف', 'Add Item'],
      ['action.remove', 'action', 'إزالة', 'Remove'],
      ['action.view_items', 'action', 'عرض الأصناف', 'View Items'],
      ['price_list_status.active', 'workflow_status', 'مفعّلة', 'Active'],
      ['price_list_status.inactive', 'workflow_status', 'معطّلة', 'Inactive'],
      ['action.activate_price_list', 'action', 'تفعيل', 'Activate'],
      ['action.deactivate_price_list', 'action', 'تعطيل', 'Deactivate'],
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
      'document.product_catalog_title', 'nav.price_lists', 'field.price', 'field.list_price',
      'field.price_variance', 'field.customer_price_list', 'field.no_override',
      'panel.no_price_lists_yet', 'panel.no_price_list_items_yet', 'action.add_item', 'action.remove',
      'action.view_items', 'price_list_status.active', 'price_list_status.inactive',
      'action.activate_price_list', 'action.deactivate_price_list',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
