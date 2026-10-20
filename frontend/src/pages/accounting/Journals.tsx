import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { loadingLabel } from '../../lib/displayNames';

interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  isPostable: boolean;
}
interface JournalEntry {
  id: string;
  entryNumber: string | null;
  businessDate: string;
  description: string | null;
  sourceType: string;
  transactionCurrencyCode: string;
  totalDebitTransaction: string;
  totalCreditTransaction: string;
  status: 'DRAFT' | 'VALIDATED' | 'POSTED' | 'REVERSED';
}
interface DraftLine {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
}

const PRELOAD = [
  'nav.journals',
  'field.entry_number',
  'field.business_date',
  'field.journal_status',
  'field.source_type',
  'field.debit',
  'field.credit',
  'field.actions',
  'value.journal_status.draft',
  'value.journal_status.validated',
  'value.journal_status.posted',
  'value.journal_status.reversed',
  'value.source_type.manual',
  'value.source_type.opening',
  'value.source_type.financial_event',
  'value.source_type.reversal',
  'action.add_journal_line',
  'action.new_manual_journal',
  'action.save',
  'action.cancel',
  'action.details',
  'panel.no_journals_yet',
  'panel.journal_not_balanced',
];

function emptyLine(): DraftLine {
  return { accountId: '', description: '', debit: '', credit: '' };
}

/** F03 — General Ledger (ADR-035). Journal Entries list + manual-journal create form (draft). Posting workflow lives in `JournalDetail.tsx`. */
export function Journals() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  preload(PRELOAD);

  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [businessDate, setBusinessDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setEntries(await api.get<JournalEntry[]>('/accounting/journals'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load journal entries.');
    }
  }

  useEffect(() => {
    load();
    api.get<GLAccount[]>('/accounting/accounts?postableOnly=true').then((a) => {
      setAccounts(a);
    }).catch(() => setAccounts([]));
    api.get<{ code: string; isBaseCurrency: boolean }[]>('/accounting/currencies').then((cs) => {
      const base = cs.find((c) => c.isBaseCurrency);
      if (base) setCurrencyCode(base.code);
      else if (cs[0]) setCurrencyCode(cs[0].code);
    }).catch(() => {});
  }, []);

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = lines.length > 0 && totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.0001;

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!balanced) {
      setError(t('panel.journal_not_balanced'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/journals', {
        sourceType: 'MANUAL',
        businessDate,
        description: description || undefined,
        transactionCurrencyCode: currencyCode,
        lines: lines
          .filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0))
          .map((l) => ({
            accountId: l.accountId,
            description: l.description || undefined,
            debit: Number(l.debit) > 0 ? l.debit : undefined,
            credit: Number(l.credit) > 0 ? l.credit : undefined,
          })),
      });
      setShowCreate(false);
      setDescription('');
      setLines([emptyLine(), emptyLine()]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create journal entry.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.journals')}</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
          {t('action.new_manual_journal')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      {showCreate && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.business_date')}</label>
                <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} required />
              </div>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
                <label>{t('field.description')}</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="—" />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.currency_code')}</label>
                <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} maxLength={3} required style={{ width: 80 }} />
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.line_number')}</th>
                  <th>{t('field.account_code')}</th>
                  <th>{t('field.debit')}</th>
                  <th>{t('field.credit')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={idx}>
                    <td>{idx + 1}</td>
                    <td>
                      <select value={l.accountId} onChange={(e) => updateLine(idx, { accountId: e.target.value })} required>
                        <option value="">—</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} — {a.nameAr ?? a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        style={{ width: 110 }}
                        value={l.debit}
                        onChange={(e) => updateLine(idx, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        style={{ width: 110 }}
                        value={l.credit}
                        onChange={(e) => updateLine(idx, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
                      />
                    </td>
                    <td>
                      {lines.length > 2 && (
                        <button type="button" className="btn btn-secondary" onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}>
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                {t('action.add_journal_line')}
              </button>
              <span>
                {t('field.debit')}: {totalDebit.toFixed(2)} — {t('field.credit')}: {totalCredit.toFixed(2)}
              </span>
              {!balanced && <span className="error-text">{t('panel.journal_not_balanced')}</span>}
            </div>

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={busy || !balanced}>
                {t('action.save')}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowCreate(false)}>
                {t('action.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {entries === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state">{t('panel.no_journals_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.entry_number')}</th>
              <th>{t('field.business_date')}</th>
              <th>{t('field.source_type')}</th>
              <th>{t('field.debit')}</th>
              <th>{t('field.credit')}</th>
              <th>{t('field.journal_status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.entryNumber ?? '—'}</td>
                <td>{e.businessDate}</td>
                <td>{t(`value.source_type.${e.sourceType.toLowerCase()}`)}</td>
                <td>{e.totalDebitTransaction}</td>
                <td>{e.totalCreditTransaction}</td>
                <td>
                  <StatusBadge code={`value.journal_status.${e.status.toLowerCase()}`} />
                </td>
                <td>
                  <button className="btn btn-secondary" onClick={() => navigate(`/accounting/journals/${e.id}`)}>
                    {t('action.details')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
