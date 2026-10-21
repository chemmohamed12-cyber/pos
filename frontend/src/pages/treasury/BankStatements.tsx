import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, newIdempotencyKey } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { loadingLabel } from '../../lib/displayNames';
import { money, useTr } from './treasuryUi';

interface Statement {
  id: string;
  systemNumber: string;
  statementNumber: string | null;
  treasuryAccountId: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: string;
  closingBalance: string;
  status: 'imported' | 'reconciled';
  lineCount: number;
}
interface Account {
  id: string;
  code: string;
  name: string;
  accountTypeId: string;
  status?: string;
}

/** Parses pasted bank lines: `date,amount,reference,description` (one per line, header optional, amount signed: positive = into the account). */
export function parseStatementLines(text: string): Array<{ valueDate: string; amount: string; reference?: string; description?: string }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^date\s*,/i.test(l))
    .map((l) => {
      const [valueDate, amount, reference, ...rest] = l.split(',').map((x) => x.trim());
      return { valueDate, amount, reference: reference || undefined, description: rest.join(',') || undefined };
    });
}

/** T5 — bank statements: the list of imported statements and the import form. Importing never posts anything and never matches anything by itself. */
export function BankStatements() {
  const tr = useTr();
  const nav = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState<Statement[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey());
  const [f, setF] = useState({ accountId: '', number: '', start: '', end: '', opening: '', closing: '', lines: '' });

  function load() {
    setError(null);
    api.get<Statement[]>('/treasury/bank-statements').then(setRows).catch(setError);
    api.get<Account[]>('/treasury/accounts').then(setAccounts).catch(() => setAccounts([]));
  }
  useEffect(load, []);

  const lines = parseStatementLines(f.lines);
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const arithmeticOk = f.opening !== '' && f.closing !== '' && Math.abs(Number(f.opening) + total - Number(f.closing)) < 0.005;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post<Statement>(
        '/treasury/bank-statements',
        { treasuryAccountId: f.accountId, statementNumber: f.number || undefined, periodStart: f.start, periodEnd: f.end, openingBalance: f.opening, closingBalance: f.closing, lines },
        { idempotencyKey: key },
      );
      setKey(newIdempotencyKey());
      nav(`/treasury/bank-statements/${saved.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const acc = (id: string) => accounts.find((a) => a.id === id);
  return (
    <div>
      <div className="page-header">
        <h1>{tr('كشوف الحسابات البنكية', 'Bank statements')}</h1>
        {can('finance.bank_statement.import', 'editable') && (
          <button className="btn btn-primary" type="button" onClick={() => setShowForm(!showForm)}>
            {tr('استيراد كشف', 'Import a statement')}
          </button>
        )}
      </div>

      {showForm && (
        <form className="card" onSubmit={submit} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="form-field" style={{ minWidth: 220 }}>
              <label>{tr('الحساب البنكي', 'Bank account')}</label>
              <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} required>
                <option value="">—</option>
                {accounts.filter((a) => a.status !== 'inactive').map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field"><label>{tr('رقم الكشف لدى البنك', "Bank's statement no.")}</label><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></div>
            <div className="form-field"><label>{tr('من', 'Period start')}</label><input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required /></div>
            <div className="form-field"><label>{tr('إلى', 'Period end')}</label><input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} required /></div>
            <div className="form-field"><label>{tr('الرصيد الافتتاحي', 'Opening balance')}</label><input type="number" step="0.01" value={f.opening} onChange={(e) => setF({ ...f, opening: e.target.value })} required /></div>
            <div className="form-field"><label>{tr('الرصيد الختامي', 'Closing balance')}</label><input type="number" step="0.01" value={f.closing} onChange={(e) => setF({ ...f, closing: e.target.value })} required /></div>
          </div>
          <div className="form-field">
            <label>{tr('سطور الكشف — سطر لكل حركة: التاريخ,المبلغ,المرجع,الوصف (الموجب = دخول للحساب، السالب = خروج)', 'Statement lines — one per line: date,amount,reference,description (positive = into the account, negative = out)')}</label>
            <textarea rows={8} value={f.lines} onChange={(e) => setF({ ...f, lines: e.target.value })} placeholder="2026-10-05,2000.00,R-1,Incoming wire" style={{ width: '100%', fontFamily: 'monospace' }} required />
          </div>
          <div style={{ marginBottom: 8 }}>
            {tr('عدد السطور', 'Lines')}: {lines.length} · {tr('مجموع الحركات', 'Total movement')}: {money(total)} ·{' '}
            {f.opening !== '' && f.closing !== '' && (arithmeticOk ? <span className="status-badge positive">{tr('الرصيد الافتتاحي + الحركات = الختامي', 'opening + lines = closing')}</span> : <span className="status-badge negative">{tr('الكشف لا يتوازن', 'does not add up')}</span>)}
          </div>
          {error ? <ErrorState error={error} /> : null}
          <button className="btn btn-primary" type="submit" disabled={busy || lines.length === 0}>{tr('استيراد', 'Import')}</button>{' '}
          <span style={{ opacity: 0.7 }}>{tr('الاستيراد لا يُنشئ أي قيد ولا يطابق أي حركة تلقائياً.', 'Importing posts nothing and matches nothing by itself.')}</span>
        </form>
      )}

      {error && !showForm ? (
        <ErrorState error={error} onRetry={load} />
      ) : rows === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{tr('لم يُستورد أي كشف بعد.', 'No statement has been imported yet.')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('الرقم', 'Number')}</th>
                <th>{tr('الحساب', 'Account')}</th>
                <th>{tr('الفترة', 'Period')}</th>
                <th style={{ textAlign: 'end' }}>{tr('الختامي', 'Closing')}</th>
                <th>{tr('السطور', 'Lines')}</th>
                <th>{tr('الحالة', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/treasury/bank-statements/${s.id}`}>{s.systemNumber}</Link>{s.statementNumber ? ` (${s.statementNumber})` : ''}</td>
                  <td>{acc(s.treasuryAccountId)?.code ?? '—'}</td>
                  <td>{s.periodStart} → {s.periodEnd}</td>
                  <td style={{ textAlign: 'end' }}>{money(s.closingBalance)}</td>
                  <td>{s.lineCount}</td>
                  <td>{s.status === 'reconciled' ? <span className="status-badge positive">{tr('مُسوّى', 'Reconciled')}</span> : <span className="status-badge warning">{tr('قيد المطابقة', 'In progress')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
