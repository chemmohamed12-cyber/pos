/**
 * Customer account statement — the pure rules (no I/O), so every figure and label the statement shows is testable and documented in one place.
 *
 * Nothing here changes a ledger row: descriptions are generated AT READ TIME from the entry type, the structured links and the posting reason pattern; the stored
 * `reason` strings (historical English text) are never rewritten.
 */

export type StatementLang = 'ar' | 'en';

export interface Bilingual {
  ar: string;
  en: string;
}

export const NOT_SPECIFIED: Bilingual = { ar: 'غير محدد', en: 'Not specified' };

/** Business name of each ledger entry type. */
export const ENTRY_TYPE_NAMES: Record<string, Bilingual> = {
  sales_invoice: { ar: 'فاتورة مبيعات', en: 'Sales invoice' },
  deposit: { ar: 'عربون عميل', en: 'Customer deposit' },
  payment: { ar: 'دفعة عميل', en: 'Customer payment' },
  payment_application: { ar: 'تسوية دفعة على فاتورة', en: 'Payment applied to invoice' },
  payment_reversal: { ar: 'عكس دفعة', en: 'Payment reversal' },
  cod_collection: { ar: 'تحصيل عند التسليم', en: 'Collection on delivery' },
  return_credit_note: { ar: 'إشعار دائن مرتجع', en: 'Return credit note' },
  debit_note: { ar: 'إشعار مدين', en: 'Debit note' },
  adjustment: { ar: 'تسوية', en: 'Adjustment' },
  opening_balance: { ar: 'رصيد افتتاحي', en: 'Opening balance' },
  refund: { ar: 'رد مبلغ للعميل', en: 'Refund to customer' },
};

const METHOD_NAMES: Record<string, Bilingual> = {
  cash: { ar: 'نقدًا', en: 'cash' },
  wallet: { ar: 'محفظة إلكترونية', en: 'wallet' },
  bank_transfer: { ar: 'تحويل بنكي', en: 'bank transfer' },
  cheque: { ar: 'شيك', en: 'cheque' },
  check: { ar: 'شيك', en: 'cheque' },
  card: { ar: 'بطاقة', en: 'card' },
  transfer: { ar: 'تحويل', en: 'transfer' },
};

export interface DescribableEntry {
  entryType: string;
  direction: 'debit' | 'credit';
  reason: string | null;
  reversalOfEntryId: string | null;
}

export interface DescribeDocs {
  invoiceNumber?: string | null;
  paymentNumber?: string | null;
  orderNumber?: string | null;
  waybillNumber?: string | null;
  reference?: string | null;
}

function methodOf(reason: string | null): Bilingual | null {
  const m = /\(([a-z_]+)\)\s*$/i.exec(reason ?? '');
  if (!m) return null;
  return METHOD_NAMES[m[1].toLowerCase()] ?? { ar: m[1], en: m[1] };
}

/** The business sentence of one statement line, in both languages. Only parts present in the source are included; nothing is invented. */
export function describeEntry(e: DescribableEntry, docs: DescribeDocs = {}): Bilingual {
  const base = ENTRY_TYPE_NAMES[e.entryType] ?? { ar: NOT_SPECIFIED.ar, en: e.entryType };
  const reason = e.reason ?? '';
  let ar = base.ar;
  let en = base.en;
  const method = methodOf(e.reason);

  if (e.reversalOfEntryId) {
    ar = 'عكس قيد';
    en = 'Entry reversal';
    const note = /^Reversal:\s*(.+)$/i.exec(reason)?.[1];
    if (note) {
      ar += `: ${note}`;
      en += `: ${note}`;
    }
  } else if (e.entryType === 'payment') {
    if (/^On-account payment/i.test(reason)) {
      ar = 'دفعة على الحساب';
      en = 'On-account payment';
    } else {
      ar = 'دفعة على فاتورة';
      en = 'Payment against invoice';
    }
    if (method) {
      ar += ` (${method.ar})`;
      en += ` (${method.en})`;
    }
  } else if (e.entryType === 'deposit' || e.entryType === 'cod_collection') {
    if (method) {
      ar += ` (${method.ar})`;
      en += ` (${method.en})`;
    }
    if (e.entryType === 'cod_collection') {
      ar += ' — مورَّد';
      en += ' — remitted';
    }
  } else if (e.entryType === 'sales_invoice') {
    ar = 'فاتورة مبيعات مرحّلة';
    en = 'Sales invoice posted';
  } else if (e.entryType === 'payment_application') {
    ar = e.direction === 'debit' ? 'تسوية دفعة: خصم من الرصيد غير المطبّق' : 'تسوية دفعة: تطبيق على الفاتورة';
    en = e.direction === 'debit' ? 'Payment application: taken from unapplied balance' : 'Payment application: applied to invoice';
  } else if (e.entryType === 'payment_reversal') {
    ar = 'عكس دفعة';
    en = 'Payment reversal';
    const note = /:\s*([^:(]+?)(?:\s*\(.*\))?$/.exec(reason)?.[1]?.trim();
    if (note) {
      ar += `: ${note}`;
      en += `: ${note}`;
    }
  } else if (e.entryType === 'return_credit_note') {
    if (/Return credit applied to invoice/i.test(reason)) {
      ar = 'تطبيق رصيد مرتجع على فاتورة';
      en = 'Return credit applied to invoice';
    } else if (/^Shipment return/i.test(reason)) {
      ar = 'إشعار دائن — مرتجع شحنة';
      en = 'Credit note — shipment return';
    } else {
      ar = 'إشعار دائن — مرتجع مبيعات';
      en = 'Credit note — sales return';
    }
  } else if (e.entryType === 'adjustment' || e.entryType === 'debit_note' || e.entryType === 'opening_balance') {
    const note = /^AR [a-z_]+:\s*(.+)$/i.exec(reason)?.[1];
    if (note) {
      ar += `: ${note}`;
      en += `: ${note}`;
    }
  }

  const docBits: string[] = [];
  const docBitsEn: string[] = [];
  if (docs.invoiceNumber) {
    docBits.push(`فاتورة ${docs.invoiceNumber}`);
    docBitsEn.push(`invoice ${docs.invoiceNumber}`);
  }
  if (docs.paymentNumber) {
    docBits.push(`إيصال ${docs.paymentNumber}`);
    docBitsEn.push(`receipt ${docs.paymentNumber}`);
  }
  if (docs.orderNumber) {
    docBits.push(`أمر بيع ${docs.orderNumber}`);
    docBitsEn.push(`order ${docs.orderNumber}`);
  }
  if (docs.waybillNumber) {
    docBits.push(`بوليصة ${docs.waybillNumber}`);
    docBitsEn.push(`waybill ${docs.waybillNumber}`);
  }
  if (docBits.length) {
    ar += ` — ${docBits.join(' / ')}`;
    en += ` — ${docBitsEn.join(' / ')}`;
  }
  return { ar, en };
}

// ---------------------------------------------------------------------------------------------------------------------
// Amounts — integer cents, so sums are exact.
// ---------------------------------------------------------------------------------------------------------------------

export const toCents = (v: string | number): number => Math.round(Number(v) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);

export interface RunningInput {
  direction: 'debit' | 'credit';
  amount: string;
}

/** Running balance after each row, starting from the opening balance. Debit increases what the customer owes, credit decreases it. Pure and order-preserving. */
export function runningBalances(opening: string, rows: RunningInput[]): string[] {
  let c = toCents(opening);
  return rows.map((r) => {
    c += r.direction === 'debit' ? toCents(r.amount) : -toCents(r.amount);
    return fromCents(c);
  });
}

export function periodTotals(rows: RunningInput[]): { debit: string; credit: string } {
  let d = 0;
  let c = 0;
  for (const r of rows) {
    if (r.direction === 'debit') d += toCents(r.amount);
    else c += toCents(r.amount);
  }
  return { debit: fromCents(d), credit: fromCents(c) };
}

/** closing = opening + Σdebit − Σcredit (the ledger formula over the period). */
export function closingBalance(opening: string, totals: { debit: string; credit: string }): string {
  return fromCents(toCents(opening) + toCents(totals.debit) - toCents(totals.credit));
}

// ---------------------------------------------------------------------------------------------------------------------
// Aging (D5). Definitions:
//   * due day            = the invoice's `dueDate` (a calendar date, UTC).
//   * as-of day          = the statement/report date (a calendar date, UTC) — never a clock instant, so the result does not depend on the time of day.
//   * days past due      = max(0, asOfDay − dueDay) in whole calendar days. An invoice due TODAY is 0 days past due (not overdue); it becomes overdue tomorrow.
//   * not yet due        = no due date, or due day ≥ as-of day. Shown separately inside the first band so the "0–30" band can be read as "current + 1–30".
//   * bands              = 0–30, 31–60, 61–90, 90+ (boundaries inclusive: 30 → 0–30, 31 → 31–60, 60 → 31–60, 61 → 61–90, 90 → 61–90, 91 → 90+).
// ---------------------------------------------------------------------------------------------------------------------

export type AgingBand = '0-30' | '31-60' | '61-90' | '90+';
export const AGING_BANDS: AgingBand[] = ['0-30', '31-60', '61-90', '90+'];

const DAY_MS = 86_400_000;

/** Whole UTC calendar days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

export function daysPastDue(dueDate: string | null, asOf: string): number {
  if (!dueDate) return 0;
  return Math.max(0, dayDiff(dueDate, asOf));
}

export function bandOf(days: number): AgingBand {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export interface AgingInput {
  remaining: string;
  dueDate: string | null;
}

export interface AgingResult {
  bands: Record<AgingBand, string>;
  notYetDue: string;
  overdue: string;
  totalOpen: string;
}

export function ageInvoices(rows: AgingInput[], asOf: string): AgingResult {
  const sums: Record<AgingBand, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let notDue = 0;
  let overdue = 0;
  let total = 0;
  for (const r of rows) {
    const cents = toCents(r.remaining);
    if (cents <= 0) continue;
    total += cents;
    const days = daysPastDue(r.dueDate, asOf);
    sums[bandOf(days)] += cents;
    if (days === 0) notDue += cents;
    else overdue += cents;
  }
  return {
    bands: { '0-30': fromCents(sums['0-30']), '31-60': fromCents(sums['31-60']), '61-90': fromCents(sums['61-90']), '90+': fromCents(sums['90+']) },
    notYetDue: fromCents(notDue),
    overdue: fromCents(overdue),
    totalOpen: fromCents(total),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Generated statement reference (D4): descriptive and stable for one generated copy. NOT an issued-document register entry.
// ---------------------------------------------------------------------------------------------------------------------

export function statementReference(customerCode: string, from: string | null, to: string | null, generatedAtIso: string, digest: string): string {
  const compact = generatedAtIso.slice(0, 16).replace(/[-:T]/g, '');
  const f = (from ?? 'START').replace(/-/g, '');
  const t = (to ?? 'TODAY').replace(/-/g, '');
  return `ST-${customerCode}-${f}-${t}-${compact}-${digest.slice(0, 8).toUpperCase()}`;
}
