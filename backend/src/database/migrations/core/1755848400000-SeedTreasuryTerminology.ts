import { MigrationInterface, QueryRunner } from 'typeorm';

/** Treasury / Financial Core — Arabic-first terminology for the new domain, plus the Sales Order Create screen's Deposit section. */
export class SeedTreasuryTerminology1755848400000 implements MigrationInterface {
  name = 'SeedTreasuryTerminology1755848400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const seed: Array<[string, string, string, string]> = [
      ['nav_group.treasury', 'nav_group', 'الخزينة', 'Treasury'],
      ['nav.treasury_accounts', 'nav', 'حسابات الخزينة', 'Treasury Accounts'],
      ['nav.treasury_ledger', 'nav', 'سجل الحركات المالية', 'Treasury Ledger'],
      ['field.account_code', 'field', 'كود الحساب', 'Account Code'],
      ['field.account_name', 'field', 'اسم الحساب', 'Account Name'],
      ['field.account_type', 'field', 'نوع الحساب', 'Account Type'],
      ['field.balance', 'field', 'الرصيد', 'Balance'],
      ['field.treasury_account', 'field', 'الخزينة', 'Treasury Account'],
      ['field.source_account', 'field', 'من حساب', 'Source Account'],
      ['field.destination_account', 'field', 'إلى حساب', 'Destination Account'],
      ['field.transaction_type', 'field', 'نوع الحركة', 'Transaction Type'],
      ['field.amount', 'field', 'المبلغ', 'Amount'],
      ['field.deposit_amount', 'field', 'قيمة العربون', 'Deposit Amount'],
      ['field.deposit_receipt', 'field', 'صورة إيصال التحويل', 'Transfer Receipt Image'],
      ['field.deposit_evidence', 'field', 'إيصال العربون', 'Deposit Evidence'],
      ['panel.deposit_at_order_creation', 'panel', 'عربون العميل', 'Customer Deposit'],
      ['panel.treasury_accounts', 'panel', 'حسابات الخزينة', 'Treasury Accounts'],
      ['panel.treasury_ledger', 'panel', 'سجل الحركات المالية', 'Treasury Ledger'],
      ['action.upload_receipt', 'action', 'تحميل صورة الإيصال', 'Upload Receipt'],
      ['action.create_account', 'action', 'إنشاء حساب', 'Create Account'],
      ['action.cash_in', 'action', 'إيداع نقدي', 'Cash In'],
      ['action.cash_out', 'action', 'سحب نقدي', 'Cash Out'],
      ['action.transfer', 'action', 'تحويل بين الحسابات', 'Transfer'],
      ['action.reverse', 'action', 'عكس الحركة', 'Reverse'],
      ['account_type.cash', 'account_type', 'نقدي', 'Cash'],
      ['account_type.bank', 'account_type', 'بنكي', 'Bank'],
      ['treasury_txn_type.cash_in', 'treasury_txn_type', 'إيداع', 'Cash In'],
      ['treasury_txn_type.cash_out', 'treasury_txn_type', 'سحب', 'Cash Out'],
      ['treasury_txn_type.transfer_in', 'treasury_txn_type', 'تحويل وارد', 'Transfer In'],
      ['treasury_txn_type.transfer_out', 'treasury_txn_type', 'تحويل صادر', 'Transfer Out'],
      ['role.finance', 'role', 'المالية', 'Finance'],
      ['error.order_created_deposit_failed', 'error', 'تم إنشاء أمر البيع، لكن فشل تسجيل العربون — يمكن تسجيله من صفحة تفاصيل الأمر.', 'Order created, but recording the deposit failed — it can still be submitted from the order detail screen.'],
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
      'nav_group.treasury', 'nav.treasury_accounts', 'nav.treasury_ledger',
      'field.account_code', 'field.account_name', 'field.account_type', 'field.balance',
      'field.treasury_account', 'field.source_account', 'field.destination_account', 'field.transaction_type', 'field.amount',
      'field.deposit_amount', 'field.deposit_receipt', 'field.deposit_evidence',
      'panel.deposit_at_order_creation', 'panel.treasury_accounts', 'panel.treasury_ledger',
      'action.upload_receipt', 'action.create_account', 'action.cash_in', 'action.cash_out', 'action.transfer', 'action.reverse',
      'account_type.cash', 'account_type.bank',
      'treasury_txn_type.cash_in', 'treasury_txn_type.cash_out', 'treasury_txn_type.transfer_in', 'treasury_txn_type.transfer_out',
      'role.finance', 'error.order_created_deposit_failed',
    ];
    await queryRunner.query(`DELETE FROM "terminology_entries" WHERE code = ANY($1)`, [codes]);
  }
}
