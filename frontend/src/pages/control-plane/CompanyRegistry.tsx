import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';

interface CompanyView {
  id: string;
  name: string;
  status: 'PROVISIONING' | 'READY' | 'DEGRADED' | 'SUSPENDED' | 'MIGRATING' | 'FAILED' | 'DECOMMISSIONED';
  createdAt: string;
  databaseStatus: string | null;
}

/**
 * XNEXUS Control Plane — Company Registry (P1.3). Real `GET
 * /installation/companies` (`CompanyRegistryController`) only — no
 * fabricated rows, no client-side company list. XNEXUS itself is never a
 * row here; this lists operational Company tenants under the Installation.
 */
export function CompanyRegistry() {
  const { t, preload, lang } = useLanguage();
  const { selectCompany, refreshMemberships } = useAuth();
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<CompanyView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  preload([
    'module.control_plane',
    'nav.company_registry',
    'field.company_name',
    'field.status',
    'field.database_status',
    'field.created_at',
    'action.create_company',
    'action.open_company',
    'action.suspend_company',
    'action.reactivate_company',
    'action.decommission_company',
    'panel.no_companies_yet',
    'panel.confirm_suspend_company',
    'panel.confirm_reactivate_company',
    'panel.confirm_decommission_company',
    'value.company_status.provisioning',
    'value.company_status.ready',
    'value.company_status.degraded',
    'value.company_status.suspended',
    'value.company_status.migrating',
    'value.company_status.failed',
    'value.company_status.decommissioned',
  ]);

  async function load() {
    setError(null);
    try {
      setCompanies(await api.get<CompanyView[]>('/installation/companies'));
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onOpen(company: CompanyView) {
    setBusyId(company.id);
    setActionError(null);
    try {
      // The just-refreshed membership list may not yet include a Company this
      // admin was only just granted access to — refresh before selecting so
      // `selectCompany` can resolve its name/status from a current list.
      await refreshMemberships();
      await selectCompany(company.id);
      navigate('/');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not open company.');
      setBusyId(null);
    }
  }

  async function onLifecycleAction(company: CompanyView, action: 'suspend' | 'reactivate' | 'decommission', confirmCode: string) {
    if (!window.confirm(t(confirmCode))) return;
    setBusyId(company.id);
    setActionError(null);
    try {
      await api.post(`/installation/companies/${company.id}/${action}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Could not ${action} company.`);
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.company_registry')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/control-plane/plans" className="btn btn-secondary">
            {lang === 'ar' ? 'الباقات' : 'Plans'}
          </Link>
          <Link to="/control-plane/companies/new" className="btn btn-primary">
            {t('action.create_company')}
          </Link>
        </div>
      </div>

      {actionError && <div className="error-text">{actionError}</div>}

      {companies === null ? (
        <div className="empty-state">Loading…</div>
      ) : companies.length === 0 ? (
        <div className="empty-state">{t('panel.no_companies_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.company_name')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.database_status')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => {
              const busy = busyId === c.id;
              const terminal = c.status === 'PROVISIONING' || c.status === 'DECOMMISSIONED';
              return (
                <tr key={c.id}>
                  <td>
                    <Link to={`/control-plane/companies/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>
                    <StatusBadge code={`value.company_status.${c.status.toLowerCase()}`} />
                  </td>
                  <td>{c.databaseStatus ?? '—'}</td>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                  <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" disabled={busy || c.status !== 'READY'} onClick={() => onOpen(c)}>
                      {t('action.open_company')}
                    </button>
                    {!terminal && (
                      <>
                        <button
                          className="btn btn-secondary"
                          disabled={busy || c.status === 'SUSPENDED'}
                          onClick={() => onLifecycleAction(c, 'suspend', 'panel.confirm_suspend_company')}
                        >
                          {t('action.suspend_company')}
                        </button>
                        <button
                          className="btn btn-secondary"
                          disabled={busy || c.status === 'READY'}
                          onClick={() => onLifecycleAction(c, 'reactivate', 'panel.confirm_reactivate_company')}
                        >
                          {t('action.reactivate_company')}
                        </button>
                        <button
                          className="btn btn-danger"
                          disabled={busy}
                          onClick={() => onLifecycleAction(c, 'decommission', 'panel.confirm_decommission_company')}
                        >
                          {t('action.decommission_company')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
