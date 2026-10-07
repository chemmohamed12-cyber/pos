import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, downloadBlob } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from './StatusBadge';
import { FinancialTrace } from './FinancialTrace';

interface Deposit {
  id: string;
  amount: string;
  method: string;
  status: 'submitted' | 'approved' | 'rejected';
  rejectionReason: string | null;
  evidenceMediaAssetId: string | null;
  createdAt: string;
}
interface TreasuryAccountType {
  id: string;
  code: string;
  name: string;
}
interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  accountTypeId: string;
  status: string;
  balance: string;
}

/** Payment method -> suggested Account Type code, so picking a method narrows straight to the right sub-account list (CTO directive: method selection shows the type, then the sub-account). Finance can still pick a different type if the money actually landed elsewhere. */
const METHOD_TO_TYPE_CODE: Record<string, string> = {
  bank_transfer: 'bank',
  card: 'bank',
  cash: 'cash',
  wallet: 'wallet',
};

/**
 * Deposit Control panel embedded in the Sales Order detail screen — only
 * relevant once the order reaches deposit_verification (or later, to
 * show the historical record).
 *
 * Reject/Resubmit (CTO finalization directive §2): rejection does not
 * transition the Sales Order itself — only the deposit's own status
 * changes (`DepositsService.rejectDeposit`) — so the order stays in
 * `deposit_verification` and the rep simply submits a NEW deposit for
 * the same order; `getLatestDepositForOrder` always returns the newest
 * row, so no separate "resubmit" endpoint exists.
 */
export function DepositPanel({ salesOrderId, orderStatus, onChanged }: { salesOrderId: string; orderStatus: string; onChanged: () => void }) {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const [deposit, setDeposit] = useState<Deposit | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [treasuryTypes, setTreasuryTypes] = useState<TreasuryAccountType[]>([]);
  const [treasuryAccounts, setTreasuryAccounts] = useState<TreasuryAccount[]>([]);
  const [treasuryTypeId, setTreasuryTypeId] = useState('');
  const [treasuryAccountId, setTreasuryAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const canReview = can('sales.deposit.approve', 'editable');

  preload([
    'deposit.status.submitted',
    'deposit.status.approved',
    'deposit.status.rejected',
    'panel.deposit',
    'panel.waiting_for_rep_deposit',
    'field.method',
    'field.total_amount',
    'field.status',
    'field.reason',
    'field.account_type',
    'field.treasury_account',
    'method.bank_transfer',
    'method.cash',
    'method.card',
    'method.wallet',
    'action.submit_deposit',
    'action.approve_deposit',
    'action.reject_deposit',
    'action.cancel',
    'action.preview_receipt',
    'panel.deposit_evidence',
  ]);

  /**
   * CTO directive — Accounts must be able to preview the deposit transfer
   * receipt while approving, not just trust the amount/method fields.
   * Fetched as an authenticated Blob (`GET /media/:id` needs a Bearer
   * token a plain `<img src>` can't carry — see `downloadBlob`), shown as
   * an object URL in a lightweight overlay; revoked on close so the blob
   * doesn't leak for the life of the tab.
   */
  async function openPreview() {
    if (!deposit?.evidenceMediaAssetId) return;
    setPreviewBusy(true);
    setError(null);
    try {
      const blob = await downloadBlob(`/media/${deposit.evidenceMediaAssetId}`);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the receipt.');
    } finally {
      setPreviewBusy(false);
    }
  }

  function closePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  }

  async function load() {
    try {
      const data = await api.get<Deposit | null>(`/deposits?salesOrderId=${salesOrderId}`);
      setDeposit(data);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesOrderId]);

  // Only finance/admin can even reach these routes (403 otherwise) — and there's no point fetching them for a rep who can't approve anyway.
  useEffect(() => {
    if (!canReview) return;
    (async () => {
      const [types, accounts] = await Promise.all([
        api.get<TreasuryAccountType[]>('/treasury/account-types'),
        api.get<TreasuryAccount[]>('/treasury/accounts'),
      ]);
      setTreasuryTypes(types);
      setTreasuryAccounts(accounts.filter((a) => a.status === 'active'));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview]);

  // Once the deposit and account types are both loaded, default the Type picker to whatever the rep's chosen payment method suggests (finance can still override).
  useEffect(() => {
    if (!deposit || treasuryTypes.length === 0 || treasuryTypeId) return;
    const suggestedCode = METHOD_TO_TYPE_CODE[deposit.method];
    const suggested = treasuryTypes.find((ty) => ty.code === suggestedCode) ?? treasuryTypes[0];
    setTreasuryTypeId(suggested.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposit, treasuryTypes]);

  const accountsForSelectedType = treasuryAccounts.filter((a) => a.accountTypeId === treasuryTypeId);
  useEffect(() => {
    if (accountsForSelectedType.length === 1) setTreasuryAccountId(accountsForSelectedType[0].id);
    else setTreasuryAccountId((prev) => (accountsForSelectedType.some((a) => a.id === prev) ? prev : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treasuryTypeId]);

  if (orderStatus !== 'deposit_verification' && !deposit) return null;
  if (!loaded) return null;

  const needsSubmission = !deposit || deposit.status === 'rejected';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/deposits', { salesOrderId, amount, method });
      setAmount('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit deposit.');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!deposit || !treasuryAccountId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/deposits/${deposit.id}/approve`, { treasuryAccountId });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to approve deposit.');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!deposit || !rejectReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/deposits/${deposit.id}/reject`, { reason: rejectReason.trim() });
      setRejectReason('');
      setShowRejectForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reject deposit.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ marginTop: 0 }}>{t('panel.deposit')}</h3>
        {deposit && (
          <button className="btn btn-secondary" onClick={() => window.open(`/print/deposit/${deposit.id}`, '_blank')}>
            {t('action.print')}
          </button>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}

      {deposit && (
        <div style={{ marginBottom: needsSubmission ? 16 : 0 }}>
          <FinancialTrace ids={[deposit.id]} />
          <div className="detail-grid">
            <div className="detail-field">
              <div className="label">{t('field.total_amount')}</div>
              <div className="value">{deposit.amount}</div>
            </div>
            <div className="detail-field">
              <div className="label">{t('field.method')}</div>
              <div className="value">{t(`method.${deposit.method}`)}</div>
            </div>
            <div className="detail-field">
              <div className="label">{t('field.status')}</div>
              <div className="value">
                <StatusBadge code={`deposit.status.${deposit.status}`} />
              </div>
            </div>
            {deposit.status === 'rejected' && deposit.rejectionReason && (
              <div className="detail-field">
                <div className="label">{t('field.reason')}</div>
                <div className="value" style={{ fontSize: '0.9rem' }}>{deposit.rejectionReason}</div>
              </div>
            )}
          </div>

          {deposit.evidenceMediaAssetId && (
            <button className="btn btn-secondary" style={{ marginTop: 10 }} disabled={previewBusy} onClick={openPreview}>
              {previewBusy ? '...' : t('action.preview_receipt')}
            </button>
          )}

          {deposit.status === 'submitted' && canReview && (
            <div className="action-row" style={{ alignItems: 'flex-end' }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
                <label>{t('field.account_type')}</label>
                <select value={treasuryTypeId} onChange={(e) => setTreasuryTypeId(e.target.value)}>
                  {treasuryTypes.map((ty) => (
                    <option key={ty.id} value={ty.id}>
                      {ty.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
                <label>{t('field.treasury_account')}</label>
                <select value={treasuryAccountId} onChange={(e) => setTreasuryAccountId(e.target.value)}>
                  <option value="">—</option>
                  {accountsForSelectedType.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name} ({a.balance})
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" onClick={approve} disabled={busy || !treasuryAccountId}>
                {t('action.approve_deposit')}
              </button>
              {!showRejectForm && (
                <button className="btn btn-danger" onClick={() => setShowRejectForm(true)} disabled={busy}>
                  {t('action.reject_deposit')}
                </button>
              )}
            </div>
          )}

          {deposit.status === 'submitted' && canReview && showRejectForm && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 12 }}>
              <div className="form-field" style={{ marginBottom: 0, flex: 1 }}>
                <label>{t('field.reason')}</label>
                <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} autoFocus />
              </div>
              <button className="btn btn-danger" onClick={reject} disabled={busy || !rejectReason.trim()}>
                {t('action.reject_deposit')}
              </button>
              <button className="btn btn-secondary" onClick={() => setShowRejectForm(false)} disabled={busy}>
                {t('action.cancel')}
              </button>
            </div>
          )}
        </div>
      )}

      {needsSubmission && can('wf.sales.rep.act', 'editable') && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.total_amount')}</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.method')}</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="bank_transfer">{t('method.bank_transfer')}</option>
              <option value="cash">{t('method.cash')}</option>
              <option value="wallet">{t('method.wallet')}</option>
              <option value="card">{t('method.card')}</option>
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.submit_deposit')}
          </button>
        </form>
      )}

      {needsSubmission && !can('wf.sales.rep.act', 'editable') && <div className="empty-state">{t('panel.waiting_for_rep_deposit')}</div>}

      {previewUrl && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={closePreview}
        >
          <div className="card" style={{ maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto', padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{t('panel.deposit_evidence')}</h3>
              <button className="btn btn-secondary" onClick={closePreview}>
                ×
              </button>
            </div>
            <img
              src={previewUrl}
              alt={t('panel.deposit_evidence')}
              style={{ maxWidth: '85vw', maxHeight: '75vh', display: 'block' }}
              onError={(e) => {
                // Not an image (e.g. a PDF) — swap to an iframe embed instead of a broken <img>.
                const el = e.currentTarget;
                el.style.display = 'none';
                const frame = document.createElement('iframe');
                frame.src = previewUrl;
                frame.style.width = '85vw';
                frame.style.height = '75vh';
                frame.style.border = 'none';
                el.parentElement?.appendChild(frame);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
