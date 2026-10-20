import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';
import { loadingLabel } from '../../lib/displayNames';

const FISCAL_CLOSING_REQUEST_TYPE_CODES = [
  'accounting.fiscal_period.close',
  'accounting.fiscal_period.reclose',
  'accounting.fiscal_period.reopen',
  'accounting.fiscal_year.close',
];

interface FiscalYear {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
}
interface FiscalPeriod {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
}

const PRELOAD = [
  'nav.fiscal_periods',
  'field.fiscal_year',
  'field.fiscal_period',
  'field.code',
  'field.start_date',
  'field.end_date',
  'field.status',
  'field.actions',
  'action.create_fiscal_year',
  'action.activate_fiscal_year',
  'action.close_fiscal_year',
  'action.reopen_fiscal_period',
  'action.soft_close',
  'action.reopen_from_soft_close',
  'action.submit_period_close',
  'field.fiscal_year_status',
  'field.fiscal_period_status',
  ...(['planned', 'active', 'closed'] as const).map((s) => `value.fiscal_year_status.${s}`),
  ...(['open', 'soft_close', 'closed', 'reopened'] as const).map((s) => `value.fiscal_period_status.${s}`),
  'panel.fiscal_closing_submitted_approval',
  'panel.no_fiscal_years_yet',
  'nav.closing_audit',
  'nav.closing_exceptions',
  'nav.closing_snapshots',
  'panel.blocking_exceptions_exist',
];

/**
 * Frontend Gap Closure (2026-09-19) — Fiscal Period / Month-End Closing's
 * own dedicated operational entry point. This is the exact Fiscal
 * Year/Period management block `AccountingSettings.tsx` already had
 * (currencies/tax settings kept it company by historical accident, not
 * design — F01/ADR-032 seeded it as one "module configuration" screen
 * before Month-End Closing existed as its own capability), extracted
 * verbatim — same state shape, same handlers, same API calls, same
 * ADR-058 fixes (the `reopened`-state button already correctly calls
 * `submitPeriodClose`, never the blocked `close_after_reopen` action) —
 * onto its own page/route/sidebar entry so Fiscal Period management reads
 * as the Month-End Control surface it actually is, not a settings
 * sub-section. No backend, API, or business-logic change; every action
 * below calls the SAME already-existing endpoint it always did.
 */
export function FiscalPeriods() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [fiscalYears, setFiscalYears] = useState<FiscalYear[] | null>(null);
  const [periodsByYear, setPeriodsByYear] = useState<Record<string, FiscalPeriod[]>>({});
  const [blockingCountByPeriod, setBlockingCountByPeriod] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [fyCode, setFyCode] = useState('');
  const [fyStart, setFyStart] = useState('');
  const [fyEnd, setFyEnd] = useState('');

  async function loadFiscalYears() {
    try {
      setFiscalYears(await api.get<FiscalYear[]>('/accounting/fiscal-years'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load fiscal years.');
    }
  }

  useEffect(() => {
    loadFiscalYears();
  }, []);

  async function loadPeriods(fiscalYearId: string) {
    try {
      const p = await api.get<FiscalPeriod[]>(`/accounting/fiscal-years/${fiscalYearId}/periods`);
      setPeriodsByYear((prev) => ({ ...prev, [fiscalYearId]: p }));
      // ADR-058 (CTO decision 3): visually disable Submit Close when blocking exceptions are open —
      // the backend (`assertCleanForClose`) already refuses authoritatively regardless of this check.
      for (const period of p) {
        if (period.status === 'soft_close' || period.status === 'reopened') {
          loadBlockingCount(period.id);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load fiscal periods.');
    }
  }

  async function loadBlockingCount(periodId: string) {
    try {
      const exceptions = await api.get<Array<{ severity: string; status: string }>>(`/accounting/fiscal-periods/${periodId}/closing-exceptions`);
      const count = exceptions.filter((e) => e.severity === 'blocking' && (e.status === 'open' || e.status === 'acknowledged')).length;
      setBlockingCountByPeriod((prev) => ({ ...prev, [periodId]: count }));
    } catch {
      // Non-fatal — the button simply won't be pre-emptively disabled; the backend still enforces.
    }
  }

  async function onCreateFiscalYear(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/fiscal-years', { code: fyCode, startDate: fyStart, endDate: fyEnd });
      setFyCode('');
      setFyStart('');
      setFyEnd('');
      await loadFiscalYears();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create fiscal year.');
    } finally {
      setBusy(false);
    }
  }

  async function activateFiscalYear(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fiscal-years/${id}/activate`);
      await loadFiscalYears();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to activate fiscal year.');
    } finally {
      setBusy(false);
    }
  }

  async function submitYearClose(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fiscal-years/${id}/close`);
      setMessage(t('panel.fiscal_closing_submitted_approval'));
      await loadFiscalYears();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit fiscal year close.');
    } finally {
      setBusy(false);
    }
  }

  async function transitionPeriod(fiscalYearId: string, periodId: string, action: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fiscal-periods/${periodId}/transition`, { action });
      await loadPeriods(fiscalYearId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to transition fiscal period.');
    } finally {
      setBusy(false);
    }
  }

  async function submitPeriodClose(fiscalYearId: string, periodId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fiscal-periods/${periodId}/close`);
      setMessage(t('panel.fiscal_closing_submitted_approval'));
      await loadPeriods(fiscalYearId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit fiscal period close.');
    } finally {
      setBusy(false);
    }
  }

  async function submitPeriodReopen(fiscalYearId: string, periodId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/fiscal-periods/${periodId}/reopen`);
      setMessage(t('panel.fiscal_closing_submitted_approval'));
      await loadPeriods(fiscalYearId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit fiscal period reopen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.fiscal_periods')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}
      {message && <div className="empty-state">{message}</div>}

      <ApprovalsPanel requestTypeCodes={FISCAL_CLOSING_REQUEST_TYPE_CODES} decidePath={(id) => `/approvals/requests/${id}/decide`} onDecided={loadFiscalYears} />

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.fiscal_year')}</h3>
        <form onSubmit={onCreateFiscalYear} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.code')}</label>
            <input value={fyCode} onChange={(e) => setFyCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.start_date')}</label>
            <input type="date" value={fyStart} onChange={(e) => setFyStart(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.end_date')}</label>
            <input type="date" value={fyEnd} onChange={(e) => setFyEnd(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_fiscal_year')}
          </button>
        </form>

        {fiscalYears === null ? (
          <div className="empty-state">{loadingLabel()}</div>
        ) : fiscalYears.length === 0 ? (
          <div className="empty-state">{t('panel.no_fiscal_years_yet')}</div>
        ) : (
          fiscalYears.map((fy) => (
            <div key={fy.id} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <strong>{fy.code}</strong>
                <span>
                  {fy.startDate} — {fy.endDate}
                </span>
                <StatusBadge code={`value.fiscal_year_status.${fy.status}`} />
                {fy.status === 'planned' && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => activateFiscalYear(fy.id)}>
                    {t('action.activate_fiscal_year')}
                  </button>
                )}
                {fy.status === 'active' && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => submitYearClose(fy.id)}>
                    {t('action.close_fiscal_year')}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={() => loadPeriods(fy.id)}>
                  {t('field.fiscal_period')}
                </button>
              </div>
              {periodsByYear[fy.id] && (
                <table className="data-table" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>{t('field.code')}</th>
                      <th>{t('field.start_date')}</th>
                      <th>{t('field.end_date')}</th>
                      <th>{t('field.status')}</th>
                      <th>{t('field.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periodsByYear[fy.id].map((p) => (
                      <tr key={p.id}>
                        <td>{p.code}</td>
                        <td>{p.startDate}</td>
                        <td>{p.endDate}</td>
                        <td>
                          <StatusBadge code={`value.fiscal_period_status.${p.status}`} />
                        </td>
                        <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {p.status === 'open' && (
                            <button className="btn btn-secondary" disabled={busy} onClick={() => transitionPeriod(fy.id, p.id, 'soft_close')}>
                              {t('action.soft_close')}
                            </button>
                          )}
                          {p.status === 'soft_close' && (
                            <>
                              <button className="btn btn-secondary" disabled={busy} onClick={() => transitionPeriod(fy.id, p.id, 'reopen_from_soft_close')}>
                                {t('action.reopen_from_soft_close')}
                              </button>
                              <button
                                className="btn btn-secondary"
                                disabled={busy || (blockingCountByPeriod[p.id] ?? 0) > 0}
                                title={(blockingCountByPeriod[p.id] ?? 0) > 0 ? t('panel.blocking_exceptions_exist') : undefined}
                                onClick={() => submitPeriodClose(fy.id, p.id)}
                              >
                                {t('action.submit_period_close')}
                              </button>
                            </>
                          )}
                          {p.status === 'closed' && (
                            <button className="btn btn-secondary" disabled={busy} onClick={() => submitPeriodReopen(fy.id, p.id)}>
                              {t('action.reopen_fiscal_period')}
                            </button>
                          )}
                          {p.status === 'reopened' && (
                            /* ADR-058 (Wave 1 Frontend Completion) — fixed regression: this used to call the routine
                               `transitionPeriod(..., 'close_after_reopen')`, which ADR-051 §1.2 removed from the ungated
                               action list. Reuses the SAME already-unified `submitPeriodClose` the soft_close branch
                               above uses — it picks the reclose FA-01 request type automatically from the period's
                               own current state. */
                            <button
                              className="btn btn-secondary"
                              disabled={busy || (blockingCountByPeriod[p.id] ?? 0) > 0}
                              title={(blockingCountByPeriod[p.id] ?? 0) > 0 ? t('panel.blocking_exceptions_exist') : undefined}
                              onClick={() => submitPeriodClose(fy.id, p.id)}
                            >
                              {t('action.submit_period_close')}
                            </button>
                          )}
                          <Link to={`/accounting/fiscal-periods/${p.id}/closing-audit`} className="btn btn-secondary">
                            {t('nav.closing_audit')}
                          </Link>
                          <Link to={`/accounting/fiscal-periods/${p.id}/closing-exceptions`} className="btn btn-secondary">
                            {t('nav.closing_exceptions')}
                          </Link>
                          <Link to={`/accounting/fiscal-periods/${p.id}/closing-snapshots`} className="btn btn-secondary">
                            {t('nav.closing_snapshots')}
                          </Link>
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
    </div>
  );
}
