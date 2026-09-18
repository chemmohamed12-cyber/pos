import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Returns Engine (CTO directive) — Phase A: Customer Returns (exchange /
 * value-credit / product-return), a real Returns/Inspection Location, and
 * Return Credits usable on a new Sales Order draft. Extends the existing
 * `return_requests` table (no new Process Engine, no parallel ledger) and
 * adds `return_credits`, a lightweight own-table ledger (no per-customer
 * Treasury account exists in this codebase to piggyback on instead).
 */
export class AddReturnsEngineCustomerReturns1755850600000 implements MigrationInterface {
  name = 'AddReturnsEngineCustomerReturns1755850600000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['return_type.exchange', 'field', 'استبدال', 'Exchange'],
    ['return_type.value_credit', 'field', 'مرتجع بقيمة', 'Value Return / Credit'],
    ['return_type.product_return', 'field', 'إرجاع منتج', 'Customer Product Return'],
    ['field.return_type', 'field', 'نوع المرتجع', 'Return Type'],
    ['field.return_number', 'field', 'رقم المرتجع', 'Return No.'],
    ['field.original_order', 'field', 'الأمر الأصلي', 'Original SO'],
    ['field.credit_value', 'field', 'قيمة الرصيد', 'Credit Value'],
    ['field.credit_status', 'field', 'حالة الرصيد', 'Credit Status'],
    ['credit_status.active', 'field', 'متاح', 'Active'],
    ['credit_status.fully_used', 'field', 'مستخدم بالكامل', 'Fully Used'],
    ['credit_status.void', 'field', 'ملغى', 'Void'],
    ['panel.returns_credits', 'panel', 'المرتجعات / الأرصدة', 'Returns / Credits'],
    ['field.subtotal', 'field', 'الإجمالي الفرعي', 'Subtotal'],
    ['field.return_credit_applied', 'field', 'رصيد المرتجعات', 'Return Credit'],
    ['field.net_total', 'field', 'الصافي', 'Net Total'],
    ['action.apply_credit', 'action', 'تطبيق', 'Apply'],
    ['panel.no_available_credits', 'panel', 'لا يوجد أرصدة متاحة لهذا العميل', 'No available credits for this customer'],
    ['action.query', 'action', 'استعلام', 'Query'],
    ['field.eligible_orders', 'field', 'الطلبات المؤهلة', 'Eligible Orders'],
    ['disposition.repair', 'field', 'إصلاح', 'Repair'],
    ['error.order_created_credit_apply_failed', 'field', 'تم إنشاء الأمر لكن فشل تطبيق الرصيد — يمكن تطبيقه لاحقًا من شاشة الأمر.', 'Order created, but applying the credit failed — it can be applied later from the order screen.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "salesOrderLineId" UUID`);
    await queryRunner.query(`CREATE INDEX "IDX_return_requests_salesOrderLineId" ON "return_requests" ("salesOrderLineId")`);
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "returnType" VARCHAR(20)`);
    await queryRunner.query(`ALTER TABLE "return_requests" ADD COLUMN "returnNumber" VARCHAR(32)`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_return_requests_returnNumber" ON "return_requests" ("returnNumber")`);

    await queryRunner.query(`
      CREATE TABLE "return_credits" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "returnRequestId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "originalSalesOrderId" varchar(255) NOT NULL,
        "originalAmount" numeric(14,2) NOT NULL,
        "usedAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "remainingAmount" numeric(14,2) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "appliedToSalesOrderId" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_return_credits_returnRequestId" ON "return_credits" ("returnRequestId")`);
    await queryRunner.query(`CREATE INDEX "IDX_return_credits_customerId" ON "return_credits" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_return_credits_originalSalesOrderId" ON "return_credits" ("originalSalesOrderId")`);
    await queryRunner.query(`CREATE INDEX "IDX_return_credits_appliedToSalesOrderId" ON "return_credits" ("appliedToSalesOrderId")`);

    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES ('return', 'RET', true) ON CONFLICT DO NOTHING`,
    );

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
    await queryRunner.query(
      `DELETE FROM "terminology_entries" WHERE code = ANY($1)`,
      [this.terminology.map(([code]) => code)],
    );
    await queryRunner.query(`DELETE FROM "numbering_sequences" WHERE "documentType" = 'return'`);
    await queryRunner.query(`DROP TABLE "return_credits"`);
    await queryRunner.query(`DROP INDEX "IDX_return_requests_returnNumber"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "returnNumber"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "returnType"`);
    await queryRunner.query(`DROP INDEX "IDX_return_requests_salesOrderLineId"`);
    await queryRunner.query(`ALTER TABLE "return_requests" DROP COLUMN "salesOrderLineId"`);
  }
}
