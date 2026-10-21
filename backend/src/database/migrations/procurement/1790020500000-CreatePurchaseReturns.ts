import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase D-1 (owner decisions D7 / E3, 2026-10-20) - the formal purchase return document (goods returned to the supplier), linked to goods-receipt lines.
 * Purely additive: two new tables, a `quantityReturned` counter (default 0) on goods-receipt lines and purchase-order lines, and terminology. No existing row, amount, journal or number is touched;
 * every existing line reads as "nothing returned". `down` drops the tables, the two counters and the terminology (a posted return would make `down` lose its return history - documented as
 * irreversible once returns exist).
 */
export class CreatePurchaseReturns1790020500000 implements MigrationInterface {
  name = 'CreatePurchaseReturns1790020500000';

  private readonly terms: Array<[string, string, string, string]> = [
    ['nav.purchase_returns', 'field', 'مردودات المشتريات', 'Purchase Returns'],
    ['purchase_return_lifecycle.state.draft', 'field', 'مسودة', 'Draft'],
    ['purchase_return_lifecycle.state.submitted', 'field', 'مرسل للاعتماد', 'Submitted'],
    ['purchase_return_lifecycle.state.approved', 'field', 'معتمد', 'Approved'],
    ['purchase_return_lifecycle.state.rejected', 'field', 'مرفوض', 'Rejected'],
    ['purchase_return_lifecycle.state.posted', 'field', 'مرحّل', 'Posted'],
    ['purchase_return_lifecycle.state.void', 'field', 'ملغى', 'Void'],
    ['movement_type.purchase_return_out', 'movement_type', 'مردود مشتريات إلى المورد', 'Purchase return to supplier'],
    ['panel.no_purchase_returns_yet', 'panel', 'لا توجد مردودات مشتريات بعد', 'No purchase returns yet'],
    ['permission.procurement.purchase_return.view', 'field', 'عرض مردودات المشتريات', 'View purchase returns'],
    ['permission.procurement.purchase_return.create', 'field', 'إنشاء مردودات المشتريات', 'Create purchase returns'],
    ['permission.procurement.purchase_return.submit', 'field', 'إرسال مردودات المشتريات للاعتماد', 'Submit purchase returns'],
    ['permission.procurement.purchase_return.approve', 'field', 'اعتماد مردودات المشتريات', 'Approve purchase returns'],
    ['permission.procurement.purchase_return.post', 'field', 'ترحيل مردودات المشتريات', 'Post purchase returns'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "goods_receipt_lines" ADD COLUMN IF NOT EXISTS "quantityReturned" NUMERIC(18,3) NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "quantityReturned" NUMERIC(18,3) NOT NULL DEFAULT 0`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "purchase_returns" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "returnNumber" VARCHAR(32) NOT NULL,
        "supplierId" UUID NOT NULL REFERENCES "suppliers"("id"),
        "warehouseId" UUID NOT NULL REFERENCES "warehouses"("id"),
        "reason" VARCHAR(255) NOT NULL,
        "createdByUserId" UUID NOT NULL,
        "submittedByUserId" UUID,
        "approvedByUserId" UUID,
        "approvedAt" TIMESTAMPTZ,
        "postedByUserId" UUID,
        "postedAt" TIMESTAMPTZ,
        "rejectedReason" VARCHAR(500),
        "voidedReason" VARCHAR(255),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_purchase_returns_number" ON "purchase_returns" ("returnNumber")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_purchase_returns_supplier" ON "purchase_returns" ("supplierId")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "purchase_return_lines" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "purchaseReturnId" UUID NOT NULL REFERENCES "purchase_returns"("id") ON DELETE CASCADE,
        "goodsReceiptLineId" UUID NOT NULL REFERENCES "goods_receipt_lines"("id"),
        "purchaseOrderLineId" UUID NOT NULL REFERENCES "purchase_order_lines"("id"),
        "productId" UUID NOT NULL,
        "quantity" NUMERIC(18,3) NOT NULL CHECK ("quantity" > 0),
        "receiptUnitCostBase" NUMERIC(18,4) NOT NULL,
        "exitValueBase" NUMERIC(20,4),
        "differenceBase" NUMERIC(20,4)
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_purchase_return_lines_return" ON "purchase_return_lines" ("purchaseReturnId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_purchase_return_lines_receipt" ON "purchase_return_lines" ("goodsReceiptLineId")`);

    const values = this.terms.map(([code, category, ar, en]) => `('${code}', '${category}', '${ar.replace(/'/g, "''")}', '${en.replace(/'/g, "''")}')`).join(',\n       ');
    await queryRunner.query(
      `INSERT INTO "terminology_entries" ("code", "category", "ar", "en") VALUES
       ${values}
       ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "purchase_return_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "purchase_returns"`);
    await queryRunner.query(`ALTER TABLE "goods_receipt_lines" DROP COLUMN IF EXISTS "quantityReturned"`);
    await queryRunner.query(`ALTER TABLE "purchase_order_lines" DROP COLUMN IF EXISTS "quantityReturned"`);
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1::text[])`, [this.terms.map(([code]) => code)]);
  }
}
