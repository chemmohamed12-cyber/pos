import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';

interface Employee {
  id: string;
  code: string;
  fullName: string;
}
interface Customer {
  id: string;
  code: string;
  name: string;
}
interface CommissionPolicy {
  id: string;
  scope: 'sales_rep' | 'customer' | 'customer_group';
  scopeRefId: string;
  basis: 'gross_sales' | 'net_sales' | 'collected_amount';
  rateModel: 'flat' | 'target_tiered';
  flatRate: string | null;
  status: string;
  createdAt: string;
}
interface CommissionTier {
  id: string;
  tierOrder: number;
  fromPercent: string;
  toPercent: string | null;
  rate: string;
}
interface TierDraft {
  tierOrder: number;
  fromPercent: string;
  toPercent: string;
  rate: string;
}

/** ADR-068 §A/§2/§3 — Commission Policy: scope precedence Customer -> Customer Group [architecturally present, functionally inert, ADR-071 §3/§21] -> Sales Rep, flat or target-tiered rate model. */
export function CommissionPolicies() {
  const { t, preload } = useLanguage();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [policies, setPolicies] = useState<CommissionPolicy[] | null>(null);
  const [tiersByPolicy, setTiersByPolicy] = useState<Record<string, CommissionTier[]>>({});
  const [error, setError] = useState<string | null>(null);

  const [scope, setScope] = useState<'sales_rep' | 'customer' | 'customer_group'>('sales_rep');
  const [scopeRefId, setScopeRefId] = useState('');
  const [basis, setBasis] = useState<'gross_sales' | 'net_sales' | 'collected_amount'>('gross_sales');
  const [rateModel, setRateModel] = useState<'flat' | 'target_tiered'>('flat');
  const [flatRate, setFlatRate] = useState('');
  const [tiers, setTiers] = useState<TierDraft[]>([{ tierOrder: 1, fromPercent: '0', toPercent: '', rate: '' }]);
  const [busy, setBusy] = useState(false);

  preload([
    'nav.commission_policies',
    'field.scope',
    'field.basis',
    'field.rate_model',
    'field.flat_rate',
    'field.rate',
    'field.tier_order',
    'field.from_percent',
    'field.to_percent',
    'field.status',
    'field.actions',
    'action.create_policy',
    'action.add_tier',
    'action.view_tiers',
    'panel.no_policies_yet',
    'panel.customer_group_inert_notice',
    'value.commission_scope.sales_rep',
    'value.commission_scope.customer',
    'value.commission_scope.customer_group',
    'value.commission_basis.gross_sales',
    'value.commission_basis.net_sales',
    'value.commission_basis.collected_amount',
    'value.commission_rate_model.flat',
    'value.commission_rate_model.target_tiered',
  ]);

  async function loadEmployees() {
    setEmployees(await api.get<Employee[]>('/hr/employees'));
  }
  async function loadCustomers() {
    try {
      setCustomers(await api.get<Customer[]>('/customers'));
    } catch {
      setCustomers([]);
    }
  }
  async function loadPolicies() {
    try {
      setPolicies(await api.get<CommissionPolicy[]>('/commission/policies'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load commission policies.');
    }
  }

  useEffect(() => {
    loadEmployees();
    loadCustomers();
    loadPolicies();
  }, []);

  const scopeRefLabel = (policy: CommissionPolicy) => {
    if (policy.scope === 'sales_rep') {
      const emp = employees.find((e) => e.id === policy.scopeRefId);
      return emp ? `${emp.code} — ${emp.fullName}` : policy.scopeRefId.slice(0, 8);
    }
    if (policy.scope === 'customer') {
      const cust = customers.find((c) => c.id === policy.scopeRefId);
      return cust ? `${cust.code} — ${cust.name}` : policy.scopeRefId.slice(0, 8);
    }
    return policy.scopeRefId.slice(0, 8);
  };

  function addTierRow() {
    setTiers((prev) => [...prev, { tierOrder: prev.length + 1, fromPercent: '', toPercent: '', rate: '' }]);
  }
  function updateTier(index: number, patch: Partial<TierDraft>) {
    setTiers((prev) => prev.map((tRow, i) => (i === index ? { ...tRow, ...patch } : tRow)));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/commission/policies', {
        scope,
        scopeRefId,
        basis,
        rateModel,
        flatRate: rateModel === 'flat' ? flatRate : undefined,
        tiers:
          rateModel === 'target_tiered'
            ? tiers.map((tRow) => ({ tierOrder: tRow.tierOrder, fromPercent: tRow.fromPercent, toPercent: tRow.toPercent || null, rate: tRow.rate }))
            : undefined,
      });
      setScopeRefId('');
      setFlatRate('');
      setTiers([{ tierOrder: 1, fromPercent: '0', toPercent: '', rate: '' }]);
      await loadPolicies();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create commission policy.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleTiers(policyId: string) {
    if (tiersByPolicy[policyId]) {
      setTiersByPolicy((prev) => {
        const next = { ...prev };
        delete next[policyId];
        return next;
      });
      return;
    }
    try {
      const rows = await api.get<CommissionTier[]>(`/commission/policies/${policyId}/tiers`);
      setTiersByPolicy((prev) => ({ ...prev, [policyId]: rows }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load tiers.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.commission_policies')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20, background: 'var(--panel-info-bg, #eef4ff)' }}>
        <p style={{ margin: 0 }}>{t('panel.customer_group_inert_notice')}</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>{t('action.create_policy')}</h3>
        <form onSubmit={onCreate}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.scope')}</label>
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as typeof scope);
                  setScopeRefId('');
                }}
              >
                <option value="sales_rep">{t('value.commission_scope.sales_rep')}</option>
                <option value="customer">{t('value.commission_scope.customer')}</option>
                <option value="customer_group">{t('value.commission_scope.customer_group')}</option>
              </select>
            </div>

            {scope === 'sales_rep' && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{t('field.employee')}</label>
                <select value={scopeRefId} onChange={(e) => setScopeRefId(e.target.value)} required>
                  <option value="">—</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.code} — {emp.fullName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {scope === 'customer' && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>Customer</label>
                <select value={scopeRefId} onChange={(e) => setScopeRefId(e.target.value)} required>
                  <option value="">—</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {scope === 'customer_group' && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>Customer Group ID</label>
                <input value={scopeRefId} onChange={(e) => setScopeRefId(e.target.value)} required />
              </div>
            )}

            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.basis')}</label>
              <select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
                <option value="gross_sales">{t('value.commission_basis.gross_sales')}</option>
                <option value="net_sales">{t('value.commission_basis.net_sales')}</option>
                <option value="collected_amount">{t('value.commission_basis.collected_amount')}</option>
              </select>
            </div>

            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.rate_model')}</label>
              <select value={rateModel} onChange={(e) => setRateModel(e.target.value as typeof rateModel)}>
                <option value="flat">{t('value.commission_rate_model.flat')}</option>
                <option value="target_tiered">{t('value.commission_rate_model.target_tiered')}</option>
              </select>
            </div>

            {rateModel === 'flat' && (
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.flat_rate')}</label>
                <input value={flatRate} onChange={(e) => setFlatRate(e.target.value)} placeholder="0.05" required />
              </div>
            )}
          </div>

          {rateModel === 'target_tiered' && (
            <div style={{ marginBottom: 12 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.tier_order')}</th>
                    <th>{t('field.from_percent')}</th>
                    <th>{t('field.to_percent')}</th>
                    <th>{t('field.rate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((tRow, i) => (
                    <tr key={i}>
                      <td>{tRow.tierOrder}</td>
                      <td>
                        <input value={tRow.fromPercent} onChange={(e) => updateTier(i, { fromPercent: e.target.value })} style={{ width: 80 }} required />
                      </td>
                      <td>
                        <input value={tRow.toPercent} onChange={(e) => updateTier(i, { toPercent: e.target.value })} style={{ width: 80 }} placeholder="∞" />
                      </td>
                      <td>
                        <input value={tRow.rate} onChange={(e) => updateTier(i, { rate: e.target.value })} style={{ width: 80 }} placeholder="0.05" required />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={addTierRow}>
                {t('action.add_tier')}
              </button>
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_policy')}
          </button>
        </form>
      </div>

      {policies === null ? (
        <div className="empty-state">Loading…</div>
      ) : policies.length === 0 ? (
        <div className="empty-state">{t('panel.no_policies_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.scope')}</th>
              <th>Scope Ref</th>
              <th>{t('field.basis')}</th>
              <th>{t('field.rate_model')}</th>
              <th>{t('field.flat_rate')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <Fragment key={p.id}>
                <tr>
                  <td>
                    <StatusBadge code={`value.commission_scope.${p.scope}`} />
                  </td>
                  <td>{scopeRefLabel(p)}</td>
                  <td>{t(`value.commission_basis.${p.basis}`)}</td>
                  <td>{t(`value.commission_rate_model.${p.rateModel}`)}</td>
                  <td>{p.flatRate ?? '—'}</td>
                  <td>{p.status}</td>
                  <td>
                    {p.rateModel === 'target_tiered' && (
                      <button className="btn btn-secondary" onClick={() => toggleTiers(p.id)}>
                        {tiersByPolicy[p.id] ? '▲' : '▼'} {t('action.view_tiers')}
                      </button>
                    )}
                  </td>
                </tr>
                {tiersByPolicy[p.id] && (
                  <tr>
                    <td colSpan={7}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{t('field.tier_order')}</th>
                            <th>{t('field.from_percent')}</th>
                            <th>{t('field.to_percent')}</th>
                            <th>{t('field.rate')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tiersByPolicy[p.id].map((tRow) => (
                            <tr key={tRow.id}>
                              <td>{tRow.tierOrder}</td>
                              <td>{tRow.fromPercent}</td>
                              <td>{tRow.toPercent ?? '∞'}</td>
                              <td>{tRow.rate}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
