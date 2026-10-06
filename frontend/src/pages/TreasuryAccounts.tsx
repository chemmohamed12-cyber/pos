import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface TreasuryAccountType {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
}
interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
  accountTypeId: string;
  accountTypeCode: string;
  accountTypeName: string;
  status: 'active' | 'inactive';
  balance: string;
  glAccountCode: string | null;
  createdAt: string;
}
/** Subset of `GET /accounting/accounts` the mapping picker needs. */
interface GlAccountOption {
  code: string;
  name: string;
  nameAr: string | null;
  accountType: string;
  isPostable: boolean;
  isActive: boolean;
  controlFunction: string | null;
}

const NEXT_STATUS: Record<'active' | 'inactive', 'active' | 'inactive'> = { active: 'inactive', inactive: 'active' };

/**
 * Financial/Treasury Core — Accounts screen. Account Type -> Accounts
 * hierarchy (CTO directive — Treasury Payment Types): types are data
 * (`GET/POST /treasury/account-types`), so a new type is one row, never
 * a Treasury Core rebuild. Reachable only by finance/admin.
 */
export function TreasuryAccounts() {
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [types, setTypes] = useState<TreasuryAccountType[]>([]);
  const [accounts, setAccounts] = useState<TreasuryAccount[] | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accountTypeId, setAccountTypeId] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [typeName, setTypeName] = useState('');
  const [creating, setCreating] = useState(false);
  const [creatingType, setCreatingType] = useState(false);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // D2: GL mapping editor. `glAccounts === null` = the chart could not be listed (e.g. accounting not entitled) — the editor then falls back to a free-text code; the backend remains the real gate.
  const [glAccounts, setGlAccounts] = useState<GlAccountOption[] | null>(null);
  const [mappingDraft, setMappingDraft] = useState<Record<string, string>>({});
  const [busyMapping, setBusyMapping] = useState<string | null>(null);

  preload([
    'field.gl_mapping',
    'value.gl_mapping.mapped',
    'value.gl_mapping.unmapped',
    'panel.gl_mapping_required',
    'action.save_gl_mapping',
    'action.clear_gl_mapping',
    'panel.select_gl_account',
    'nav.treasury_accounts',
    'nav.treasury_account_types',
    'field.account_code',
    'field.account_name',
    'field.account_type',
    'field.account_type_code',
    'field.account_type_name',
    'field.balance',
    'field.status',
    'field.created_at',
    'field.actions',
    'action.create_account',
    'action.create_account_type',
    'action.activate_warehouse',
    'action.deactivate_warehouse',
    'panel.treasury_ledger',
  ]);

  async function loadTypes() {
    try {
      const t2 = await api.get<TreasuryAccountType[]>('/treasury/account-types');
      setTypes(t2);
      if (!accountTypeId && t2.length > 0) setAccountTypeId(t2[0].id);
    } catch (err) {
      // Foundation fix: mount-time load had no error handling — the account-type
      // selector was silently left empty on failure.
      setError(err instanceof ApiError ? err.message : 'Failed to load account types.');
    }
  }

  async function loadAccounts() {
    try {
      setAccounts(await api.get<TreasuryAccount[]>('/treasury/accounts'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load treasury accounts.');
    }
  }

  async function loadGlAccounts() {
    try {
      setGlAccounts(await api.get<GlAccountOption[]>('/accounting/accounts'));
    } catch {
      setGlAccounts(null);
    }
  }

  async function saveMapping(a: TreasuryAccount, glAccountCode: string | null) {
    setBusyMapping(a.id);
    setError(null);
    try {
      await api.post(`/treasury/accounts/${a.id}/gl-mapping`, { glAccountCode });
      setMappingDraft((d) => {
        const { [a.id]: _removed, ...rest } = d;
        return rest;
      });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save GL mapping.');
    } finally {
      setBusyMapping(null);
    }
  }

  useEffect(() => {
    loadTypes();
    loadAccounts();
    loadGlAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreateType(e: FormEvent) {
    e.preventDefault();
    setCreatingType(true);
    setError(null);
    try {
      await api.post('/treasury/account-types', { code: typeCode, name: typeName });
      setTypeCode('');
      setTypeName('');
      await loadTypes();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create account type.');
    } finally {
      setCreatingType(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/treasury/accounts', { code, name, accountTypeId });
      setCode('');
      setName('');
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create account.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(a: TreasuryAccount) {
    setBusyStatus(a.id);
    setError(null);
    try {
      await api.post(`/treasury/accounts/${a.id}/status`, { status: NEXT_STATUS[a.status] });
      await loadAccounts();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change account status.');
    } finally {
      setBusyStatus(null);
    }
  }

  const groups = types.map((ty) => ({ type: ty, accounts: (accounts ?? []).filter((a) => a.accountTypeId === ty.id) }));

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.treasury_accounts')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('nav.treasury_account_types')}</h3>
        <form onSubmit={onCreateType} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.account_type_code')}</label>
            <input value={typeCode} onChange={(e) => setTypeCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.account_type_name')}</label>
            <input value={typeName} onChange={(e) => setTypeName(e.target.value)} required />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={creatingType}>
            {t('action.create_account_type')}
          </button>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.account_code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.account_name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>{t('field.account_type')}</label>
            <select value={accountTypeId} onChange={(e) => setAccountTypeId(e.target.value)} required>
              {types.map((ty) => (
                <option key={ty.id} value={ty.id}>
                  {ty.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating || !accountTypeId}>
            {t('action.create_account')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {accounts === null ? (
        <div className="empty-state">Loading…</div>
      ) : (
        groups.map(({ type: ty, accounts: groupAccounts }) => (
          <div key={ty.id} style={{ marginBottom: 20 }}>
            <h3>{ty.name}</h3>
            {groupAccounts.length === 0 ? (
              <div className="empty-state">—</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.account_code')}</th>
                    <th>{t('field.account_name')}</th>
                    <th>{t('field.balance')}</th>
                    <th>{t('field.gl_mapping')}</th>
                    <th>{t('field.status')}</th>
                    <th>{t('field.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {groupAccounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.code}</td>
                      <td>{a.name}</td>
                      <td style={{ fontWeight: 600 }}>{a.balance}</td>
                      <td>
                        {a.glAccountCode ? (
                          <span>
                            <strong>{t('value.gl_mapping.mapped')}</strong> → {a.glAccountCode}
                          </span>
                        ) : (
                          <div>
                            <strong>{t('value.gl_mapping.unmapped')}</strong>
                            <div className="error-text" style={{ margin: 0 }}>
                              {t('panel.gl_mapping_required')}
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {glAccounts ? (
                            <select value={mappingDraft[a.id] ?? a.glAccountCode ?? ''} onChange={(e) => setMappingDraft((d) => ({ ...d, [a.id]: e.target.value }))}>
                              <option value="">{t('panel.select_gl_account')}</option>
                              {[...glAccounts]
                                .filter((g) => g.isActive && g.isPostable)
                                .sort((x, y) => Number(y.controlFunction === 'bank') - Number(x.controlFunction === 'bank') || x.code.localeCompare(y.code))
                                .map((g) => (
                                  <option key={g.code} value={g.code}>
                                    {g.code} — {g.nameAr ?? g.name}
                                    {g.controlFunction === 'bank' ? ' ★' : ''}
                                  </option>
                                ))}
                            </select>
                          ) : (
                            <input
                              value={mappingDraft[a.id] ?? a.glAccountCode ?? ''}
                              onChange={(e) => setMappingDraft((d) => ({ ...d, [a.id]: e.target.value }))}
                              placeholder={t('field.gl_account_code')}
                            />
                          )}
                          <button
                            className="btn btn-secondary"
                            disabled={busyMapping === a.id || !(mappingDraft[a.id] ?? '').trim() || (mappingDraft[a.id] ?? '') === (a.glAccountCode ?? '')}
                            onClick={() => saveMapping(a, (mappingDraft[a.id] ?? '').trim())}
                          >
                            {t('action.save_gl_mapping')}
                          </button>
                          {a.glAccountCode && (
                            <button className="btn btn-secondary" disabled={busyMapping === a.id} onClick={() => saveMapping(a, null)}>
                              {t('action.clear_gl_mapping')}
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusBadge code={`warehouse_status.${a.status}`} />
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary" onClick={() => navigate(`/treasury/ledger?accountId=${a.id}`)}>
                          {t('panel.treasury_ledger')}
                        </button>
                        <button className="btn btn-secondary" disabled={busyStatus === a.id} onClick={() => toggleStatus(a)}>
                          {t(a.status === 'active' ? 'action.deactivate_warehouse' : 'action.activate_warehouse')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))
      )}
    </div>
  );
}
