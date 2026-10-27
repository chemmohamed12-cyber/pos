/**
 * Treasury Hotfix — business meaning of a `treasury_transactions` row.
 *
 * Classification is derived ONLY from fields the posting code already writes (`type`, `reason`,
 * `reference`, the party/document ids, `reversalOfTransactionId`); nothing is inferred beyond that.
 * A row that matches no known origin is `cash_receipt` / `cash_disbursement` (a manual entry) —
 * never a guessed business meaning.
 */
export type LedgerKind =
  | 'customer_deposit'
  | 'customer_payment_invoice'
  | 'customer_payment_on_account'
  | 'cod_collection'
  | 'cod_remittance'
  | 'supplier_payment'
  | 'payroll_disbursement'
  | 'cash_receipt'
  | 'cash_disbursement'
  | 'transfer'
  | 'reversal';

export interface LedgerClassifiable {
  type: 'cash_in' | 'cash_out' | 'transfer_in' | 'transfer_out';
  reason: string | null;
  reference: string | null;
  customerId: string | null;
  supplierId: string | null;
  employeeId: string | null;
  depositId: string | null;
  reversalOfTransactionId: string | null;
}

export const LEDGER_KIND_LABELS: Record<LedgerKind, { ar: string; en: string }> = {
  customer_deposit: { ar: 'عربون عميل', en: 'Customer deposit' },
  customer_payment_invoice: { ar: 'دفعة عميل على فاتورة', en: 'Customer payment (invoice)' },
  customer_payment_on_account: { ar: 'دفعة عميل على الحساب', en: 'Customer payment (on account)' },
  cod_collection: { ar: 'تحصيل عند التسليم (عهدة)', en: 'COD collection (custody)' },
  cod_remittance: { ar: 'توريد تحصيل شحنة', en: 'COD remittance' },
  supplier_payment: { ar: 'سداد مورد', en: 'Supplier payment' },
  payroll_disbursement: { ar: 'صرف رواتب', en: 'Payroll disbursement' },
  cash_receipt: { ar: 'قبض نقدي', en: 'Cash receipt' },
  cash_disbursement: { ar: 'صرف نقدي', en: 'Cash disbursement' },
  transfer: { ar: 'تحويل بين حسابات الخزينة', en: 'Treasury transfer' },
  reversal: { ar: 'عكس حركة', en: 'Reversal' },
};

export const NOT_SPECIFIED = { ar: 'غير محدد', en: 'Not specified' };

export function classifyLedgerRow(r: LedgerClassifiable): LedgerKind {
  if (r.reversalOfTransactionId) return 'reversal';
  if (r.type === 'transfer_in' || r.type === 'transfer_out') return 'transfer';
  const isIn = r.type === 'cash_in';
  if (isIn) {
    if (r.depositId || r.reason === 'Customer deposit') return 'customer_deposit';
    if (r.reason === 'customer_payment') return r.reference ? 'customer_payment_invoice' : 'customer_payment_on_account';
    if (r.reason === 'cod_collection_custody') return 'cod_collection';
    if (r.reason === 'shipping_collection_remittance') return 'cod_remittance';
    return 'cash_receipt';
  }
  if (r.reason === 'supplier_payment' || (r.supplierId && r.reason !== 'payroll_disbursement')) return 'supplier_payment';
  if (r.reason === 'payroll_disbursement') return 'payroll_disbursement';
  return 'cash_disbursement';
}

/** Direction of the row on its own account: +1 money in, -1 money out. */
export function directionOf(type: LedgerClassifiable['type']): 1 | -1 {
  return type === 'cash_in' || type === 'transfer_in' ? 1 : -1;
}

/** Only these rows are real receipts/payments in summary totals: posted, not a transfer leg, not a reversal leg. */
export function countsInTotals(kind: LedgerKind, status: string): boolean {
  return status === 'posted' && kind !== 'transfer' && kind !== 'reversal';
}

export interface LedgerSummary {
  receipts: string;
  payments: string;
  net: string;
  transferCount: number;
  reversedCount: number;
}

/**
 * Totals per account-currency are not possible (the Treasury ledger carries no currency column), so the
 * summary is a single figure set in the company's base currency and the report states that scope.
 * Uses integer cents so the sums are exact.
 */
export function summarize(rows: Array<{ kind: LedgerKind; status: string; direction: 1 | -1; amount: string }>): LedgerSummary {
  let inC = 0;
  let outC = 0;
  let transfers = 0;
  let reversed = 0;
  for (const r of rows) {
    const cents = Math.round(Number(r.amount) * 100);
    if (r.status === 'reversed') reversed++;
    if (r.kind === 'transfer') transfers++;
    if (!countsInTotals(r.kind, r.status)) continue;
    if (r.direction === 1) inC += cents;
    else outC += cents;
  }
  const f = (c: number) => (c / 100).toFixed(2);
  return { receipts: f(inC), payments: f(outC), net: f(inC - outC), transferCount: transfers, reversedCount: reversed };
}
