import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../context/AuthContext';
import { loadingLabel } from '../../lib/displayNames';
import { money, useTr } from './treasuryUi';

interface Line {
  id: string;
  lineNumber: number;
  valueDate: string;
  description: string | null;
  reference: string | null;
  amount: string;
  status: 'unmatched' | 'suggested' | 'matched';
  possibleDuplicate: boolean;
  suggestion: { outcome: string; candidates: Array<{ transactionId: string; transactionNumber: string; score: number; reasons: string[] }> } | null;
  matches: Array<{ id: string; treasuryTransactionId: string }>;
}
interface Statement {
  id: string;
  systemNumber: string;
  statementNumber: string | null;
  periodStart: string;
  periodEnd: string;
  openingBalance: string;
  closingBalance: string;
  status: 'imported' | 'reconciled';
  lines: Line[];
}
interface Recon {
  closingBalance: string;
  bookBalanceAtPeriodEnd: string;
  outstandingBookNet: string;
  bankOnlyNet: string;
  adjustedBank: string;
  adjustedBook: string;
  difference: string;
  outstandingBookItems: Array<{ transactionId: string; transactionNumber: string; movementDate: string; signedAmount: string; reference: string | null; ageDays: number }>;
}

/**
 * T5 — one statement: every line with its status, the matcher's SUGGESTIONS (a person confirms each one), the reconciliation proof (adjusted bank vs adjusted book) and the
 * actions allowed by status and permissions. Bank settlement is shown here; it is a separate fact from a document being executed.
 */
export function BankStatementDetail() {
  const tr = useTr();
  const { id } = useParams();
  const { can } = useAuth();
  const [s, setS] = useState<Statement | null>(null);
  const [r, setR] = useState<Recon | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  function load() {
    setError(null);
    api.get<Statement>(`/treasury/bank-statements/${id}`).then(setS).catch(setError);
    api.get<Recon>(`/treasury/bank-statements/${id}/reconciliation`).then(setR).catch(() => setR(null));
  }
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, body);
      setReason('');
      load();
    } catch (err) {
      setError(err);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !s) return <ErrorState error={error} onRetry={load} />;
  if (!s) return <div className="empty-state">{loadingLabel()}</div>;
  const reconciled = s.status === 'reconciled';
  const unmatched = s.lines.filter((l) => l.status !== 'matched').length;

  return (
    <div>
      <div className="page-header">
        <h1>
          {s.systemNumber} {reconciled ? <span className="status-badge positive">{tr('مُسوّى', 'Reconciled')}</span> : <span className="status-badge warning">{tr('قيد المطابقة', 'In progress')}</span>}
        </h1>
        <Link className="btn btn-secondary" to="/treasury/bank-statements">{tr('كل الكشوف', 'All statements')}</Link>
      </div>
      {error ? <ErrorState error={error} /> : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <div>{s.periodStart} → {s.periodEnd} · {tr('افتتاحي', 'Opening')} {money(s.openingBalance)} · {tr('ختامي', 'Closing')} {money(s.closingBalance)}</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {!reconciled && can('finance.bank_statement.match', 'editable') && (
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act(`/treasury/bank-statements/${s.id}/suggest`)}>{tr('اقتراح مطابقات', 'Suggest matches')}</button>
          )}
          {!reconciled && can('finance.bank_statement.reconcile', 'editable') && (
            <button className="btn btn-primary" type="button" disabled={busy || unmatched > 0 || r?.difference !== '0.00'} onClick={() => act(`/treasury/bank-statements/${s.id}/reconcile`)}>{tr('اعتماد التسوية', 'Reconcile')}</button>
          )}
          {reconciled && can('finance.bank_statement.reopen', 'editable') && (
            <>
              <input placeholder={tr('سبب إعادة الفتح', 'Reason for reopening')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="btn btn-secondary" type="button" disabled={busy || reason.trim().length < 3} onClick={() => act(`/treasury/bank-statements/${s.id}/reopen`, { reason })}>{tr('إعادة فتح', 'Reopen')}</button>
            </>
          )}
        </div>
      </div>

      {r && (
        <div className="card" style={{ marginBottom: 16, borderInlineStart: `4px solid ${r.difference === '0.00' ? 'var(--success, #2e7d32)' : 'var(--danger, #c0392b)'}` }}>
          <h3 style={{ marginTop: 0 }}>{tr('إثبات التسوية', 'Reconciliation proof')}</h3>
          <table className="data-table">
            <tbody>
              <tr><td>{tr('الرصيد الختامي بالكشف', 'Bank closing balance')}</td><td style={{ textAlign: 'end' }}>{money(r.closingBalance)}</td></tr>
              <tr><td>{tr('+ حركات بالدفاتر لم يظهرها البنك بعد (صافي)', '+ book items the bank has not shown yet (net)')}</td><td style={{ textAlign: 'end' }}>{money(r.outstandingBookNet)}</td></tr>
              <tr><td><strong>{tr('= الرصيد البنكي المُعدّل', '= Adjusted bank')}</strong></td><td style={{ textAlign: 'end' }}><strong>{money(r.adjustedBank)}</strong></td></tr>
              <tr><td>{tr('الرصيد الدفتري في نهاية الفترة', 'Book balance at period end')}</td><td style={{ textAlign: 'end' }}>{money(r.bookBalanceAtPeriodEnd)}</td></tr>
              <tr><td>{tr('+ حركات بالبنك غير مسجلة بالدفاتر (صافي)', '+ bank items not yet in the books (net)')}</td><td style={{ textAlign: 'end' }}>{money(r.bankOnlyNet)}</td></tr>
              <tr><td><strong>{tr('= الرصيد الدفتري المُعدّل', '= Adjusted book')}</strong></td><td style={{ textAlign: 'end' }}><strong>{money(r.adjustedBook)}</strong></td></tr>
              <tr><td><strong>{tr('الفرق', 'Difference')}</strong></td><td style={{ textAlign: 'end' }}><strong>{money(r.difference)}</strong></td></tr>
            </tbody>
          </table>
          {unmatched > 0 && <div className="error-text">{tr(`${unmatched} سطر غير مطابق — سجّل الرسوم/الفوائد كمستند خزينة ثم طابقها.`, `${unmatched} line(s) not matched — record bank fees / interest as a Treasury document, then match them.`)}</div>}
        </div>
      )}

      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{tr('التاريخ', 'Date')}</th>
              <th>{tr('الوصف / المرجع', 'Description / reference')}</th>
              <th style={{ textAlign: 'end' }}>{tr('المبلغ', 'Amount')}</th>
              <th>{tr('الحالة', 'Status')}</th>
              <th>{tr('الاقتراح', 'Suggestion')}</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.lineNumber}</td>
                <td>{l.valueDate}</td>
                <td>{l.description ?? '—'} {l.reference ? <code>{l.reference}</code> : null} {l.possibleDuplicate && <span className="status-badge warning">{tr('مكرر محتمل', 'possible duplicate')}</span>}</td>
                <td style={{ textAlign: 'end' }}>{money(l.amount)}</td>
                <td>{l.status === 'matched' ? <span className="status-badge positive">{tr('مطابق', 'Matched')}</span> : l.status === 'suggested' ? <span className="status-badge warning">{tr('مقترح', 'Suggested')}</span> : <span className="status-badge negative">{tr('غير مطابق', 'Unmatched')}</span>}</td>
                <td>
                  {l.status === 'matched' ? (
                    !reconciled && can('finance.bank_statement.unmatch', 'editable') && (
                      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { const why = window.prompt(tr('سبب إلغاء المطابقة', 'Reason for undoing the match')); if (why && why.trim().length >= 3) act(`/treasury/bank-statements/lines/${l.id}/unmatch`, { reason: why }); }}>{tr('إلغاء المطابقة', 'Unmatch')}</button>
                    )
                  ) : l.suggestion ? (
                    <div>
                      {l.suggestion.outcome === 'ambiguous' && <div className="error-text">{tr('أكثر من حركة محتملة — اختر الحركة الصحيحة بنفسك', 'Several possible movements — choose the right one yourself')}</div>}
                      {l.suggestion.candidates.map((c) => (
                        <div key={c.transactionId}>
                          <code>{c.transactionNumber}</code> ({c.score}) {c.reasons.join(', ')}{' '}
                          {can('finance.bank_statement.match', 'editable') && !reconciled && (
                            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act(`/treasury/bank-statements/lines/${l.id}/confirm`, { transactionIds: [c.transactionId] })}>{tr('تأكيد', 'Confirm')}</button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r && r.outstandingBookItems.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{tr('حركات دفترية معلّقة (لم يظهرها البنك)', 'Outstanding book items (not yet on the bank statement)')}</h3>
          <table className="data-table">
            <tbody>
              {r.outstandingBookItems.map((i) => (
                <tr key={i.transactionId}>
                  <td>{i.transactionNumber}</td>
                  <td>{i.movementDate}</td>
                  <td>{i.reference ?? '—'}</td>
                  <td style={{ textAlign: 'end' }}>{money(i.signedAmount)}</td>
                  <td>{i.ageDays} {tr('يوم', 'days')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
