import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { loadingLabel } from '../../lib/displayNames';
import { DocStatusBadge, kindLabel, money, useTr, type TreasuryDocumentRow } from './treasuryUi';

interface Account {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  balance: string;
  glAccountCode: string | null;
}
interface PostingExceptions {
  total: number;
  totalAmount: string;
  byCause: Record<string, { count: number; amount: string }>;
  rows: Array<{ transactionNumber: string; amount: string; accountCode: string; cause: string; reason: string | null; ageDays: number }>;
  deferredByPolicy: { payrollLegs: number; codCustodyLegs: number };
}

/**
 * T4 — the Treasury workspace: where the money is (BOOK balances, from the append-only ledger — no "available" or "bank" balance is shown because the data does not
 * support one yet), what is waiting for a person (approvals, execution), what is wrong (movements whose accounting did not post, accounts with no GL mapping) and how
 * to start each kind of movement. Every panel is read from the same endpoints the detail screens use; nothing here is a separate calculation.
 */
export function TreasuryWorkspace() {
  const tr = useTr();
  const { can } = useAuth();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [docs, setDocs] = useState<TreasuryDocumentRow[] | null>(null);
  const [exceptions, setExceptions] = useState<PostingExceptions | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canDocs = can('finance.cash_document.view', 'read-only');
  const canExceptions = can('accounting.cash.view', 'read-only');

  function load() {
    setError(null);
    api.get<Account[]>('/treasury/accounts').then(setAccounts).catch(setError);
    if (canDocs) api.get<TreasuryDocumentRow[]>('/treasury/documents').then(setDocs).catch(() => setDocs([]));
    if (canExceptions) {
      api.get<PostingExceptions>('/accounting/cash-bank/posting-exceptions?limit=10').then(setExceptions).catch(() => setExceptions(null));
    }
  }
  useEffect(load, [canDocs, canExceptions]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !accounts) return <ErrorState error={error} onRetry={load} />;
  if (!accounts) return <div className="empty-state">{loadingLabel()}</div>;

  const total = accounts.reduce((s, a) => s + Number(a.balance), 0);
  const unmapped = accounts.filter((a) => !a.glAccountCode);
  const waitingApproval = (docs ?? []).filter((d) => d.status === 'submitted');
  const readyToExecute = (docs ?? []).filter((d) => d.status === 'approved');
  const drafts = (docs ?? []).filter((d) => d.status === 'draft');

  const tile = (label: string, value: string | number, to?: string, tone?: 'warning' | 'danger') => (
    <div className="card" style={{ minWidth: 190, flex: '1 1 190px', borderInlineStart: tone ? `4px solid var(--${tone === 'danger' ? 'danger, #c0392b' : 'warning, #d4a017'})` : undefined }}>
      <div style={{ opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{to ? <Link to={to}>{value}</Link> : value}</div>
    </div>
  );

  const actions: Array<{ to: string; ar: string; en: string; node: string }> = [
    { to: '/treasury/documents/new', ar: 'استلام دفعة من عميل / إيداع / تحويل / صرف', en: 'Receive · deposit · withdraw · transfer · disburse', node: 'finance.cash_document.create' },
    { to: '/treasury/documents?status=submitted', ar: 'مراجعة مستندات بانتظار الاعتماد', en: 'Review documents awaiting approval', node: 'finance.cash_document.approve' },
    { to: '/treasury/documents?status=approved', ar: 'تنفيذ المستندات المعتمدة', en: 'Execute approved documents', node: 'finance.cash_document.execute' },
    { to: '/accounting/cash-bank', ar: 'مطابقة الخزينة مع الأستاذ العام', en: 'Reconcile Treasury with the general ledger', node: 'accounting.cash.view' },
    { to: '/treasury/ledger', ar: 'سجل حركات الخزينة', en: 'Treasury ledger', node: 'finance.cash.view' },
    { to: '/treasury/accounts', ar: 'الحسابات والربط المحاسبي', en: 'Accounts and GL mapping', node: 'finance.cash.view' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>{tr('مساحة عمل الخزينة', 'Treasury workspace')}</h1>
        <button className="btn btn-secondary" type="button" onClick={load}>{tr('تحديث', 'Refresh')}</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {tile(tr('إجمالي الأرصدة الدفترية', 'Total book balance'), money(total), '/treasury/accounts')}
        {canDocs && tile(tr('بانتظار الاعتماد', 'Awaiting approval'), waitingApproval.length, '/treasury/documents?status=submitted', waitingApproval.length ? 'warning' : undefined)}
        {canDocs && tile(tr('جاهزة للتنفيذ', 'Ready to execute'), readyToExecute.length, '/treasury/documents?status=approved', readyToExecute.length ? 'warning' : undefined)}
        {canDocs && tile(tr('مسودات', 'Drafts'), drafts.length, '/treasury/documents?status=draft')}
        {canExceptions && exceptions && tile(tr('حركات لم تُرحَّل محاسبياً', 'Movements not posted to the GL'), exceptions.total, undefined, exceptions.total ? 'danger' : undefined)}
        {unmapped.length > 0 && tile(tr('حسابات بلا ربط محاسبي', 'Accounts with no GL mapping'), unmapped.length, '/treasury/accounts', 'danger')}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{tr('إجراءات سريعة', 'Quick actions')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {actions.filter((a) => can(a.node, a.node.endsWith('.view') ? 'read-only' : 'editable')).map((a) => (
            <Link key={a.to} className="btn btn-secondary" to={a.to}>{tr(a.ar, a.en)}</Link>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{tr('الحسابات والأرصدة الدفترية', 'Accounts and book balances')}</h3>
        <div style={{ opacity: 0.7, marginBottom: 8 }}>{tr('الرصيد الدفتري مشتق من سجل الحركات؛ لا يوجد رصيد مصرفي/متاح لأن كشوف البنك غير مستوردة بعد.', 'The book balance is derived from the movement ledger; there is no bank/available balance because bank statements are not imported yet.')}</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('الحساب', 'Account')}</th>
                <th>{tr('الربط المحاسبي', 'GL mapping')}</th>
                <th>{tr('الحالة', 'Status')}</th>
                <th style={{ textAlign: 'end' }}>{tr('الرصيد الدفتري', 'Book balance')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/treasury/ledger?accountId=${a.id}`}>{a.code} — {a.name}</Link></td>
                  <td>{a.glAccountCode ?? <span className="status-badge negative">{tr('غير مربوط', 'Unmapped')}</span>}</td>
                  <td>{a.status === 'active' ? tr('نشط', 'Active') : tr('غير نشط', 'Inactive')}</td>
                  <td style={{ textAlign: 'end' }}>{money(a.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {canExceptions && exceptions && exceptions.total > 0 && (
        <div className="card" style={{ marginBottom: 16, borderInlineStart: '4px solid var(--danger, #c0392b)' }}>
          <h3 style={{ marginTop: 0 }}>{tr('استثناءات الترحيل المحاسبي', 'Posting exceptions')}</h3>
          <div style={{ opacity: 0.8, marginBottom: 8 }}>
            {tr('هذه حركات خزينة لم يُرحَّل أثرها المحاسبي بعد. بعد معالجة السبب يمكن إعادة تشغيل الحدث المحاسبي من شاشة الأحداث المالية؛ لا يتكرر القيد.', 'These Treasury movements have no posted accounting yet. After fixing the cause the financial event can be re-driven from the Financial Events screen; the journal is never duplicated.')}
            {' '}{tr('الإجمالي', 'Total')}: {money(exceptions.totalAmount)}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('الحركة', 'Movement')}</th>
                <th>{tr('الحساب', 'Account')}</th>
                <th style={{ textAlign: 'end' }}>{tr('المبلغ', 'Amount')}</th>
                <th>{tr('السبب', 'Cause')}</th>
                <th>{tr('العمر (يوم)', 'Age (days)')}</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.rows.map((r) => (
                <tr key={r.transactionNumber}>
                  <td>{r.transactionNumber}</td>
                  <td>{r.accountCode}</td>
                  <td style={{ textAlign: 'end' }}>{money(r.amount)}</td>
                  <td>{r.reason ?? r.cause}</td>
                  <td>{r.ageDays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canDocs && docs && (waitingApproval.length > 0 || readyToExecute.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{tr('بانتظار إجراء', 'Waiting for action')}</h3>
          <table className="data-table">
            <tbody>
              {[...waitingApproval, ...readyToExecute].slice(0, 10).map((d) => (
                <tr key={d.id}>
                  <td><Link to={`/treasury/documents/${d.id}`}>{d.documentNumber}</Link></td>
                  <td>{kindLabel(tr, d.kind, d.subtype)}</td>
                  <td style={{ textAlign: 'end' }}>{money(d.amount)}</td>
                  <td><DocStatusBadge status={d.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
