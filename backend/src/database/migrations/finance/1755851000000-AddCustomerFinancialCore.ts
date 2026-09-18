import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer Financial Account / Invoice / AR (CTO directive) — closes the
 * Customer Financial Cycle: a real, append-only Customer Ledger subledger
 * (`customer_ledger_entries`), Sales Invoices (`sales_invoices` +
 * `sales_invoice_lines`), and Payments (`customer_payments`), plus Credit
 * Control fields on `customers` and one additive column on `return_credits`
 * for the new "apply credit to an invoice" path. Reuses the EXISTING
 * Treasury (money never moves except through `TreasuryService`), Deposit
 * Control, COD/Collection, and ReturnCredit issuance flows — no parallel
 * ledger, no rebuild of anything already working.
 */
export class AddCustomerFinancialCore1755851000000 implements MigrationInterface {
  name = 'AddCustomerFinancialCore1755851000000';

  private readonly terminology: Array<[string, string, string, string]> = [
    // Invoice lifecycle
    ['sales_invoice_lifecycle.state.draft', 'workflow_status', 'مسودة', 'Draft'],
    ['sales_invoice_lifecycle.state.posted', 'workflow_status', 'معتمدة', 'Posted'],
    ['sales_invoice_lifecycle.state.partially_paid', 'workflow_status', 'مدفوعة جزئيًا', 'Partially Paid'],
    ['sales_invoice_lifecycle.state.paid', 'workflow_status', 'مدفوعة بالكامل', 'Paid'],
    ['sales_invoice_lifecycle.state.void', 'workflow_status', 'ملغاة', 'Void'],
    // Customer Ledger entry types
    ['customer_ledger_entry_type.sales_invoice', 'field', 'فاتورة مبيعات', 'Sales Invoice'],
    ['customer_ledger_entry_type.deposit', 'field', 'عربون', 'Deposit'],
    ['customer_ledger_entry_type.payment', 'field', 'دفعة', 'Payment'],
    ['customer_ledger_entry_type.cod_collection', 'field', 'تحصيل عند الاستلام', 'COD Collection'],
    ['customer_ledger_entry_type.return_credit_note', 'field', 'إشعار دائن (مرتجع)', 'Return Credit Note'],
    ['customer_ledger_entry_type.debit_note', 'field', 'إشعار مدين', 'Debit Note'],
    ['customer_ledger_entry_type.adjustment', 'field', 'تسوية', 'Adjustment'],
    ['customer_ledger_entry_type.opening_balance', 'field', 'رصيد افتتاحي', 'Opening Balance'],
    ['customer_ledger_entry_type.refund', 'field', 'استرداد', 'Refund'],
    // Fields
    ['field.invoice_number', 'field', 'رقم الفاتورة', 'Invoice No.'],
    ['field.invoice', 'field', 'الفاتورة', 'Invoice'],
    ['field.subtotal', 'field', 'الإجمالي الفرعي', 'Subtotal'],
    ['field.discount', 'field', 'الخصم', 'Discount'],
    ['field.tax', 'field', 'الضريبة', 'Tax'],
    ['field.total_amount', 'field', 'الإجمالي', 'Total'],
    ['field.due_date', 'field', 'تاريخ الاستحقاق', 'Due Date'],
    ['field.remaining', 'field', 'المتبقي', 'Remaining'],
    ['field.credit_limit', 'field', 'حد الائتمان', 'Credit Limit'],
    ['field.available_credit', 'field', 'الائتمان المتاح', 'Available Credit'],
    ['field.payment_terms_days', 'field', 'مدة السداد (أيام)', 'Payment Terms (days)'],
    ['field.account_type', 'field', 'نوع الحساب', 'Account Type'],
    ['field.financial_status', 'field', 'الحالة المالية', 'Financial Status'],
    ['field.balance', 'field', 'الرصيد', 'Balance'],
    ['field.overdue_amount', 'field', 'المتأخر', 'Overdue'],
    ['field.total_sales', 'field', 'إجمالي المبيعات', 'Total Sales'],
    ['field.total_paid', 'field', 'إجمالي المدفوع', 'Total Paid'],
    ['field.total_outstanding', 'field', 'إجمالي المستحق', 'Total Outstanding'],
    ['field.total_returns', 'field', 'إجمالي المرتجعات', 'Total Returns'],
    ['field.debit', 'field', 'مدين', 'Debit'],
    ['field.credit', 'field', 'دائن', 'Credit'],
    ['field.running_balance', 'field', 'الرصيد الجاري', 'Running Balance'],
    ['field.payment_number', 'field', 'رقم الدفعة', 'Payment No.'],
    ['field.payment_method', 'field', 'طريقة الدفع', 'Payment Method'],
    ['field.aging_bucket', 'field', 'شريحة التقادم', 'Aging Bucket'],
    ['field.days_overdue', 'field', 'أيام التأخير', 'Days Overdue'],
    ['account_type.cash', 'field', 'نقدي', 'Cash'],
    ['account_type.credit', 'field', 'آجل', 'Credit'],
    ['financial_status.active', 'field', 'نشط', 'Active'],
    ['financial_status.on_hold', 'field', 'موقوف مؤقتًا', 'On Hold'],
    ['financial_status.suspended', 'field', 'موقوف', 'Suspended'],
    ['aging_bucket.current', 'field', 'حالي', 'Current'],
    // Panels/actions
    ['panel.customer_dashboard', 'panel', 'الحساب المالي للعميل', 'Customer Financial Account'],
    ['panel.invoices', 'panel', 'الفواتير', 'Invoices'],
    ['panel.payments', 'panel', 'المدفوعات', 'Payments'],
    ['panel.ar_aging', 'panel', 'أعمار الديون', 'AR Aging'],
    ['panel.customer_ledger', 'panel', 'كشف حساب العميل', 'Customer Ledger'],
    ['panel.no_invoices_yet', 'panel', 'لا توجد فواتير بعد', 'No invoices yet'],
    ['panel.no_payments_yet', 'panel', 'لا توجد مدفوعات بعد', 'No payments yet'],
    ['panel.no_ledger_entries_yet', 'panel', 'لا توجد حركات بعد', 'No ledger entries yet'],
    ['action.create_invoice', 'action', 'إنشاء فاتورة', 'Create Invoice'],
    ['action.post_invoice', 'action', 'اعتماد الفاتورة', 'Post Invoice'],
    ['action.void_invoice', 'action', 'إلغاء الفاتورة', 'Void Invoice'],
    ['action.record_payment', 'action', 'تسجيل دفعة', 'Record Payment'],
    ['action.apply_credit_to_invoice', 'action', 'تطبيق الرصيد على الفاتورة', 'Apply Credit to Invoice'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Credit Control fields on customers ----
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "creditLimit" NUMERIC(14,2)`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "paymentTermsDays" INT`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "accountType" VARCHAR(16) NOT NULL DEFAULT 'credit'`);
    await queryRunner.query(`ALTER TABLE "customers" ADD COLUMN "financialStatus" VARCHAR(16) NOT NULL DEFAULT 'active'`);

    // ---- Customer Ledger ----
    await queryRunner.query(`
      CREATE TABLE "customer_ledger_entries" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "entryNumber" varchar(32) NOT NULL,
        "customerId" uuid NOT NULL,
        "entryType" varchar(32) NOT NULL,
        "direction" varchar(8) NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "salesOrderId" uuid,
        "invoiceId" uuid,
        "depositId" uuid,
        "paymentId" uuid,
        "returnCreditId" uuid,
        "shipmentId" uuid,
        "treasuryTransactionId" uuid,
        "reference" varchar(255),
        "reason" varchar(255),
        "entryDate" timestamptz NOT NULL,
        "createdByUserId" uuid NOT NULL,
        "reversalOfEntryId" uuid,
        "status" varchar(16) NOT NULL DEFAULT 'posted',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_customer_ledger_entries_entryNumber" ON "customer_ledger_entries" ("entryNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_customer_ledger_entries_customerId" ON "customer_ledger_entries" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_customer_ledger_entries_salesOrderId" ON "customer_ledger_entries" ("salesOrderId")`);
    await queryRunner.query(`CREATE INDEX "IDX_customer_ledger_entries_invoiceId" ON "customer_ledger_entries" ("invoiceId")`);

    // ---- Sales Invoices ----
    await queryRunner.query(`
      CREATE TABLE "sales_invoices" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "invoiceNumber" varchar(32) NOT NULL,
        "customerId" uuid NOT NULL,
        "salesOrderId" uuid NOT NULL,
        "shipmentId" uuid,
        "subtotal" numeric(14,2) NOT NULL,
        "discountAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "taxAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "totalAmount" numeric(14,2) NOT NULL,
        "dueDate" timestamptz,
        "createdByUserId" uuid NOT NULL,
        "postedByUserId" uuid,
        "voidedReason" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_sales_invoices_invoiceNumber" ON "sales_invoices" ("invoiceNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_invoices_customerId" ON "sales_invoices" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_sales_invoices_salesOrderId" ON "sales_invoices" ("salesOrderId")`);

    await queryRunner.query(`
      CREATE TABLE "sales_invoice_lines" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "salesInvoiceId" uuid NOT NULL,
        "salesOrderLineId" uuid,
        "productId" uuid NOT NULL,
        "quantity" int NOT NULL,
        "unitPrice" numeric(12,2) NOT NULL,
        "discountAmount" numeric(12,2) NOT NULL DEFAULT 0,
        "lineTotal" numeric(14,2) NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_sales_invoice_lines_salesInvoiceId" ON "sales_invoice_lines" ("salesInvoiceId")`);

    // ---- Customer Payments ----
    await queryRunner.query(`
      CREATE TABLE "customer_payments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "paymentNumber" varchar(32) NOT NULL,
        "customerId" uuid NOT NULL,
        "invoiceId" uuid NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "method" varchar(32) NOT NULL,
        "treasuryAccountId" uuid NOT NULL,
        "treasuryTransactionId" uuid,
        "reference" varchar(255),
        "recordedByUserId" uuid NOT NULL,
        "occurredAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_customer_payments_paymentNumber" ON "customer_payments" ("paymentNumber")`);
    await queryRunner.query(`CREATE INDEX "IDX_customer_payments_customerId" ON "customer_payments" ("customerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_customer_payments_invoiceId" ON "customer_payments" ("invoiceId")`);

    // ---- Returns Engine bridge: apply a credit to an Invoice's AR ----
    // ADR-025 / P6 (Finding F-P6-1): `return_credits` is owned by the
    // `logistics` module, which is not in `finance`'s dependency closure.
    // On an Edition without `logistics` there are no return credits at all,
    // so this bridge column is simply not added — guarded, not an error.
    // Whenever `logistics` IS enabled its `return_credits` table is created
    // by `1755850600000-AddReturnsEngineCustomerReturns` (an earlier
    // timestamp), so this guard passes and the column + index are added
    // exactly as before.
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('"return_credits"') IS NOT NULL THEN
          ALTER TABLE "return_credits" ADD COLUMN IF NOT EXISTS "appliedToInvoiceId" UUID;
          CREATE INDEX IF NOT EXISTS "IDX_return_credits_appliedToInvoiceId" ON "return_credits" ("appliedToInvoiceId");
        END IF;
      END $$;`);

    // ---- Numbering ----
    await queryRunner.query(
      `INSERT INTO "numbering_sequences" ("documentType", "prefix", "includeYear") VALUES
        ('customer_ledger_entry', 'CLE', true),
        ('sales_invoice', 'INV', true),
        ('customer_payment', 'PAY', true)
       ON CONFLICT DO NOTHING`,
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
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.terminology.map(([code]) => code)]);
    await queryRunner.query(
      `DELETE FROM "numbering_sequences" WHERE "documentType" IN ('customer_ledger_entry', 'sales_invoice', 'customer_payment')`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_return_credits_appliedToInvoiceId"`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('"return_credits"') IS NOT NULL THEN
          ALTER TABLE "return_credits" DROP COLUMN IF EXISTS "appliedToInvoiceId";
        END IF;
      END $$;`);

    await queryRunner.query(`DROP TABLE "customer_payments"`);
    await queryRunner.query(`DROP TABLE "sales_invoice_lines"`);
    await queryRunner.query(`DROP TABLE "sales_invoices"`);
    await queryRunner.query(`DROP TABLE "customer_ledger_entries"`);

    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "financialStatus"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "accountType"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "paymentTermsDays"`);
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "creditLimit"`);
  }
}
