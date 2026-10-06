import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CUS-01 (2026-10-06, CTO: Option 1) — Customer Account screen: on-account / advance customer payment, the "Customer Advance / Unapplied Receipt"
 * presentation (a label only — the GL classification is the existing Cr AR control), and the explicit "apply to invoice" action. Same idempotent
 * seed shape as every other terminology migration.
 */
export class SeedOnAccountPaymentTerminology1789992000000 implements MigrationInterface {
  name = 'SeedOnAccountPaymentTerminology1789992000000';

  private readonly rows: Array<[string, string, string, string]> = [
    ['customer_ledger_entry_type.payment_application', 'value', 'تسوية دفعة على فاتورة', 'Payment applied to invoice'],
    ['panel.customer_advance_unapplied', 'panel', 'سلفة عميل / إيصال غير مُطبَّق', 'Customer advance / unapplied receipt'],
    [
      'panel.on_account_note',
      'panel',
      'دفعة مستلمة قبل الفاتورة: مدين الخزينة المربوطة / دائن حساب العملاء، وتظهر رصيدًا دائنًا غير مُطبَّق يُسوّى بترحيل فاتورة الطلب المحدد أو بزر التطبيق.',
      'Money received before an invoice: Dr the mapped treasury account / Cr receivables; an unapplied credit, settled when the earmarked order\'s invoice is posted or with Apply.',
    ],
    ['panel.no_unapplied_receipts', 'panel', 'لا توجد إيصالات غير مُطبَّقة.', 'No unapplied receipts.'],
    ['action.record_on_account_payment', 'action', 'تسجيل دفعة على الحساب', 'Record on-account payment'],
    ['action.apply_unapplied_payment', 'action', 'تطبيق على فاتورة', 'Apply to invoice'],
    ['field.unapplied_amount', 'field', 'غير المُطبَّق', 'Unapplied'],
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
