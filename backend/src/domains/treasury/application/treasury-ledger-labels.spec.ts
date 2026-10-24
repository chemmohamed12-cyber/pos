import { LedgerClassifiable, classifyLedgerRow, countsInTotals, directionOf, summarize } from './treasury-ledger-labels';
import { KIND_SQL, TreasuryLedgerReportService } from './treasury-ledger-report.service';

const base: LedgerClassifiable = {
  type: 'cash_in',
  reason: null,
  reference: null,
  customerId: null,
  supplierId: null,
  employeeId: null,
  depositId: null,
  reversalOfTransactionId: null,
};
const row = (o: Partial<LedgerClassifiable>): LedgerClassifiable => ({ ...base, ...o });

describe('treasury ledger business labels (hotfix)', () => {
  it('maps each real posting origin to its business kind', () => {
    expect(classifyLedgerRow(row({ reason: 'Customer deposit', depositId: 'd' }))).toBe('customer_deposit');
    expect(classifyLedgerRow(row({ reason: 'customer_payment', reference: 'inv' }))).toBe('customer_payment_invoice');
    expect(classifyLedgerRow(row({ reason: 'customer_payment' }))).toBe('customer_payment_on_account');
    expect(classifyLedgerRow(row({ reason: 'cod_collection_custody' }))).toBe('cod_collection');
    expect(classifyLedgerRow(row({ reason: 'shipping_collection_remittance' }))).toBe('cod_remittance');
    expect(classifyLedgerRow(row({ type: 'cash_out', reason: 'supplier_payment', supplierId: 's' }))).toBe('supplier_payment');
    expect(classifyLedgerRow(row({ type: 'cash_out', reason: 'payroll_disbursement', employeeId: 'e' }))).toBe('payroll_disbursement');
  });

  it('never invents a business meaning for manual or unknown rows', () => {
    expect(classifyLedgerRow(row({ reason: 'anything typed by a user' }))).toBe('cash_receipt');
    expect(classifyLedgerRow(row({ type: 'cash_out', reason: 'anything typed by a user' }))).toBe('cash_disbursement');
  });

  it('treats both transfer legs (incl. shipping_collection_settlement) as transfers and reversal legs as reversals', () => {
    expect(classifyLedgerRow(row({ type: 'transfer_out', reason: 'shipping_collection_settlement' }))).toBe('transfer');
    expect(classifyLedgerRow(row({ type: 'transfer_in', reason: 'shipping_collection_settlement' }))).toBe('transfer');
    expect(classifyLedgerRow(row({ type: 'cash_out', reversalOfTransactionId: 'x', reason: 'Reversal: typo' }))).toBe('reversal');
  });

  it('keeps transfers, reversed rows and reversal legs out of receipt/payment totals (no double counting)', () => {
    const rows = [
      { kind: 'customer_deposit' as const, status: 'posted', direction: 1 as const, amount: '10.00' },
      { kind: 'supplier_payment' as const, status: 'posted', direction: -1 as const, amount: '4.25' },
      { kind: 'transfer' as const, status: 'posted', direction: -1 as const, amount: '8.00' },
      { kind: 'transfer' as const, status: 'posted', direction: 1 as const, amount: '8.00' },
      { kind: 'cash_receipt' as const, status: 'reversed', direction: 1 as const, amount: '2.00' },
      { kind: 'reversal' as const, status: 'posted', direction: -1 as const, amount: '2.00' },
    ];
    expect(summarize(rows)).toEqual({ receipts: '10.00', payments: '4.25', net: '5.75', transferCount: 2, reversedCount: 1 });
    expect(countsInTotals('transfer', 'posted')).toBe(false);
    expect(countsInTotals('cod_collection', 'posted')).toBe(true);
  });

  it('sums in exact cents', () => {
    const rows = Array.from({ length: 10 }, () => ({ kind: 'cash_receipt' as const, status: 'posted', direction: 1 as const, amount: '0.10' }));
    expect(summarize(rows).receipts).toBe('1.00');
  });

  it('direction follows the leg type', () => {
    expect(directionOf('cash_in')).toBe(1);
    expect(directionOf('transfer_in')).toBe(1);
    expect(directionOf('cash_out')).toBe(-1);
    expect(directionOf('transfer_out')).toBe(-1);
  });

  it('the SQL classifier covers every kind the TypeScript classifier can return', () => {
    for (const k of ['reversal', 'transfer', 'customer_deposit', 'customer_payment_invoice', 'customer_payment_on_account', 'cod_collection', 'cod_remittance', 'cash_receipt', 'supplier_payment', 'payroll_disbursement', 'cash_disbursement']) {
      expect(KIND_SQL).toContain(`'${k}'`);
    }
  });
});

describe('treasury ledger filters and scope (hotfix)', () => {
  const svc = new TreasuryLedgerReportService(undefined as never, undefined as never);

  it('always restricts to the caller-allowed accounts, even with no filters', () => {
    const { where, params } = svc.buildWhere({}, ['a1', 'a2']);
    expect(where).toContain('ANY($1::uuid[])');
    expect(params[0]).toEqual(['a1', 'a2']);
  });

  it('turns each filter into a bound parameter (never string-concatenated user input)', () => {
    const { where, params } = svc.buildWhere({ from: '2026-10-01', to: '2026-10-31', accountId: 'acc', status: 'posted', family: 'receipt', kind: 'customer_deposit', search: "x' OR 1=1 --" }, ['acc']);
    expect(params).toEqual([['acc'], '2026-10-01', '2026-10-31', 'acc', 'posted', 'customer_deposit', "%x' OR 1=1 --%"]);
    expect(where).not.toContain('OR 1=1');
  });

  it('the report summary and the export use the same filter builder (export scope = all matching rows)', () => {
    const src = TreasuryLedgerReportService.prototype.export.toString();
    expect(src).toContain('this.report(userId, filters, null');
  });
});
