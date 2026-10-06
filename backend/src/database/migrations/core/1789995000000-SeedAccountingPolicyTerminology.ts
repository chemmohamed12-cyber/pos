import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NAV-02 (2026-10-06) — Accounting Policy configuration screen: group names, the label + help text of each of the 12 managed policy accounts
 * and the screen's own strings. Same idempotent seed shape as every other terminology migration. Every text is <= 255 characters (a longer
 * text breaks the shared control-plane migration).
 */
export class SeedAccountingPolicyTerminology1789995000000 implements MigrationInterface {
  name = 'SeedAccountingPolicyTerminology1789995000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['nav.accounting_policy', 'nav', 'السياسات المحاسبية', 'Accounting Policy'],
    ['panel.policy_intro', 'panel', 'حدّد هنا الحسابات التي تُرحَّل إليها القيود التلقائية (المخزون، المرتجعات، فروق الأسعار، النقدية، الأصول الثابتة). يُختار الحساب من دليل حسابات هذه الشركة.', 'Set the accounts that automatic postings use (inventory, returns, price variance, cash, fixed assets). The account is chosen from this Company\'s chart of accounts.'],
    ['panel.policy_unset_effect', 'panel', 'أي إعداد غير محدد أو غير صالح يُوقف العملية المرتبطة به ولا يُرحَّل قيد ناقص (لا يوجد حساب بديل تلقائي).', 'A setting that is not set or not usable stops the related operation; no incomplete journal is posted (there is no automatic fallback account).'],
    ['panel.policy_scope_note', 'panel', 'القيمة المحفوظة تسري على التثبيت كله؛ يجب أن يكون الكود موجودًا وصالحًا في دليل حسابات كل شركة. التحقق هنا يتم على الشركة الحالية فقط.', 'A saved value applies to the whole installation; the code must exist and be usable in every Company\'s chart. Validation here covers the current Company only.'],
    ['action.clear_setting', 'action', 'إلغاء الإعداد', 'Clear setting'],
    ['action.add_reason', 'action', 'إضافة سبب', 'Add reason'],
    ['value.policy_status.unset', 'value', 'غير محدد', 'Not set'],
    ['value.policy_status.ok', 'value', 'صالح', 'Configured'],
    ['value.policy_status.invalid', 'value', 'غير صالح في هذه الشركة', 'Invalid in this Company'],
    ['policy_group.inventory', 'panel', 'المخزون', 'Inventory'],
    ['policy_group.sales', 'panel', 'المبيعات والمرتجعات', 'Sales returns'],
    ['policy_group.procurement', 'panel', 'المشتريات', 'Procurement'],
    ['policy_group.cash', 'panel', 'النقدية والبنوك', 'Cash & bank'],
    ['policy_group.fixed_assets', 'panel', 'الأصول الثابتة', 'Fixed assets'],

    ['policy.inventory_opening_balance_account_code.label', 'field', 'حساب الرصيد الافتتاحي للمخزون', 'Inventory opening balance account'],
    ['policy.inventory_opening_balance_account_code.help', 'panel', 'الطرف الدائن عند استيراد الرصيد الافتتاحي للأصناف (مدين: المخزون). عادةً حساب حقوق ملكية.', 'Credit side of opening-stock imports (debit: Inventory). Typically an equity account.'],
    ['policy.inventory_adjustment_gain_account_code.label', 'field', 'حساب مكسب تسوية المخزون', 'Inventory adjustment gain account'],
    ['policy.inventory_adjustment_gain_account_code.help', 'panel', 'الطرف الدائن عند زيادة المخزون بتسوية. عادةً حساب إيراد.', 'Credit side when an adjustment increases stock. Typically a revenue account.'],
    ['policy.inventory_adjustment_loss_account_code.label', 'field', 'حساب خسارة تسوية المخزون', 'Inventory adjustment loss account'],
    ['policy.inventory_adjustment_loss_account_code.help', 'panel', 'الطرف المدين عند نقص المخزون بتسوية. عادةً حساب مصروف.', 'Debit side when an adjustment decreases stock. Typically an expense account.'],
    ['policy.inventory_cogs_account_code.label', 'field', 'حساب تكلفة البضاعة المباعة', 'Cost of goods sold account'],
    ['policy.inventory_cogs_account_code.help', 'panel', 'الطرف المدين عند صرف البضاعة للبيع أو عكسها في المرتجعات. عادةً حساب مصروف.', 'Debit side when goods are dispatched for sale (reversed on returns). Typically an expense account.'],
    ['policy.inventory_manual_receipt_reason_accounts.label', 'field', 'أسباب الاستلام اليدوي وحساب كل سبب', 'Manual receipt reasons and their accounts'],
    ['policy.inventory_manual_receipt_reason_accounts.help', 'panel', 'قائمة الأسباب المسموح بها للاستلام اليدوي، ولكل سبب الحساب المقابل للمخزون. لا يُقبل استلام يدوي بسبب غير مُعرَّف هنا.', 'The reasons allowed for a manual receipt and the offset account of each. A manual receipt with a reason not listed here is rejected.'],
    ['policy.sales_returns_account_code.label', 'field', 'حساب مردودات المبيعات', 'Sales returns account'],
    ['policy.sales_returns_account_code.help', 'panel', 'الطرف المدين عند اعتماد مرتجع بيع مفوتر (مدين: مردودات المبيعات / دائن: العملاء).', 'Debit side of an invoiced sales return (Dr Sales Returns / Cr Receivables).'],
    ['policy.purchase_price_variance_account_code.label', 'field', 'حساب فروق أسعار الشراء', 'Purchase price variance account'],
    ['policy.purchase_price_variance_account_code.help', 'panel', 'يستقبل فرق السعر بين فاتورة المورد وسعر أمر الشراء عند ترحيل فاتورة المورد. عادةً حساب مصروف.', 'Receives the difference between the supplier invoice and the PO price when a supplier invoice is posted. Typically an expense account.'],
    ['policy.cash_bank_opening_balance_account_code.label', 'field', 'حساب الرصيد الافتتاحي للنقدية والبنوك', 'Cash & bank opening balance account'],
    ['policy.cash_bank_opening_balance_account_code.help', 'panel', 'الطرف المقابل عند تسجيل رصيد افتتاحي لحساب نقدية/بنك. عادةً حساب حقوق ملكية.', 'Offset when an opening balance is recorded for a cash/bank account. Typically an equity account.'],
    ['policy.cash_movement_clearing_account_code.label', 'field', 'حساب تسوية الحركات النقدية', 'Cash movement clearing account'],
    ['policy.cash_movement_clearing_account_code.help', 'panel', 'الطرف المقابل للحركات النقدية المباشرة (إيداع/صرف) التي لا ترتبط بعملية أخرى.', 'Offset for direct cash movements (cash in / cash out) that are not tied to another operation.'],
    ['policy.fixed_asset_gain_on_disposal_account_code.label', 'field', 'حساب أرباح بيع الأصول الثابتة', 'Gain on disposal of fixed assets account'],
    ['policy.fixed_asset_gain_on_disposal_account_code.help', 'panel', 'يُدائن عند بيع أصل بسعر أعلى من قيمته الدفترية. عادةً حساب إيراد.', 'Credited when an asset is disposed of above its net book value. Typically a revenue account.'],
    ['policy.fixed_asset_loss_on_disposal_account_code.label', 'field', 'حساب خسائر بيع الأصول الثابتة', 'Loss on disposal of fixed assets account'],
    ['policy.fixed_asset_loss_on_disposal_account_code.help', 'panel', 'يُمدَّن عند بيع أصل بسعر أقل من قيمته الدفترية. عادةً حساب مصروف.', 'Debited when an asset is disposed of below its net book value. Typically an expense account.'],
    ['policy.fixed_asset_acquisition_clearing_account_code.label', 'field', 'حساب تسوية اقتناء الأصول الثابتة', 'Fixed asset acquisition clearing account'],
    ['policy.fixed_asset_acquisition_clearing_account_code.help', 'panel', 'الطرف الدائن لقيد الاقتناء التلقائي (مدين: تكلفة الأصل)، ويُسوّى لاحقًا مع المورد أو البنك. لا يمس الموردين أو الخزينة.', 'Credit side of the automatic acquisition journal (debit: asset cost); settled later against the supplier or bank. It does not touch payables or treasury.'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [code, category, ar, en] of this.rows) {
      await queryRunner.query(
        `INSERT INTO "terminology_entries" ("code", "category", "ar", "en")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET "ar" = EXCLUDED."ar", "en" = EXCLUDED."en", "version" = "terminology_entries"."version" + 1`,
        [code, category, ar, en],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [this.rows.map(([code]) => code)]);
  }
}
