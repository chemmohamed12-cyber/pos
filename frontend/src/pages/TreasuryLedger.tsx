import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, downloadBlob, newIdempotencyKey } from '../lib/api';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { FinancialStatusCell, FinancialTrace } from '../components/FinancialTrace';
import { fmtDateTime } from '../lib/formatDateTime';
import { loadingLabel } from '../lib/displayNames';

interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  balance: string;
}

interface ReportRow {
  id: string;
  transactionNumber: string;
  movementDate: string;
  kind: string;
  kindLabelAr: string;
  kindLabelEn: string;
  type: string;
  direction: 1 | -1;
  amount: string;
  status: 'posted' | 'reversed';
  accountId: string;
  accountCode: string;
  accountName: string;
  partyType: 'customer' | 'supplier' | 'employee' | null;
  partyCode: string | null;
  partyName: string | null;
  description: string;
  reason: string | null;
  documentNumber: string | null;
  documentLink: string | null;
}
interface ReportSummary {
  receipts: string;
  payments: string;
  net: string;
  transferCount: number;
  reversedCount: number;
}
interface RelatedRow {
  id: string;
  transactionNumber: string;
  type: string;
  amount: string;
  status: string;
  movementDate: string;
  reason: string | null;
}
interface DetailRow extends ReportRow {
  technicalId: string;
  reference: string | null;
  createdByName: string | null;
  createdAt: string;
  reversalOfTransactionId: string | null;
  related: RelatedRow[];
}

const KINDS: Array<[string, string, string]> = [
  ['customer_deposit', 'عربون عميل', 'Customer deposit'],
  ['customer_payment_invoice', 'دفعة عميل على فاتورة', 'Customer payment (invoice)'],
  ['customer_payment_on_account', 'دفعة عميل على الحساب', 'Customer payment (on account)'],
  ['cod_collection', 'تحصيل عند التسليم (عهدة)', 'COD collection (custody)'],
  ['cod_remittance', 'توريد تحصيل شحنة', 'COD remittance'],
  ['supplier_payment', 'سداد مورد', 'Supplier payment'],
  ['payroll_disbursement', 'صرف رواتب', 'Payroll disbursement'],
  ['cash_receipt', 'قبض نقدي', 'Cash receipt'],
  ['cash_disbursement', 'صرف نقدي', 'Cash disbursement'],
  ['transfer', 'تحويل بين الحسابات', 'Treasury transfer'],
  ['reversal', 'عكس حركة', 'Reversal'],
];
const PAGE_SIZE = 50;

type OperationMode = 'cash_in' | 'cash_out' | 'transfer' | null;

/** Financial/Treasury Core — the Ledger. Manual Cash In/Out/Transfer plus Reverse; no post-posting edits anywhere, only offsetting entries. */
export function TreasuryLedger() {
  const { t, preload } = useLanguage();
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [page, setPage] = useState(1);
  const [filterAccountId, setFilterAccountId] = useState(searchParams.get('accountId') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [family, setFamily] = useState('');
  const [kind, setKind] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<DetailRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<OperationMode>(null);
  const [accountId, setAccountId] = useState('');
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reverseBusyId, setReverseBusyId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState<Record<string, string>>({});

  preload([
    'panel.treasury_ledger',
    'field.treasury_account',
    'field.source_account',
    'field.destination_account',
    'field.transaction_type',
    'field.balance',
    'field.amount',
    'field.reference',
    'field.reason',
    'field.movement_date',
    'field.status',
    'action.cash_in',
    'action.cash_out',
    'action.transfer',
    'action.reverse',
    'action.cancel',
    'action.save',
    'treasury_txn_type.cash_in',
    'treasury_txn_type.cash_out',
    'treasury_txn_type.transfer_in',
    'treasury_txn_type.transfer_out',
  ]);

  async function loadAccounts() {
    try {
      setAccounts(await api.get<TreasuryAccount[]>('/treasury/accounts'));
    } catch (err) {
      // Foundation fix: no error handling — the account filter was silently left empty.
      setError(err instanceof ApiError ? err.message : 'Failed to load treasury accounts.');
    }
  }

  function filterQuery(extra: Record<string, string> = {}) {
    const p = new URLSearchParams();
    const entries: Record<string, string> = { from, to, accountId: filterAccountId, family, kind, status: statusFilter, search, ...extra };
    Object.entries(entries).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }

  async function loadLedger() {
    try {
      const r = await api.get<{ rows: ReportRow[]; total: number; summary: ReportSummary }>(`/treasury/ledger/report?${filterQuery({ page: String(page), pageSize: String(PAGE_SIZE) })}`);
      setRows(r.rows);
      setTotal(r.total);
      setSummary(r.summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the treasury ledger.');
    }
  }

  async function openDetail(id: string) {
    try {
      setDetail(await api.get<DetailRow>(`/treasury/transactions/${id}/details`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the movement details.');
    }
  }

  async function exportAs(format: 'xlsx' | 'csv') {
    setExporting(true);
    setError(null);
    try {
      const blob = await downloadBlob(`/treasury/ledger/export?${filterQuery({ format })}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `treasury-ledger-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAccountId, from, to, family, kind, statusFilter, page]);

  // Free-text search is applied on Enter / the button, not per keystroke.
  function applySearch() {
    setPage(1);
    loadLedger();
  }

  // T2: one idempotency key per logical submission — regenerated when a form is opened/closed or after a success, KEPT across a failed attempt so a retry is safe.
  const idemKey = useRef<string>(newIdempotencyKey());
  useEffect(() => {
    idemKey.current = newIdempotencyKey();
  }, [mode]);

  function resetForm() {
    idemKey.current = newIdempotencyKey();
    setAccountId('');
    setDestinationAccountId('');
    setAmount('');
    setReference('');
    setReason('');
    setMode(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'cash_in') {
        await api.post('/treasury/cash-in', { accountId, amount, reference: reference || undefined, reason: reason || undefined }, { idempotencyKey: idemKey.current });
      } else if (mode === 'cash_out') {
        await api.post('/treasury/cash-out', { accountId, amount, reference: reference || undefined, reason: reason || undefined }, { idempotencyKey: idemKey.current });
      } else if (mode === 'transfer') {
        await api.post(
          '/treasury/transfer',
          {
            sourceAccountId: accountId,
            destinationAccountId,
            amount,
            reference: reference || undefined,
            reason: reason || undefined,
          },
          { idempotencyKey: idemKey.current },
        );
      }
      resetForm();
      await Promise.all([loadAccounts(), loadLedger()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function reverse(txnId: string) {
    const r = reverseReason[txnId]?.trim();
    if (!r) return;
    setReverseBusyId(txnId);
    setError(null);
    try {
      await api.post(`/treasury/transactions/${txnId}/reverse`, { reason: r });
      await Promise.all([loadAccounts(), loadLedger()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reverse transaction.');
    } finally {
      setReverseBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('panel.treasury_ledger')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: mode ? 16 : 0 }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.treasury_account')}</label>
            <select value={filterAccountId} onChange={(e) => setFilterAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name} ({a.balance})
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-secondary" type="button" onClick={() => setMode(mode === 'cash_in' ? null : 'cash_in')}>
            {t('action.cash_in')}
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => setMode(mode === 'cash_out' ? null : 'cash_out')}>
            {t('action.cash_out')}
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => setMode(mode === 'transfer' ? null : 'transfer')}>
            {t('action.transfer')}
          </button>
        </div>

        {mode && (
          <form onSubmit={submit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t(mode === 'transfer' ? 'field.source_account' : 'field.treasury_account')}</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                <option value="">—</option>
                {accounts
                  .filter((a) => a.status === 'active')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name} ({a.balance})
                    </option>
                  ))}
              </select>
            </div>
            {mode === 'transfer' && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
                <label>{t('field.destination_account')}</label>
                <select value={destinationAccountId} onChange={(e) => setDestinationAccountId(e.target.value)} required>
                  <option value="">—</option>
                  {accounts
                    .filter((a) => a.status === 'active' && a.id !== accountId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.amount')}</label>
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.reference')}</label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} required={mode === 'cash_in' || mode === 'cash_out'} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.reason')}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} required={mode === 'cash_in' || mode === 'cash_out'} minLength={mode === 'cash_in' || mode === 'cash_out' ? 3 : undefined} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={resetForm}>
              {t('action.cancel')}
            </button>
          </form>
        )}
      </div>

      <div className="card ledger-filters" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'من تاريخ' : 'From'}</label>
            <input type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'إلى تاريخ' : 'To'}</label>
            <input type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'الاتجاه' : 'Direction'}</label>
            <select value={family} onChange={(e) => { setPage(1); setFamily(e.target.value); }}>
              <option value="">{ar ? 'الكل' : 'All'}</option>
              <option value="receipt">{ar ? 'قبض' : 'Receipt'}</option>
              <option value="payment">{ar ? 'صرف' : 'Payment'}</option>
              <option value="transfer">{ar ? 'تحويل' : 'Transfer'}</option>
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{ar ? 'نوع الحركة' : 'Movement type'}</label>
            <select value={kind} onChange={(e) => { setPage(1); setKind(e.target.value); }}>
              <option value="">{ar ? 'الكل' : 'All'}</option>
              {KINDS.map(([k, a, e]) => (
                <option key={k} value={k}>{ar ? a : e}</option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.status')}</label>
            <select value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}>
              <option value="">{ar ? 'الكل' : 'All'}</option>
              <option value="posted">{ar ? 'مرحّلة' : 'Posted'}</option>
              <option value="reversed">{ar ? 'معكوسة' : 'Reversed'}</option>
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{ar ? 'بحث' : 'Search'}</label>
            <input
              value={search}
              placeholder={ar ? 'رقم المستند أو اسم الطرف' : 'Document number or party name'}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            />
          </div>
          <button className="btn btn-secondary" type="button" onClick={applySearch}>{ar ? 'بحث' : 'Search'}</button>
          <button className="btn btn-secondary" type="button" disabled={exporting} onClick={() => exportAs('xlsx')}>Excel</button>
          <button className="btn btn-secondary" type="button" disabled={exporting} onClick={() => exportAs('csv')}>CSV</button>
          <button className="btn btn-secondary" type="button" onClick={() => window.print()}>{ar ? 'طباعة / PDF' : 'Print / PDF'}</button>
        </div>
        <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: 8 }}>
          {ar
            ? 'التصدير يشمل كل الحركات المطابقة للفلاتر (وليس الصفحة المعروضة فقط). الإجماليات تستثني التحويلات بين الحسابات والحركات المعكوسة، وكلها بعملة الشركة الأساسية.'
            : 'Exports include ALL movements matching the filters (not just this page). Totals exclude inter-account transfers and reversed movements; all amounts are in the company base currency.'}
        </div>
      </div>

      {summary && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <div className="kpi-tile"><div className="label">{ar ? 'إجمالي المقبوضات' : 'Total receipts'}</div><div className="value" style={{ color: '#166534' }}>{summary.receipts}</div></div>
          <div className="kpi-tile"><div className="label">{ar ? 'إجمالي المدفوعات' : 'Total payments'}</div><div className="value" style={{ color: '#a3262d' }}>{summary.payments}</div></div>
          <div className="kpi-tile"><div className="label">{ar ? 'صافي الحركة' : 'Net movement'}</div><div className="value">{summary.net}</div></div>
          <div className="kpi-tile"><div className="label">{ar ? 'عدد الحركات' : 'Movements'}</div><div className="value">{total}</div></div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      {rows === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">—</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{ar ? 'التاريخ والوقت' : 'Date / time'}</th>
                <th>{ar ? 'رقم الحركة' : 'Movement no.'}</th>
                <th>{ar ? 'نوع الحركة' : 'Type'}</th>
                <th>{ar ? 'الطرف' : 'Party'}</th>
                <th>{ar ? 'البيان والسبب' : 'Description'}</th>
                <th>{t('field.treasury_account')}</th>
                <th>{ar ? 'المبلغ' : 'Amount'}</th>
                <th>{t('field.status')}</th>
                <th>{ar ? 'المستند' : 'Document'}</th>
                <th>{t('field.financial_status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => openDetail(r.id)} style={{ cursor: 'pointer' }}>
                  <td>{fmtDateTime(r.movementDate)}</td>
                  <td>{r.transactionNumber}</td>
                  <td>{ar ? r.kindLabelAr : r.kindLabelEn}</td>
                  <td>{r.partyName ? `${r.partyName}${r.partyCode ? ` (${r.partyCode})` : ''}` : ar ? 'غير محدد' : 'Not specified'}</td>
                  <td>{r.description}</td>
                  <td>{r.accountCode} — {r.accountName}</td>
                  <td style={{ color: r.direction === 1 ? '#166534' : '#a3262d', whiteSpace: 'nowrap' }}>{r.direction === 1 ? '+' : '-'}{r.amount}</td>
                  <td><StatusBadge code={`warehouse_txn_state.${r.status}`} /></td>
                  <td>{r.documentNumber ?? (ar ? 'غير محدد' : 'Not specified')}</td>
                  <td onClick={(e) => e.stopPropagation()}><FinancialStatusCell id={r.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{ar ? 'السابق' : 'Previous'}</button>
            <span>{page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
            <button className="btn btn-secondary" disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage(page + 1)}>{ar ? 'التالي' : 'Next'}</button>
          </div>
        </div>
      )}

      {detail && (
        <div role="dialog" aria-label="movement-details" style={{ position: 'fixed', top: 0, bottom: 0, insetInlineEnd: 0, width: 'min(480px, 100%)', background: 'var(--card-bg, #fff)', boxShadow: '-4px 0 16px rgba(0,0,0,.2)', padding: 20, overflowY: 'auto', zIndex: 50 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{detail.transactionNumber}</h3>
            <button className="btn btn-secondary" onClick={() => setDetail(null)}>{ar ? 'إغلاق' : 'Close'}</button>
          </div>
          <div className="detail-grid" style={{ marginTop: 14 }}>
            <div className="detail-field"><div className="label">{ar ? 'نوع الحركة' : 'Type'}</div><div className="value">{ar ? detail.kindLabelAr : detail.kindLabelEn}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'التاريخ والوقت' : 'Date / time'}</div><div className="value">{fmtDateTime(detail.movementDate)}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'المبلغ والاتجاه' : 'Amount'}</div><div className="value">{detail.direction === 1 ? '+' : '-'}{detail.amount} ({detail.direction === 1 ? (ar ? 'قبض' : 'in') : ar ? 'صرف' : 'out'})</div></div>
            <div className="detail-field"><div className="label">{t('field.status')}</div><div className="value"><StatusBadge code={`warehouse_txn_state.${detail.status}`} /></div></div>
            <div className="detail-field"><div className="label">{t('field.treasury_account')}</div><div className="value">{detail.accountCode} — {detail.accountName}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'الطرف' : 'Party'}</div><div className="value">{detail.partyName ? `${detail.partyName}${detail.partyCode ? ` (${detail.partyCode})` : ''}` : ar ? 'غير محدد' : 'Not specified'}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'السبب المسجل' : 'Recorded reason'}</div><div className="value">{detail.reason ?? (ar ? 'غير محدد' : 'Not specified')}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'المستند المصدر' : 'Source document'}</div><div className="value">{detail.documentNumber ? (detail.documentLink ? <Link to={detail.documentLink}>{detail.documentNumber}</Link> : detail.documentNumber) : ar ? 'غير محدد' : 'Not specified'}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'أنشأها' : 'Created by'}</div><div className="value">{detail.createdByName ?? (ar ? 'غير محدد' : 'Not specified')} — {fmtDateTime(detail.createdAt)}</div></div>
            <div className="detail-field"><div className="label">{ar ? 'المرجع التقني (للتدقيق)' : 'Technical reference (audit)'}</div><div className="value" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{detail.technicalId}{detail.reference ? ` / ${detail.reference}` : ''}</div></div>
          </div>
          {detail.related.length > 0 && (
            <>
              <h4>{ar ? 'حركات مرتبطة (عكس / تحويل)' : 'Related movements (reversal / transfer)'}</h4>
              <ul>
                {detail.related.map((x) => (
                  <li key={x.id}>
                    <a href="#" onClick={(e) => { e.preventDefault(); openDetail(x.id); }}>{x.transactionNumber}</a> — {x.type} {x.amount} ({x.status})
                  </li>
                ))}
              </ul>
            </>
          )}
          <FinancialTrace ids={[detail.id]} />
          {detail.status === 'posted' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <input placeholder={t('field.reason')} value={reverseReason[detail.id] ?? ''} onChange={(e) => setReverseReason((prev) => ({ ...prev, [detail.id]: e.target.value }))} />
              <button
                className="btn btn-danger"
                disabled={reverseBusyId === detail.id || !reverseReason[detail.id]?.trim()}
                onClick={async () => {
                  await reverse(detail.id);
                  setDetail(null);
                }}
              >
                {t('action.reverse')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
