import {
  ageInvoices,
  bandOf,
  closingBalance,
  dayDiff,
  daysPastDue,
  describeEntry,
  periodTotals,
  runningBalances,
  statementReference,
} from './customer-statement-rules';

describe('customer statement — pure rules', () => {
  describe('running / opening / closing balance', () => {
    const rows = [
      { direction: 'debit' as const, amount: '100.10' },
      { direction: 'credit' as const, amount: '40.05' },
      { direction: 'debit' as const, amount: '0.10' },
      { direction: 'credit' as const, amount: '300.00' },
    ];
    it('starts from the OPENING balance, not from zero', () => {
      expect(runningBalances('1000.00', rows)).toEqual(['1100.10', '1060.05', '1060.15', '760.15']);
      expect(runningBalances('0.00', rows)[0]).toBe('100.10');
    });
    it('closing = opening + debit − credit, in exact cents', () => {
      const t = periodTotals(rows);
      expect(t).toEqual({ debit: '100.20', credit: '340.05' });
      expect(closingBalance('1000.00', t)).toBe('760.15');
      expect(closingBalance('1000.00', t)).toBe(runningBalances('1000.00', rows).at(-1));
    });
    it('a credit balance (customer in credit) is negative and stays exact', () => {
      expect(runningBalances('-14.00', [{ direction: 'debit', amount: '10.00' }])).toEqual(['-4.00']);
    });
    it('ten additions of 0.10 are exactly 1.00 (no floating point drift)', () => {
      expect(periodTotals(Array.from({ length: 10 }, () => ({ direction: 'debit' as const, amount: '0.10' }))).debit).toBe('1.00');
    });
    it('a reversal pair nets to the same closing balance as if neither existed', () => {
      const withPair = [...rows, { direction: 'credit' as const, amount: '50.00' }, { direction: 'debit' as const, amount: '50.00' }];
      expect(closingBalance('0.00', periodTotals(withPair))).toBe(closingBalance('0.00', periodTotals(rows)));
    });
  });

  describe('aging — day and band boundaries (D5)', () => {
    it('calendar-day difference is whole UTC days, independent of the time of day', () => {
      expect(dayDiff('2026-10-01', '2026-10-31')).toBe(30);
      expect(dayDiff('2026-10-31', '2026-10-01')).toBe(-30);
      expect(dayDiff('2026-02-28', '2026-03-01')).toBe(1);
      expect(dayDiff('2026-10-01T23:59:59.000Z', '2026-10-02T00:00:01.000Z')).toBe(1);
    });
    it('due today = 0 days late (not overdue); the first overdue day is tomorrow', () => {
      expect(daysPastDue('2026-10-10', '2026-10-10')).toBe(0);
      expect(daysPastDue('2026-10-10', '2026-10-11')).toBe(1);
      expect(daysPastDue('2026-10-20', '2026-10-10')).toBe(0); // not yet due
      expect(daysPastDue(null, '2026-10-10')).toBe(0); // no due date → not overdue
    });
    it('band edges: 30 → 0–30, 31 → 31–60, 60 → 31–60, 61 → 61–90, 90 → 61–90, 91 → 90+', () => {
      expect([0, 1, 30].map(bandOf)).toEqual(['0-30', '0-30', '0-30']);
      expect([31, 60].map(bandOf)).toEqual(['31-60', '31-60']);
      expect([61, 90].map(bandOf)).toEqual(['61-90', '61-90']);
      expect([91, 500].map(bandOf)).toEqual(['90+', '90+']);
    });
    it('ages open invoices into the four bands, separating not-yet-due from overdue, ignoring settled ones', () => {
      const r = ageInvoices(
        [
          { remaining: '100.00', dueDate: '2026-11-01' }, // not yet due
          { remaining: '200.00', dueDate: '2026-10-10' }, // due today: 0 days
          { remaining: '300.00', dueDate: '2026-10-09' }, // 1 day
          { remaining: '400.00', dueDate: '2026-09-10' }, // 30 days → 0–30
          { remaining: '500.00', dueDate: '2026-09-09' }, // 31 days
          { remaining: '600.00', dueDate: '2026-07-12' }, // 90 days → 61–90
          { remaining: '700.00', dueDate: '2026-07-11' }, // 91 days → 90+
          { remaining: '0.00', dueDate: '2026-01-01' }, // settled
          { remaining: '-5.00', dueDate: '2026-01-01' }, // over-applied: not a receivable
        ],
        '2026-10-10',
      );
      expect(r.bands).toEqual({ '0-30': '1000.00', '31-60': '500.00', '61-90': '600.00', '90+': '700.00' });
      expect(r.notYetDue).toBe('300.00');
      expect(r.overdue).toBe('2200.00');
      expect(r.totalOpen).toBe('2800.00');
    });
  });

  describe('business descriptions (read-time, never rewriting history)', () => {
    const e = (entryType: string, direction: 'debit' | 'credit', reason: string | null, reversalOfEntryId: string | null = null) => ({ entryType, direction, reason, reversalOfEntryId });
    it('replaces the technical English posting text with an Arabic and an English business sentence', () => {
      expect(describeEntry(e('deposit', 'credit', 'Customer deposit (cash)'), { orderNumber: 'SO-1' })).toEqual({ ar: 'عربون عميل (نقدًا) — أمر بيع SO-1', en: 'Customer deposit (cash) — order SO-1' });
      expect(describeEntry(e('sales_invoice', 'debit', 'Sales invoice posted'), { invoiceNumber: 'INV-7' })).toEqual({ ar: 'فاتورة مبيعات مرحّلة — فاتورة INV-7', en: 'Sales invoice posted — invoice INV-7' });
      expect(describeEntry(e('cod_collection', 'credit', 'COD remitted (cash)'), { waybillNumber: 'WB-9' }).ar).toBe('تحصيل عند التسليم (نقدًا) — مورَّد — بوليصة WB-9');
    });
    it('distinguishes an on-account payment from a payment against an invoice', () => {
      expect(describeEntry(e('payment', 'credit', 'On-account payment (cash)')).ar).toBe('دفعة على الحساب (نقدًا)');
      expect(describeEntry(e('payment', 'credit', 'Payment (bank_transfer)'), { invoiceNumber: 'INV-1', paymentNumber: 'PAY-1' }).ar).toBe('دفعة على فاتورة (تحويل بنكي) — فاتورة INV-1 / إيصال PAY-1');
    });
    it('labels returns, reversals and applications', () => {
      expect(describeEntry(e('return_credit_note', 'credit', 'Sales return credit')).en).toBe('Credit note — sales return');
      expect(describeEntry(e('return_credit_note', 'credit', 'Return credit applied to invoice')).en).toBe('Return credit applied to invoice');
      expect(describeEntry(e('adjustment', 'credit', 'Reversal: wrong amount', 'x')).ar).toBe('عكس قيد: wrong amount');
      expect(describeEntry(e('payment_application', 'debit', 'Application of PAY-1')).ar).toContain('تسوية دفعة');
    });
    it('never invents: an unknown type is «غير محدد», an unknown reason adds nothing', () => {
      expect(describeEntry(e('something_new', 'debit', null)).ar).toBe('غير محدد');
      expect(describeEntry(e('adjustment', 'debit', 'free text we do not parse')).ar).toBe('تسوية');
    });
  });

  describe('generated statement reference (D4)', () => {
    it('is descriptive, stable for the same inputs, and changes with the content digest', () => {
      const a = statementReference('CUST-1', '2026-09-01', '2026-09-30', '2026-10-24T18:10:55.000Z', 'abcdef1234');
      expect(a).toBe('ST-CUST-1-20260901-20260930-202610241810-ABCDEF12');
      expect(statementReference('CUST-1', '2026-09-01', '2026-09-30', '2026-10-24T18:10:55.000Z', 'abcdef1234')).toBe(a);
      expect(statementReference('CUST-1', '2026-09-01', '2026-09-30', '2026-10-24T18:10:55.000Z', '99999999')).not.toBe(a);
      expect(statementReference('CUST-1', null, null, '2026-10-24T18:10:55.000Z', 'abcdef12')).toContain('START-TODAY');
    });
  });
});
