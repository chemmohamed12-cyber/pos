import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F03 — General Ledger (ADR-035). `accounting`-tagged (ADR-025). Every
 * string the F03 frontend renders comes from the Terminology Registry
 * (ADR-011), same pattern as F01/F02.
 */
export class SeedGeneralLedgerTerminology1755854900000 implements MigrationInterface {
  name = 'SeedGeneralLedgerTerminology1755854900000';

  private readonly terminology: Array<[string, string, string, string]> = [
    ['nav.journals', 'field', 'القيود اليومية', 'Journal Entries'],
    ['nav.general_ledger', 'field', 'دفتر الأستاذ العام', 'General Ledger'],
    ['nav.trial_balance', 'field', 'ميزان المراجعة', 'Trial Balance'],
    ['nav.financial_events', 'field', 'الأحداث المالية', 'Financial Events'],
    ['field.entry_number', 'field', 'رقم القيد', 'Entry Number'],
    ['field.business_date', 'field', 'تاريخ العملية', 'Business Date'],
    ['field.posting_date', 'field', 'تاريخ الترحيل', 'Posting Date'],
    ['field.journal_status', 'field', 'حالة القيد', 'Status'],
    ['field.source_type', 'field', 'نوع المصدر', 'Source'],
    ['field.line_number', 'field', 'رقم السطر', 'Line #'],
    ['field.debit', 'field', 'مدين', 'Debit'],
    ['field.credit', 'field', 'دائن', 'Credit'],
    ['field.debit_base', 'field', 'مدين (بالعملة الأساسية)', 'Debit (base)'],
    ['field.credit_base', 'field', 'دائن (بالعملة الأساسية)', 'Credit (base)'],
    ['field.exchange_rate', 'field', 'سعر الصرف', 'Exchange Rate'],
    ['field.opening_balance', 'field', 'الرصيد الافتتاحي', 'Opening Balance'],
    ['field.period_movement', 'field', 'حركة الفترة', 'Period Movement'],
    ['field.closing_balance', 'field', 'الرصيد الختامي', 'Closing Balance'],
    ['field.rejection_reason', 'field', 'سبب الرفض', 'Rejection Reason'],
    ['field.idempotency_key', 'field', 'مفتاح عدم التكرار', 'Idempotency Key'],
    ['value.journal_status.draft', 'field', 'مسودة', 'Draft'],
    ['value.journal_status.validated', 'field', 'مُتحقَّق منها', 'Validated'],
    ['value.journal_status.posted', 'field', 'مُرحَّلة', 'Posted'],
    ['value.journal_status.reversed', 'field', 'معكوسة', 'Reversed'],
    ['value.source_type.financial_event', 'field', 'حدث مالي', 'Financial Event'],
    ['value.source_type.manual', 'field', 'قيد يدوي', 'Manual'],
    ['value.source_type.reversal', 'field', 'قيد عكسي', 'Reversal'],
    ['value.source_type.opening', 'field', 'قيد افتتاحي', 'Opening'],
    ['value.financial_event_status.received', 'field', 'مُستلَم', 'Received'],
    ['value.financial_event_status.mapped', 'field', 'مُطابَق', 'Mapped'],
    ['value.financial_event_status.posted', 'field', 'مُرحَّل', 'Posted'],
    ['value.financial_event_status.rejected', 'field', 'مرفوض', 'Rejected'],
    ['value.financial_event_status.ignored', 'field', 'مُتجاهَل', 'Ignored'],
    ['action.add_journal_line', 'field', 'إضافة سطر', 'Add Line'],
    ['action.submit_journal', 'field', 'اعتماد للمراجعة', 'Submit for Review'],
    ['action.post_journal', 'field', 'ترحيل', 'Post'],
    ['action.reverse_journal', 'field', 'عكس القيد', 'Reverse'],
    ['action.new_manual_journal', 'field', 'قيد يدوي جديد', 'New Manual Journal'],
    ['action.redrive_financial_event', 'field', 'إعادة معالجة', 'Re-drive'],
    ['panel.no_journals_yet', 'field', 'لا توجد قيود بعد', 'No journal entries yet'],
    ['panel.no_financial_events_yet', 'field', 'لا توجد أحداث مالية بعد', 'No financial events yet'],
    ['panel.journal_not_balanced', 'field', 'القيد غير متوازن — إجمالي المدين يجب أن يساوي إجمالي الدائن', 'Entry is not balanced — total debit must equal total credit'],
    ['panel.trial_balance_footer', 'field', 'الإجماليات', 'Totals'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}
