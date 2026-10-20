import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useAutoRefresh } from '../../lib/useAutoRefresh';
import { RefreshStamp, PostingStatusChip } from '../../components/RefreshStamp';

interface UninvoicedOrderRef {
  purchaseOrderId: string;
  poNumber: string;
  supplierName: string | null;
  uninvoicedValue: string;
  receipts: Array<{ id: string; grNumber: string }>;
}

interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
}
interface LedgerLineRow {
  journalEntryId: string;
  entryNumber: string | null;
  businessDate: string;
  description: string | null;
  sourceType: string;
  lineDescription: string | null;
  debitBase: string;
  creditBase: string;
  runningBalanceBase: string;
  entryState?: string | null;
  financialEventId?: string | null;
  eventType?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
}
interface AccountLedger {
  account: { id: string; code: string; name: string; accountType: string; normalBalance: string };
  openingBalanceBase: string;
  periodDebitBase: string;
  periodCreditBase: string;
  closingBalanceBase: string;
  lines: LedgerLineRow[];
}

/**
 * What opens under a ledger row: the journal entry, and - for a goods receipt - its purchase order and goods receipt with a blue "Create invoice" button that opens the supplier-invoice form on
 * that order. The receipt is found in the goods-received-not-invoiced list (scope-filtered by the server); a receipt that is already fully invoiced simply has no button.
 */
function LedgerRowDetail({ line, ar, canInvoice, uninvoiced }: { line: LedgerLineRow; ar: boolean; canInvoice: boolean; uninvoiced: UninvoicedOrderRef[] | null | undefined }) {
  const navigate = useNavigate();
  const L = (a: string, e: string) => (ar ? a : e);
  const order = line.referenceType === 'goods_receipt' && line.referenceId ? (uninvoiced ?? []).find((o) => o.receipts.some((r) => r.id === line.referenceId)) : undefined;
  const receipt = order?.receipts.find((r) => r.id === line.referenceId);
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', padding: '6px 4px' }}>
      <Link to={`/accounting/journals/${line.journalEntryId}`}>
        {L('فتح القيد', 'Open journal entry')} {line.entryNumber ?? ''}
      </Link>
      {line.referenceType === 'goods_receipt' &&
        (uninvoiced === undefined ? (
          <span style={{ opacity: 0.6 }}>…</span>
        ) : order ? (
          <>
            <Link to={`/purchase-orders?id=${order.purchaseOrderId}`}>
              {L('أمر الشراء', 'Purchase order')} {order.poNumber}
            </Link>
            <Link to={`/purchase-orders?id=${order.purchaseOrderId}`}>
              {L('إذن الاستلام', 'Goods receipt')} {receipt?.grNumber}
            </Link>
            <span>{order.supplierName ?? ''}</span>
            <span>
              {L('بضاعة بلا فاتورة', 'Not invoiced')}: {order.uninvoicedValue}
            </span>
            {canInvoice && (
              <button className="btn btn-primary" onClick={() => navigate(`/supplier-invoices?purchaseOrderId=${order.purchaseOrderId}`)}>
                {L('إنشاء فاتورة', 'Create invoice')}
              </button>
            )}
          </>
        ) : (
          <span style={{ opacity: 0.7 }}>{L('هذا الاستلام مفوتر بالكامل أو غير متاح لك.', 'This receipt is fully invoiced or not available to you.')}</span>
        ))}
    </div>
  );
}

const PRELOAD = [
  'nav.general_ledger',
  'field.account_code',
  'field.opening_balance',
  'field.period_movement',
  'field.closing_balance',
  'field.business_date',
  'field.debit_base',
  'field.credit_base',
  'field.description',
  'field.entry_number',
  'field.from_date',
  'field.to_date',
  'field.gl_source',
  'field.gl_entry_state',
];

/** F03 — General Ledger read model. Account picker + date range, mirrors `TreasuryLedger.tsx`'s own filter shape. */
export function GeneralLedger() {
  const { t, preload, lang } = useLanguage();
  preload(PRELOAD);
  const { authz, can } = useAuth();
  const canInvoice = authz ? can('procurement.supplier_invoice.create', 'editable') : false;
  const [openRow, setOpenRow] = useState<string | null>(null);
  // goods received, not invoiced (loaded the first time a row is opened; null = the caller may not see it)
  const [uninvoiced, setUninvoiced] = useState<UninvoicedOrderRef[] | null | undefined>(undefined);
  function toggleRow(key: string) {
    setOpenRow((cur) => (cur === key ? null : key));
    if (uninvoiced === undefined) {
      api
        .get<{ orders: UninvoicedOrderRef[] }>('/procurement/goods-receipts/uninvoiced')
        .then((r) => setUninvoiced(r.orders))
        .catch(() => setUninvoiced(null));
    }
  }
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [accountId, setAccountId] = useState(searchParams.get('accountId') ?? '');
  const [from, setFrom] = useState(searchParams.get('from') ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? '');
  const [ledger, setLedger] = useState<AccountLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<GLAccount[]>('/accounting/accounts?postableOnly=true').then((a) => {
      setAccounts(a);
      if (!accountId && a[0]) setAccountId(a[0].id);
    }).catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useAutoRefresh(
    async (isCurrent) => {
      if (!accountId) return;
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      try {
        const data = await api.get<AccountLedger>(`/accounting/ledger/${accountId}${qs.toString() ? `?${qs}` : ''}`);
        if (!isCurrent()) return;
        setLedger(data);
        setError(null);
      } catch (err) {
        if (isCurrent()) setError(err instanceof ApiError ? err.message : 'Failed to load ledger.');
        throw err;
      }
    },
    [accountId, from, to],
  );

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.general_ledger')}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <PostingStatusChip />
          <RefreshStamp refresh={refresh} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>{t('field.account_code')}</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.nameAr ?? a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.from_date')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.to_date')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {ledger && (
        <>
          <div className="detail-grid" style={{ marginBottom: 20 }}>
            <div className="kpi-tile">
              <div className="label">{t('field.opening_balance')}</div>
              <div className="value">{ledger.openingBalanceBase}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.debit_base')}</div>
              <div className="value">{ledger.periodDebitBase}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.credit_base')}</div>
              <div className="value">{ledger.periodCreditBase}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.closing_balance')}</div>
              <div className="value">{ledger.closingBalanceBase}</div>
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.entry_number')}</th>
                <th>{t('field.business_date')}</th>
                <th>{t('field.description')}</th>
                <th>{t('field.gl_source')}</th>
                <th>{t('field.gl_entry_state')}</th>
                <th>{t('field.debit_base')}</th>
                <th>{t('field.credit_base')}</th>
                <th>{t('field.closing_balance')}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.lines.map((l, idx) => {
                const rowKey = `${l.journalEntryId}-${idx}`;
                return (
                <Fragment key={rowKey}>
                <tr style={{ cursor: 'pointer' }} onClick={() => toggleRow(rowKey)} title={lang === 'ar' ? 'اضغط لعرض التفاصيل' : 'Click for details'}>
                  <td>{l.entryNumber ?? '—'}</td>
                  <td>{l.businessDate}</td>
                  <td>{l.lineDescription ?? l.description ?? '—'}</td>
                  <td title={l.eventType ?? undefined}>{l.referenceType ? t(`reference_type.${l.referenceType}`) : l.sourceType}</td>
                  <td>{l.entryState ?? '—'}</td>
                  <td>{Number(l.debitBase) > 0 ? l.debitBase : ''}</td>
                  <td>{Number(l.creditBase) > 0 ? l.creditBase : ''}</td>
                  <td>{l.runningBalanceBase}</td>
                </tr>
                {openRow === rowKey && (
                  <tr>
                    <td colSpan={8} style={{ background: 'var(--surface-2, #f7f8fa)' }}>
                      <LedgerRowDetail line={l} ar={lang === 'ar'} canInvoice={canInvoice} uninvoiced={uninvoiced === null ? [] : uninvoiced} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
