import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
}
interface JournalLine {
  id: string;
  lineNumber: number;
  accountId: string;
  description: string | null;
  debitTransaction: string;
  creditTransaction: string;
  debitBase: string;
  creditBase: string;
}
interface JournalEntry {
  id: string;
  entryNumber: string | null;
  businessDate: string;
  postingDate: string | null;
  description: string | null;
  sourceType: string;
  transactionCurrencyCode: string;
  functionalCurrencyCode: string;
  totalDebitTransaction: string;
  totalCreditTransaction: string;
  status: 'DRAFT' | 'VALIDATED' | 'POSTED' | 'REVERSED';
  lines: JournalLine[];
}

const PRELOAD = [
  'nav.journals',
  'field.entry_number',
  'field.business_date',
  'field.posting_date',
  'field.journal_status',
  'field.source_type',
  'field.line_number',
  'field.debit',
  'field.credit',
  'field.description',
  'value.journal_status.draft',
  'value.journal_status.validated',
  'value.journal_status.posted',
  'value.journal_status.reversed',
  'action.submit_journal',
  'action.post_journal',
  'action.reverse_journal',
  'action.back',
  'action.save',
];

export function JournalDetail() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [reverseDescription, setReverseDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    try {
      setEntry(await api.get<JournalEntry>(`/accounting/journals/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load journal entry.');
    }
  }

  useEffect(() => {
    load();
    api.get<GLAccount[]>('/accounting/accounts').then(setAccounts).catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function transition(action: 'submit' | 'post' | 'reverse') {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'reverse') {
        await api.post(`/accounting/journals/${id}/reverse`, { description: reverseDescription || undefined });
      } else {
        await api.post(`/accounting/journals/${id}/${action}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} journal entry.`);
    } finally {
      setBusy(false);
    }
  }

  const accountLabel = (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    return a ? `${a.code} — ${a.nameAr ?? a.name}` : accountId;
  };

  if (!entry) return <div className="empty-state">{error ?? 'Loading…'}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>
          {t('nav.journals')} {entry.entryNumber ? `— ${entry.entryNumber}` : ''}
        </h1>
        <button className="btn btn-secondary" onClick={() => navigate('/accounting/journals')}>
          {t('action.back')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="detail-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-tile">
          <div className="label">{t('field.business_date')}</div>
          <div className="value">{entry.businessDate}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">{t('field.journal_status')}</div>
          <div className="value">
            <StatusBadge code={`value.journal_status.${entry.status.toLowerCase()}`} />
          </div>
        </div>
        <div className="kpi-tile">
          <div className="label">{t('field.debit')}</div>
          <div className="value">
            {entry.totalDebitTransaction} {entry.transactionCurrencyCode}
          </div>
        </div>
        <div className="kpi-tile">
          <div className="label">{t('field.credit')}</div>
          <div className="value">
            {entry.totalCreditTransaction} {entry.transactionCurrencyCode}
          </div>
        </div>
      </div>

      {entry.description && <p>{entry.description}</p>}

      <table className="data-table" style={{ marginBottom: 20 }}>
        <thead>
          <tr>
            <th>{t('field.line_number')}</th>
            <th>{t('field.account_code')}</th>
            <th>{t('field.description')}</th>
            <th>{t('field.debit')}</th>
            <th>{t('field.credit')}</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.lineNumber}</td>
              <td>{accountLabel(l.accountId)}</td>
              <td>{l.description ?? '—'}</td>
              <td>{Number(l.debitTransaction) > 0 ? l.debitTransaction : ''}</td>
              <td>{Number(l.creditTransaction) > 0 ? l.creditTransaction : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {entry.status === 'DRAFT' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => transition('submit')}>
            {t('action.submit_journal')}
          </button>
        )}
        {(entry.status === 'DRAFT' || entry.status === 'VALIDATED') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => transition('post')}>
            {t('action.post_journal')}
          </button>
        )}
        {entry.status === 'POSTED' && (
          <>
            <input
              placeholder={t('field.description')}
              value={reverseDescription}
              onChange={(e) => setReverseDescription(e.target.value)}
              style={{ minWidth: 220 }}
            />
            <button className="btn btn-danger" disabled={busy} onClick={() => transition('reverse')}>
              {t('action.reverse_journal')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
