import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  balance: string;
}
interface TreasuryTransaction {
  id: string;
  transactionNumber: string;
  type: 'cash_in' | 'cash_out' | 'transfer_in' | 'transfer_out';
  treasuryAccountId: string;
  amount: string;
  customerId: string | null;
  salesOrderId: string | null;
  depositId: string | null;
  reference: string | null;
  reason: string | null;
  movementDate: string;
  status: 'posted' | 'reversed';
}

type OperationMode = 'cash_in' | 'cash_out' | 'transfer' | null;

/** Financial/Treasury Core — the Ledger. Manual Cash In/Out/Transfer plus Reverse; no post-posting edits anywhere, only offsetting entries. */
export function TreasuryLedger() {
  const { t, preload } = useLanguage();
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<TreasuryAccount[]>([]);
  const [transactions, setTransactions] = useState<TreasuryTransaction[] | null>(null);
  const [filterAccountId, setFilterAccountId] = useState(searchParams.get('accountId') ?? '');
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

  async function loadLedger() {
    try {
      const qs = filterAccountId ? `?accountId=${filterAccountId}` : '';
      setTransactions(await api.get<TreasuryTransaction[]>(`/treasury/ledger${qs}`));
    } catch (err) {
      // Foundation fix: no error handling — the page was stuck on "Loading…" forever on failure.
      setError(err instanceof ApiError ? err.message : 'Failed to load the treasury ledger.');
    }
  }

  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAccountId]);

  function resetForm() {
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
        await api.post('/treasury/cash-in', { accountId, amount, reference: reference || undefined, reason: reason || undefined });
      } else if (mode === 'cash_out') {
        await api.post('/treasury/cash-out', { accountId, amount, reference: reference || undefined, reason: reason || undefined });
      } else if (mode === 'transfer') {
        await api.post('/treasury/transfer', {
          sourceAccountId: accountId,
          destinationAccountId,
          amount,
          reference: reference || undefined,
          reason: reason || undefined,
        });
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

  const accountName = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.name}` : id;
  };

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
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.reason')}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
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

      {error && <div className="error-text">{error}</div>}

      {transactions === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.transaction_type')}</th>
                <th>{t('field.treasury_account')}</th>
                <th>{t('field.amount')}</th>
                <th>{t('field.reference')}</th>
                <th>{t('field.reason')}</th>
                <th>{t('field.movement_date')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn) => (
                <tr key={txn.id}>
                  <td>{txn.transactionNumber}</td>
                  <td>{accountName(txn.treasuryAccountId)}</td>
                  <td style={{ color: txn.type === 'cash_in' || txn.type === 'transfer_in' ? '#166534' : '#a3262d' }}>
                    {txn.type === 'cash_in' || txn.type === 'transfer_in' ? '+' : '-'}
                    {txn.amount}
                  </td>
                  <td>{txn.reference ?? '—'}</td>
                  <td>{txn.reason ?? '—'}</td>
                  <td>{new Date(txn.movementDate).toLocaleString()}</td>
                  <td>
                    <StatusBadge code={`warehouse_txn_state.${txn.status}`} />
                  </td>
                  <td>
                    {txn.status === 'posted' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          placeholder={t('field.reason')}
                          value={reverseReason[txn.id] ?? ''}
                          onChange={(e) => setReverseReason((prev) => ({ ...prev, [txn.id]: e.target.value }))}
                          style={{ width: 120 }}
                        />
                        <button
                          className="btn btn-danger"
                          disabled={reverseBusyId === txn.id || !reverseReason[txn.id]?.trim()}
                          onClick={() => reverse(txn.id)}
                        >
                          {t('action.reverse')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
