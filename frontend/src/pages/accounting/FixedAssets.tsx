import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { Link } from 'react-router-dom';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';
import { StatusBadge } from '../../components/StatusBadge';
import { loadingLabel } from '../../lib/displayNames';

interface GLAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
}
interface FixedAsset {
  id: string;
  code: string;
  name: string;
  acquisitionDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  depreciationMethod: string;
  costAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  acquisitionJournalEntryId: string | null;
  /** D8 — pending_acquisition → active (after the acquisition JE is linked) → disposed. */
  lifecycleState?: string;
}
interface AcquisitionCandidate {
  journalEntryId: string;
  entryNumber: string | null;
  businessDate: string;
  description: string | null;
  debit: string;
}
interface DepreciationRun {
  id: string;
  depreciationPeriod: string;
  businessDate: string;
  createdAt: string;
}

const PRELOAD = [
  'nav.fixed_assets',
  'field.asset_code',
  'field.asset_name',
  'field.acquisition_date',
  'field.cost',
  'field.salvage_value',
  'field.useful_life_months',
  'field.depreciation_method',
  'field.cost_account',
  'field.accumulated_depreciation_account',
  'field.depreciation_expense_account',
  'field.depreciation_period',
  'field.disposal_date',
  'field.proceeds',
  'field.actions',
  'value.depreciation_method.straight_line',
  'action.create_fixed_asset',
  'action.run_depreciation',
  'action.dispose_asset',
  'action.submit_fixed_asset_disposal',
  'action.save',
  'action.cancel',
  'panel.no_fixed_assets_yet',
  'panel.no_depreciation_runs_yet',
  'panel.fixed_asset_disposal_submitted_approval',
  'field.status',
  'fixed_asset_lifecycle.state.pending_acquisition',
  'fixed_asset_lifecycle.state.active',
  'fixed_asset_lifecycle.state.disposed',
  'action.link_acquisition',
  'panel.link_acquisition_steps',
  'panel.link_acquisition_none',
  'field.acquisition_journal',
  'action.open_journals',
  'action.create_acquisition_journal',
  'panel.create_acquisition_journal_hint',
];

function emptyForm() {
  return {
    code: '',
    name: '',
    acquisitionDate: new Date().toISOString().slice(0, 10),
    cost: '',
    salvageValue: '0',
    usefulLifeMonths: '36',
    costAccountId: '',
    accumulatedDepreciationAccountId: '',
    depreciationExpenseAccountId: '',
  };
}

/** F12 — Fixed Assets (ADR-045). Register + depreciation runs + disposal submission + pending-approvals queue. No prior frontend spec existed for this domain (confirmed absent from every terminology seed and from the recovered production bundle's own route list) — built directly against the backend contract in `fixed-asset.controller.ts`. */
export function FixedAssets() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [assets, setAssets] = useState<FixedAsset[] | null>(null);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [runs, setRuns] = useState<DepreciationRun[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [depreciationPeriod, setDepreciationPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [disposeId, setDisposeId] = useState<string | null>(null);
  const [disposalDate, setDisposalDate] = useState(new Date().toISOString().slice(0, 10));
  const [proceeds, setProceeds] = useState('0');
  // D8 — link the acquisition journal (manual JE + link architecture: the UI links an existing POSTED entry, it never creates one)
  const [linkId, setLinkId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AcquisitionCandidate[] | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadAssets() {
    try {
      setAssets(await api.get<FixedAsset[]>('/accounting/fixed-assets'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load fixed assets.');
    }
  }
  async function loadRuns() {
    try {
      setRuns(await api.get<DepreciationRun[]>('/accounting/depreciation-runs'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load depreciation runs.');
    }
  }

  useEffect(() => {
    loadAssets();
    loadRuns();
    api.get<GLAccount[]>('/accounting/accounts?postableOnly=true').then(setAccounts).catch(() => setAccounts([]));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/fixed-assets', {
        ...form,
        usefulLifeMonths: Number(form.usefulLifeMonths),
      });
      setShowCreate(false);
      setForm(emptyForm());
      await loadAssets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create fixed asset.');
    } finally {
      setBusy(false);
    }
  }

  async function openLink(assetId: string) {
    if (linkId === assetId) {
      setLinkId(null);
      return;
    }
    setLinkId(assetId);
    setCandidates(null);
    setCandidateId('');
    try {
      setCandidates(await api.get<AcquisitionCandidate[]>(`/accounting/fixed-assets/${assetId}/acquisition-candidates`));
    } catch (err) {
      setCandidates([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load acquisition journal candidates.');
    }
  }

  async function submitLink(assetId: string) {
    if (!candidateId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fixed-assets/${assetId}/link-acquisition`, { journalEntryId: candidateId });
      setLinkId(null);
      await loadAssets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to link the acquisition journal.');
    } finally {
      setBusy(false);
    }
  }

  /** D8 helper (CTO Option C) — one click: Dr asset cost / Cr Fixed Asset Acquisition Clearing, posted and linked; the server rejects it before any change when the clearing account is not configured. */
  async function createAcquisitionJournal(assetId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fixed-assets/${assetId}/acquisition-journal`, {});
      setLinkId(null);
      await loadAssets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the acquisition journal.');
    } finally {
      setBusy(false);
    }
  }

  async function runDepreciation() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/depreciation-runs', { depreciationPeriod });
      await loadRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to run depreciation.');
    } finally {
      setBusy(false);
    }
  }

  async function submitDisposal(e: FormEvent) {
    e.preventDefault();
    if (!disposeId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/accounting/fixed-assets/${disposeId}/dispose`, { disposalDate, proceeds });
      setNotice(t('panel.fixed_asset_disposal_submitted_approval'));
      setDisposeId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit disposal.');
    } finally {
      setBusy(false);
    }
  }

  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} — ${a.nameAr ?? a.name}` : '—';
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.fixed_assets')}</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
          {t('action.create_fixed_asset')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {notice && <div className="empty-state">{notice}</div>}

      <ApprovalsPanel requestTypeCodes={['accounting.fixed_asset.dispose']} decidePath={(id) => `/accounting/fixed-asset-disposals/${id}/decide`} onDecided={loadAssets} />

      {showCreate && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.asset_code')}</label>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.asset_name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.acquisition_date')}</label>
              <input type="date" value={form.acquisitionDate} onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.cost')}</label>
              <input type="number" min="0.01" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.salvage_value')}</label>
              <input type="number" min="0" step="0.01" value={form.salvageValue} onChange={(e) => setForm({ ...form, salvageValue: e.target.value })} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.useful_life_months')}</label>
              <input type="number" min="1" step="1" value={form.usefulLifeMonths} onChange={(e) => setForm({ ...form, usefulLifeMonths: e.target.value })} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t('field.cost_account')}</label>
              <select value={form.costAccountId} onChange={(e) => setForm({ ...form, costAccountId: e.target.value })} required>
                <option value="">—</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.nameAr ?? a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t('field.accumulated_depreciation_account')}</label>
              <select value={form.accumulatedDepreciationAccountId} onChange={(e) => setForm({ ...form, accumulatedDepreciationAccountId: e.target.value })} required>
                <option value="">—</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.nameAr ?? a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>{t('field.depreciation_expense_account')}</label>
              <select value={form.depreciationExpenseAccountId} onChange={(e) => setForm({ ...form, depreciationExpenseAccountId: e.target.value })} required>
                <option value="">—</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.nameAr ?? a.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setShowCreate(false)}>
              {t('action.cancel')}
            </button>
          </form>
        </div>
      )}

      {assets === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : assets.length === 0 ? (
        <div className="empty-state">{t('panel.no_fixed_assets_yet')}</div>
      ) : (
        <table className="data-table" style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th>{t('field.asset_code')}</th>
              <th>{t('field.asset_name')}</th>
              <th>{t('field.acquisition_date')}</th>
              <th>{t('field.cost')}</th>
              <th>{t('field.depreciation_method')}</th>
              <th>{t('field.cost_account')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td>{a.code}</td>
                <td>{a.name}</td>
                <td>{a.acquisitionDate}</td>
                <td>{a.cost}</td>
                <td>{t(`value.depreciation_method.${a.depreciationMethod}`)}</td>
                <td>{accountLabel(a.costAccountId)}</td>
                <td>{a.lifecycleState ? <StatusBadge code={`fixed_asset_lifecycle.state.${a.lifecycleState}`} /> : '—'}</td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {a.lifecycleState === 'pending_acquisition' && (
                    <button className="btn btn-primary" onClick={() => openLink(a.id)}>
                      {t('action.link_acquisition')}
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={() => setDisposeId(disposeId === a.id ? null : a.id)}>
                    {t('action.dispose_asset')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {linkId && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p style={{ marginTop: 0 }}>{t('panel.link_acquisition_steps')}</p>
          {candidates === null ? (
            <div className="empty-state">{loadingLabel()}</div>
          ) : candidates.length === 0 ? (
            <div className="empty-state">{t('panel.link_acquisition_none')}</div>
          ) : (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 320 }}>
                <label>{t('field.acquisition_journal')}</label>
                <select value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
                  <option value="">—</option>
                  {candidates.map((c) => (
                    <option key={c.journalEntryId} value={c.journalEntryId}>
                      {c.entryNumber ?? c.journalEntryId.slice(0, 8)} · {c.businessDate} · {c.debit}
                      {c.description ? ` · ${c.description}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" disabled={busy || !candidateId} onClick={() => submitLink(linkId)}>
                {t('action.link_acquisition')}
              </button>
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" disabled={busy} onClick={() => createAcquisitionJournal(linkId)}>
              {t('action.create_acquisition_journal')}
            </button>
            <span style={{ fontSize: 12, opacity: 0.75 }}>{t('panel.create_acquisition_journal_hint')}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Link to="/accounting/journals">{t('action.open_journals')}</Link>
          </div>
        </div>
      )}

      {disposeId && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={submitDisposal} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.disposal_date')}</label>
              <input type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.proceeds')}</label>
              <input type="number" min="0" step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
            </div>
            <button className="btn btn-danger" type="submit" disabled={busy}>
              {t('action.submit_fixed_asset_disposal')}
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('action.run_depreciation')}</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.depreciation_period')}</label>
            <input type="month" value={depreciationPeriod} onChange={(e) => setDepreciationPeriod(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={runDepreciation}>
            {t('action.run_depreciation')}
          </button>
        </div>
        {runs === null ? (
          <div className="empty-state">{loadingLabel()}</div>
        ) : runs.length === 0 ? (
          <div className="empty-state">{t('panel.no_depreciation_runs_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.depreciation_period')}</th>
                <th>{t('field.business_date')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.depreciationPeriod}</td>
                  <td>{r.businessDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
