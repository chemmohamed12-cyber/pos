import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, downloadBlob } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { fmtDate } from '../lib/formatDateTime';
import { LedgerEntryDrawer } from '../components/LedgerEntryDrawer';

interface Bi {
  ar: string;
  en: string;
}
interface Customer {
  id: string;
  code: string;
  name: string;
}
interface Row {
  entryId: string;
  entryNumber: string;
  date: string;
  dueDate: string | null;
  entryType: string;
  typeLabel: Bi;
  description: Bi;
  documentType: string | null;
  documentNumber: string | null;
  documentLink: string | null;
  debit: string;
  credit: string;
  balance: string;
  status: 'posted' | 'reversed';
  isReversalLeg: boolean;
  nettedOut: boolean;
  flags: string[];
}
interface Statement {
  reference: string;
  referenceNote: Bi;
  generatedAt: string;
  customer: { id: string; code: string; name: string; phone: string | null; address: string | null; governorate: string | null; taxRegistrationNumber: string | null; creditLimit: string | null; paymentTermsDays: number | null };
  period: { from: string | null; to: string | null };
  currency: { code: string; note: Bi };
  isComplete: boolean;
  openingBalance: string;
  rows: Row[];
  totals: { debit: string; credit: string };
  totalsExcludingReversals: { debit: string; credit: string };
  filteredTotals: { debit: string; credit: string } | null;
  closingBalance: string;
  reversedCount: number;
  reconciliation: { ledgerBalanceAtPeriodEnd: string; matches: boolean };
  warnings: Array<{ code: string; ar: string; en: string; entryNumbers: string[] }>;
}

const TYPES: Array<[string, string, string]> = [
  ['sales_invoice', 'فاتورة مبيعات', 'Sales invoice'],
  ['payment', 'دفعة عميل', 'Customer payment'],
  ['deposit', 'عربون عميل', 'Customer deposit'],
  ['cod_collection', 'تحصيل عند التسليم', 'Collection on delivery'],
  ['return_credit_note', 'إشعار دائن مرتجع', 'Return credit note'],
  ['payment_application', 'تسوية دفعة على فاتورة', 'Payment applied to invoice'],
  ['payment_reversal', 'عكس دفعة', 'Payment reversal'],
  ['debit_note', 'إشعار مدين', 'Debit note'],
  ['adjustment', 'تسوية', 'Adjustment'],
  ['opening_balance', 'رصيد افتتاحي', 'Opening balance'],
  ['refund', 'رد مبلغ للعميل', 'Refund to customer'],
];

const money = (v: string) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The OFFICIAL customer account statement: a period statement computed on the server (opening balance before the period, whole last day included, deterministic order,
 * server-side running balance, closing balance reconciled with the ledger engine) with PDF / Excel / CSV / print output from the very same payload.
 */
export function CustomerStatement() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [params, setParams] = useSearchParams();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const customerId = params.get('customerId') ?? '';
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [entryType, setEntryType] = useState(params.get('entryType') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [statement, setStatement] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<string | null>(null);

  useEffect(() => {
    api.get<Customer[]>('/customers').then(setCustomers).catch(() => undefined);
  }, []);

  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    Object.entries({ from, to, entryType, status, ...extra }).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  };

  async function generate() {
    if (!customerId) return;
    setError(null);
    setBusy('load');
    try {
      setStatement(await api.get<Statement>(`/customer-finance/statement/${customerId}?${qs()}`));
    } catch (err) {
      setStatement(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load the statement.');
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    setStatement(null);
    if (customerId) generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function pickCustomer(id: string) {
    const next = new URLSearchParams(params);
    if (id) next.set('customerId', id);
    else next.delete('customerId');
    setParams(next);
  }

  async function file(format: 'pdf' | 'xlsx' | 'csv', docLang: 'ar' | 'en', mode: 'download' | 'print' = 'download') {
    if (!customerId) return;
    setBusy(`${format}-${docLang}`);
    setError(null);
    try {
      const blob = await downloadBlob(`/customer-finance/statement/${customerId}/export?${qs({ format, lang: docLang })}`);
      const url = URL.createObjectURL(blob);
      if (mode === 'print') {
        window.open(url, '_blank'); // the browser's PDF viewer prints with the same fonts and pagination
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = `customer-statement-${statement?.customer.code ?? customerId}-${docLang}.${format}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  const s = statement;
  return (
    <div>
      <div className="page-header">
        <h1>{ar ? 'كشف حساب العميل' : 'Customer account statement'}</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
            <label>{ar ? 'العميل' : 'Customer'}</label>
            <select value={customerId} onChange={(e) => pickCustomer(e.target.value)}>
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'من تاريخ' : 'From'}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'إلى تاريخ (شامل اليوم كاملًا)' : 'To (whole day included)'}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'نوع الحركة' : 'Movement type'}</label>
            <select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="">{ar ? 'الكل' : 'All'}</option>
              {TYPES.map(([k, a, e]) => (
                <option key={k} value={k}>
                  {ar ? a : e}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'الحالة' : 'Status'}</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{ar ? 'الكل' : 'All'}</option>
              <option value="posted">{ar ? 'مرحّلة' : 'Posted'}</option>
              <option value="reversed">{ar ? 'معكوسة' : 'Reversed'}</option>
            </select>
          </div>
          <button className="btn btn-primary" disabled={!customerId || busy === 'load'} onClick={generate}>
            {ar ? 'إعداد الكشف' : 'Generate'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>{ar ? 'إخراج الكشف (نفس الفترة والفلاتر):' : 'Output (same period and filters):'}</span>
          <button className="btn btn-secondary" disabled={!s || !!busy} onClick={() => file('pdf', ar ? 'ar' : 'en', 'print')}>
            {ar ? 'طباعة' : 'Print'}
          </button>
          <button className="btn btn-secondary" disabled={!s || !!busy} onClick={() => file('pdf', 'ar')}>PDF عربي</button>
          <button className="btn btn-secondary" disabled={!s || !!busy} onClick={() => file('pdf', 'en')}>PDF English</button>
          <button className="btn btn-secondary" disabled={!s || !!busy} onClick={() => file('xlsx', ar ? 'ar' : 'en')}>Excel</button>
          <button className="btn btn-secondary" disabled={!s || !!busy} onClick={() => file('csv', ar ? 'ar' : 'en')}>CSV</button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
      {!customerId && <div className="empty-state">{ar ? 'اختر عميلًا لإعداد كشف الحساب.' : 'Select a customer to prepare the statement.'}</div>}
      {customerId && !s && !error && <div className="empty-state">…</div>}

      {s && (
        <div className="card" id="statement-document">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>{s.customer.name}</h2>
              <div style={{ opacity: 0.8 }}>{s.customer.code}</div>
              {(s.customer.address || s.customer.governorate) && <div>{[s.customer.address, s.customer.governorate].filter(Boolean).join('، ')}</div>}
              <div style={{ fontSize: '0.9rem' }}>
                {s.customer.taxRegistrationNumber && <span>{ar ? 'الرقم الضريبي' : 'Tax no.'}: {s.customer.taxRegistrationNumber} · </span>}
                {s.customer.phone && <span>{ar ? 'الهاتف' : 'Phone'}: {s.customer.phone} · </span>}
                {s.customer.paymentTermsDays != null && <span>{ar ? 'شروط السداد' : 'Terms'}: {s.customer.paymentTermsDays} {ar ? 'يوم' : 'days'}</span>}
              </div>
            </div>
            <div style={{ fontSize: '0.9rem', textAlign: ar ? 'start' : 'end' }}>
              <div>
                <strong>{ar ? 'مرجع الكشف' : 'Statement ref.'}:</strong> {s.reference}
              </div>
              <div>
                <strong>{ar ? 'الفترة' : 'Period'}:</strong> {s.period.from ?? (ar ? 'من أول حركة' : 'from the first entry')} {ar ? 'إلى' : 'to'} {s.period.to ?? (ar ? 'حتى الآن' : 'to date')}
              </div>
              <div>
                <strong>{ar ? 'العملة' : 'Currency'}:</strong> {s.currency.code} · {ar ? 'تاريخ الإعداد' : 'Generated'}: {fmtDate(s.generatedAt)}
              </div>
              <div style={{ opacity: 0.7, maxWidth: 360 }}>{s.referenceNote[lang]}</div>
            </div>
          </div>

          {s.warnings.map((w) => (
            <div key={w.code} className="error-text" style={{ marginBottom: 8 }}>
              {w[lang]} ({w.entryNumbers.join(', ')})
            </div>
          ))}
          {!s.isComplete && (
            <div style={{ color: '#b45309', marginBottom: 8 }}>
              {ar ? 'عرض مصفّى بحسب النوع/الحالة: الأرصدة الجارية تخص الدفتر الكامل، والإجماليات للفترة كاملة.' : 'Filtered view: running balances belong to the full ledger, totals cover the whole period.'}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div className="kpi-tile"><div className="label">{ar ? 'الرصيد الافتتاحي' : 'Opening balance'}</div><div className="value">{money(s.openingBalance)}</div></div>
            <div className="kpi-tile"><div className="label">{ar ? 'إجمالي المدين' : 'Total debit'}</div><div className="value">{money(s.totals.debit)}</div></div>
            <div className="kpi-tile"><div className="label">{ar ? 'إجمالي الدائن' : 'Total credit'}</div><div className="value">{money(s.totals.credit)}</div></div>
            <div className="kpi-tile"><div className="label">{ar ? 'الرصيد الختامي' : 'Closing balance'}</div><div className="value">{money(s.closingBalance)}</div></div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{ar ? 'التاريخ' : 'Date'}</th>
                  <th>{ar ? 'نوع الحركة' : 'Type'}</th>
                  <th>{ar ? 'البيان' : 'Description'}</th>
                  <th>{ar ? 'رقم المستند' : 'Document'}</th>
                  <th>{ar ? 'الاستحقاق' : 'Due'}</th>
                  <th>{ar ? 'مدين' : 'Debit'}</th>
                  <th>{ar ? 'دائن' : 'Credit'}</th>
                  <th>{ar ? 'الرصيد' : 'Balance'}</th>
                  <th>{ar ? 'الحالة' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ background: 'rgba(100,116,139,.12)', fontWeight: 600 }}>
                  <td colSpan={7}>{ar ? 'الرصيد الافتتاحي' : 'Opening balance'}</td>
                  <td>{money(s.openingBalance)}</td>
                  <td />
                </tr>
                {s.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty-state">{ar ? 'لا توجد حركات في هذه الفترة.' : 'No movements in this period.'}</td>
                  </tr>
                )}
                {s.rows.map((r) => (
                  <tr key={r.entryId} onClick={() => setOpenEntry(r.entryId)} style={{ cursor: 'pointer', opacity: r.nettedOut ? 0.6 : 1 }} data-testid={`stmt-row-${r.entryNumber}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                    <td>{r.typeLabel[lang]}</td>
                    <td>
                      {r.description[lang]}
                      {r.flags.length > 0 && <span style={{ color: '#b91c1c' }}> ⚠</span>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.documentNumber ? r.documentLink ? <Link to={r.documentLink}>{r.documentNumber}</Link> : r.documentNumber : ar ? 'غير محدد' : '—'}
                    </td>
                    <td>{r.dueDate ?? ''}</td>
                    <td>{r.debit === '0.00' ? '' : money(r.debit)}</td>
                    <td>{r.credit === '0.00' ? '' : money(r.credit)}</td>
                    <td style={{ fontWeight: 600 }}>{money(r.balance)}</td>
                    <td>{r.status === 'reversed' ? (ar ? 'معكوس' : 'Reversed') : r.isReversalLeg ? (ar ? 'قيد عكس' : 'Reversal') : ar ? 'مرحّل' : 'Posted'}</td>
                  </tr>
                ))}
                <tr style={{ background: 'rgba(100,116,139,.18)', fontWeight: 700 }}>
                  <td colSpan={5}>{ar ? 'الرصيد الختامي' : 'Closing balance'}</td>
                  <td>{money(s.totals.debit)}</td>
                  <td>{money(s.totals.credit)}</td>
                  <td>{money(s.closingBalance)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: '0.85rem', opacity: 0.85 }}>
            <div>
              {ar ? 'بعد استبعاد المعكوس وقيود العكس' : 'Excluding reversed rows and reversal entries'}: {ar ? 'مدين' : 'debit'} {money(s.totalsExcludingReversals.debit)} · {ar ? 'دائن' : 'credit'} {money(s.totalsExcludingReversals.credit)} · {ar ? 'عدد الحركات المعكوسة' : 'reversed rows'}: {s.reversedCount}
            </div>
            <div>
              {ar ? 'مطابقة الرصيد مع دفتر العميل' : 'Reconciled with the customer ledger'}:{' '}
              <strong style={{ color: s.reconciliation.matches ? '#166534' : '#b91c1c' }}>
                {s.reconciliation.matches ? (ar ? 'مطابق' : 'matches') : ar ? 'غير مطابق' : 'MISMATCH'} ({money(s.reconciliation.ledgerBalanceAtPeriodEnd)})
              </strong>
            </div>
            <div>{s.currency.note[lang]}</div>
          </div>
        </div>
      )}

      {openEntry && <LedgerEntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpen={setOpenEntry} onChanged={generate} />}
    </div>
  );
}
