import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';
import { CompanyMembers } from './CompanyMembers';
import { CompanyPackage } from './CompanyPackage';
import { fmtDateTime } from '../../lib/formatDateTime';
import { loadingLabel } from '../../lib/displayNames';

interface CompanyView {
  id: string;
  name: string;
  status: 'PROVISIONING' | 'READY' | 'DEGRADED' | 'SUSPENDED' | 'MIGRATING' | 'FAILED' | 'DECOMMISSIONED';
  createdAt: string;
  databaseStatus: string | null;
}

/** XNEXUS Control Plane — Company Details / Lifecycle (P1.5). Real `GET/POST /installation/companies/:id[...]` only. */
export function CompanyDetails() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const { selectCompany, refreshMemberships } = useAuth();
  const navigate = useNavigate();
  const [company, setCompany] = useState<CompanyView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  preload([
    'field.company_details',
    'field.company_name',
    'field.status',
    'field.database_status',
    'field.created_at',
    'action.open_company',
    'action.suspend_company',
    'action.reactivate_company',
    'action.decommission_company',
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
    if (!id) return;
    setError(null);
    try {
      setCompany(await api.get<CompanyView>(`/installation/companies/${id}`));
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onOpen() {
    if (!company) return;
    setBusy(true);
    setActionError(null);
    try {
      await refreshMemberships();
      await selectCompany(company.id);
      navigate('/');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not open company.');
      setBusy(false);
    }
  }

  async function onLifecycleAction(action: 'suspend' | 'reactivate' | 'decommission', confirmCode: string) {
    if (!company || !window.confirm(t(confirmCode))) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/installation/companies/${company.id}/${action}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Could not ${action} company.`);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!company) return <div className="empty-state">{loadingLabel()}</div>;

  const terminal = company.status === 'PROVISIONING' || company.status === 'DECOMMISSIONED';

  return (
    <div>
      <div className="page-header">
        <h1>{company.name}</h1>
      </div>

      {actionError && <div className="error-text">{actionError}</div>}

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
        <div>
          <label>{t('field.status')}</label>
          <div>
            <StatusBadge code={`value.company_status.${company.status.toLowerCase()}`} />
          </div>
        </div>
        <div>
          <label>{t('field.database_status')}</label>
          <div>{company.databaseStatus ?? '—'}</div>
        </div>
        <div>
          <label>{t('field.created_at')}</label>
          <div>{fmtDateTime(company.createdAt)}</div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn btn-primary" disabled={busy || company.status !== 'READY'} onClick={onOpen}>
            {t('action.open_company')}
          </button>
          {!terminal && (
            <>
              <button
                className="btn btn-secondary"
                disabled={busy || company.status === 'SUSPENDED'}
                onClick={() => onLifecycleAction('suspend', 'panel.confirm_suspend_company')}
              >
                {t('action.suspend_company')}
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy || company.status === 'READY'}
                onClick={() => onLifecycleAction('reactivate', 'panel.confirm_reactivate_company')}
              >
                {t('action.reactivate_company')}
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => onLifecycleAction('decommission', 'panel.confirm_decommission_company')}>
                {t('action.decommission_company')}
              </button>
            </>
          )}
        </div>
      </div>

      <CompanyPackage companyId={company.id} enabled={company.status === 'READY'} />
      <CompanyMembers companyId={company.id} enabled={company.status === 'READY'} />
    </div>
  );
}
