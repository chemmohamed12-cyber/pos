import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { fmtDateTime } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';
import { money, useTr } from './treasuryUi';

interface Session {
  id: string;
  sessionNumber: string;
  treasuryAccountId: string;
  status: 'open' | 'closed';
  openedAt: string;
  openingBalance: string;
  closedAt: string | null;
  expectedBalance: string | null;
  countedAmount: string | null;
  variance: string | null;
  varianceReason: string | null;
  varianceDocumentId: string | null;
}
interface Account {
  id: string;
  code: string;
  name: string;
  accountTypeId: string;
  status?: string;
}
interface AccountType {
  id: string;
  code: string;
}

/** T5 — cash custody sessions: open with the book balance as the float, close with a COUNT; a variance needs a reason and becomes a draft Treasury document (never a silent adjustment). */
export function CashSessions() {
  const tr = useTr();
  const { can } = useAuth();
  const [rows, setRows] = useState<Session[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [types, setTypes] = useState<AccountType[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [counts, setCounts] = useState<Record<string, { counted: string; reason: string }>>({});
  const [reopenReason, setReopenReason] = useState<Record<string, string>>({});

  function load() {
    setError(null);
    api.get<Session[]>('/treasury/cash-sessions').then(setRows).catch(setError);
    api.get<Account[]>('/treasury/accounts').then(setAccounts).catch(() => setAccounts([]));
    api.get<AccountType[]>('/treasury/account-types').then(setTypes).catch(() => setTypes([]));
  }
  useEffect(load, []);

  const cashTypeIds = new Set(types.filter((t) => ['cash', 'custody'].includes(t.code)).map((t) => t.id));
  const cashAccounts = accounts.filter((a) => cashTypeIds.has(a.accountTypeId) && a.status !== 'inactive');
  const accCode = (id: string) => accounts.find((a) => a.id === id)?.code ?? '—';

  async function act(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, body);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{tr('جلسات الخزينة النقدية', 'Cash sessions')}</h1>
      </div>
      {can('finance.cash_session.open', 'editable') && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
            <label>{tr('فتح جلسة على حساب نقدي', 'Open a session on a cash account')}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy || !accountId} onClick={() => act('/treasury/cash-sessions', { treasuryAccountId: accountId })}>{tr('فتح الجلسة', 'Open session')}</button>
        </div>
      )}
      {error ? <ErrorState error={error} onRetry={load} /> : null}
      {rows === null && !error ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows && rows.length === 0 ? (
        <div className="empty-state">{tr('لا توجد جلسات.', 'No sessions yet.')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('الجلسة', 'Session')}</th>
                <th>{tr('الحساب', 'Account')}</th>
                <th>{tr('فُتحت', 'Opened')}</th>
                <th style={{ textAlign: 'end' }}>{tr('الافتتاحي', 'Opening')}</th>
                <th style={{ textAlign: 'end' }}>{tr('المتوقع', 'Expected')}</th>
                <th style={{ textAlign: 'end' }}>{tr('المعدود', 'Counted')}</th>
                <th style={{ textAlign: 'end' }}>{tr('الفرق', 'Variance')}</th>
                <th>{tr('الإجراء', 'Action')}</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((s) => {
                const c = counts[s.id] ?? { counted: '', reason: '' };
                return (
                  <tr key={s.id}>
                    <td>{s.sessionNumber} {s.status === 'open' ? <span className="status-badge warning">{tr('مفتوحة', 'Open')}</span> : <span className="status-badge positive">{tr('مغلقة', 'Closed')}</span>}</td>
                    <td>{accCode(s.treasuryAccountId)}</td>
                    <td>{fmtDateTime(s.openedAt)}</td>
                    <td style={{ textAlign: 'end' }}>{money(s.openingBalance)}</td>
                    <td style={{ textAlign: 'end' }}>{s.expectedBalance !== null ? money(s.expectedBalance) : '—'}</td>
                    <td style={{ textAlign: 'end' }}>{s.countedAmount !== null ? money(s.countedAmount) : '—'}</td>
                    <td style={{ textAlign: 'end' }}>
                      {s.variance !== null ? (Number(s.variance) === 0 ? money(0) : <span className="status-badge negative">{money(s.variance)}</span>) : '—'}
                      {s.varianceDocumentId && <> <Link to={`/treasury/documents/${s.varianceDocumentId}`}>{tr('مستند التسوية', 'variance document')}</Link></>}
                    </td>
                    <td>
                      {s.status === 'open' && can('finance.cash_session.close', 'editable') && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <input type="number" step="0.01" min="0" placeholder={tr('المبلغ المعدود', 'Counted amount')} value={c.counted} onChange={(e) => setCounts({ ...counts, [s.id]: { ...c, counted: e.target.value } })} style={{ width: 120 }} />
                          <input placeholder={tr('سبب الفرق (إن وُجد)', 'Variance reason (if any)')} value={c.reason} onChange={(e) => setCounts({ ...counts, [s.id]: { ...c, reason: e.target.value } })} />
                          <button className="btn btn-primary" type="button" disabled={busy || c.counted === ''} onClick={() => act(`/treasury/cash-sessions/${s.id}/close`, { countedAmount: c.counted, varianceReason: c.reason || undefined })}>{tr('إغلاق', 'Close')}</button>
                        </div>
                      )}
                      {s.status === 'closed' && can('finance.cash_session.reopen', 'editable') && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input placeholder={tr('سبب إعادة الفتح', 'Reason to reopen')} value={reopenReason[s.id] ?? ''} onChange={(e) => setReopenReason({ ...reopenReason, [s.id]: e.target.value })} />
                          <button className="btn btn-secondary" type="button" disabled={busy || (reopenReason[s.id] ?? '').trim().length < 3} onClick={() => act(`/treasury/cash-sessions/${s.id}/reopen`, { reason: reopenReason[s.id] })}>{tr('إعادة فتح', 'Reopen')}</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
