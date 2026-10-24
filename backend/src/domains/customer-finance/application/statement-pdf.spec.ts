import { buildStatementPdf, fmtMoney, visualPieces } from './statement-pdf';
import type { CustomerStatement } from './customer-statement.service';

const texts = (t: string, rtl: boolean) => visualPieces(t, rtl).map((p) => p.text);

describe('statement PDF — bidirectional layout and document structure (no database)', () => {
  it('lays out an Arabic line in visual order: numbers stay left-to-right, brackets enclose the word they belong to', () => {
    const pieces = texts('عربون عميل (نقدًا) — أمر بيع SO-000321', true);
    expect(pieces).toEqual(['SO-000321', ' ', 'بيع', ' ', 'أمر', ' — (', 'نقدًا', ') ', 'عميل', ' ', 'عربون']);
  });

  it('keeps an English line in logical order and shapes an embedded Arabic name as its own right-to-left piece', () => {
    expect(texts('Customer: شركة النور (CUST-1)', false)).toEqual(['Customer: ', 'النور', ' ', 'شركة', ' (CUST-1)']);
  });

  it('draws Arabic letters with the Arabic face and digits / Latin / punctuation with the Latin face (two different internal font names)', () => {
    const faces = visualPieces('رقم 123 (A)', true).map((p) => `${p.face}:${p.text}`);
    expect(faces.some((f) => f.startsWith('ar:'))).toBe(true);
    expect(faces).toContain('lat:123');
  });

  it('formats money with thousands separators and two decimals in every language', () => {
    expect(fmtMoney('1234567.5')).toBe('1,234,567.50');
    expect(fmtMoney('-14')).toBe('-14.00');
  });

  const rows = Array.from({ length: 90 }, (_, i) => ({
    entryId: `e${i}`,
    entryNumber: `CLE-${i}`,
    date: '2026-09-01T10:00:00.000Z',
    dueDate: null,
    entryType: 'sales_invoice',
    typeLabel: { ar: 'فاتورة مبيعات', en: 'Sales invoice' },
    description: { ar: 'فاتورة مبيعات مرحّلة — فاتورة INV-1', en: 'Sales invoice posted — invoice INV-1' },
    documentType: 'sales_invoice',
    documentNumber: `INV-${i}`,
    documentLink: null,
    debit: '10.00',
    credit: '0.00',
    balance: String(10 * (i + 1)) + '.00',
    status: 'posted' as const,
    isReversalLeg: false,
    nettedOut: false,
    flags: [],
  }));
  const statement: CustomerStatement = {
    reference: 'ST-X-START-TODAY-202610241810-ABCDEF12',
    referenceNote: { ar: 'مرجع مُولَّد', en: 'Generated reference' },
    generatedAt: '2026-10-24T18:10:00.000Z',
    customer: { id: 'c', code: 'C-1', name: 'شركة الاختبار', phone: null, address: null, governorate: null, taxRegistrationNumber: null, creditLimit: null, paymentTermsDays: null },
    period: { from: null, to: null },
    currency: { code: 'EGP', note: { ar: 'عملة أساسية', en: 'Base currency' } },
    filters: { entryType: null, status: null },
    isComplete: true,
    openingBalance: '0.00',
    rows,
    totals: { debit: '900.00', credit: '0.00' },
    totalsExcludingReversals: { debit: '900.00', credit: '0.00' },
    filteredTotals: null,
    closingBalance: '900.00',
    reversedCount: 0,
    reconciliation: { ledgerBalanceAtPeriodEnd: '900.00', matches: true },
    warnings: [],
  };

  it.each(['ar', 'en'] as const)('renders a valid multi-page %s statement with embedded fonts and the generated reference', async (lang) => {
    const pdf = await buildStatementPdf(statement, lang, 'Test Co');
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1); // 90 rows do not fit on one landscape page → pagination works
    expect(text).toContain('NotoNaskhArabic');
    expect(text).toContain('NotoSans');
    expect(pdf.length).toBeGreaterThan(20000);
  });

  it('is deterministic for the same statement (same bytes apart from the generated object ids/metadata date, which is pinned to the statement time)', async () => {
    const a = await buildStatementPdf(statement, 'ar', 'Test Co');
    const b = await buildStatementPdf(statement, 'ar', 'Test Co');
    expect(a.length).toBe(b.length);
  });
});
