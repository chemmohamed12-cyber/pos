import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ApprovalsPanel } from '../../components/ApprovalsPanel';

const FISCAL_CLOSING_REQUEST_TYPE_CODES = [
  'accounting.fiscal_period.close',
  'accounting.fiscal_period.reclose',
  'accounting.fiscal_period.reopen',
  'accounting.fiscal_year.close',
];

const ROUNDING_MODES = ['half_up', 'half_even', 'half_down'] as const;

interface Currency {
  code: string;
  name: string;
  symbol: string;
  roundingMode: (typeof ROUNDING_MODES)[number];
  isBaseCurrency: boolean;
  isActive: boolean;
}
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
interface TaxCode {
  id: string;
  code: string;
  name: string;
  rate: string;
  isInclusive: boolean;
  isActive: boolean;
}
interface TaxPeriod {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
}

const PRELOAD = [
  'nav.accounting_settings',
  'field.currency_code',
  'field.currency_name',
  'field.symbol',
  'field.rounding_mode',
  'field.is_base_currency',
  'field.rate_date',
  'field.rate',
  'field.fiscal_year',
  'field.fiscal_period',
  'field.start_date',
  'field.end_date',
  'field.tax_code',
  'field.is_inclusive',
  'field.tax_period',
  'field.jurisdiction_code',
  'field.status',
  'field.actions',
  ...ROUNDING_MODES.map((m) => `value.rounding_mode.${m}`),
  'action.create_currency',
  'action.set_base_currency',
  'action.deactivate_currency',
  'action.record_exchange_rate',
  'action.create_fiscal_year',
  'action.activate_fiscal_year',
  'action.close_fiscal_year',
  'action.reopen_fiscal_period',
  'action.soft_close',
  'action.reopen_from_soft_close',
  'action.close_after_reopen',
  'action.submit_period_close',
  'action.create_tax_code',
  'action.create_tax_period',
  'action.save',
  'field.fiscal_year_status',
  'field.fiscal_period_status',
  ...(['planned', 'active', 'closed'] as const).map((s) => `value.fiscal_year_status.${s}`),
  ...(['open', 'soft_close', 'closed', 'reopened'] as const).map((s) => `value.fiscal_period_status.${s}`),
  'panel.fiscal_closing_submitted_approval',
  'panel.no_currencies_yet',
  'panel.no_fiscal_years_yet',
  'panel.no_tax_codes_yet',
  'nav.closing_audit',
  'nav.closing_exceptions',
  'nav.closing_snapshots',
  'panel.blocking_exceptions_exist',
];

/** F01 — Financial Foundation (ADR-032). Currencies + Fiscal Years/Periods + Tax Codes/Periods — the module-level configuration screens `nav.accounting_settings` was seeded for. */
export function AccountingSettings() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [currencies, setCurrencies] = useState<Currency[] | null>(null);
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[] | null>(null);
  const [periodsByYear, setPeriodsByYear] = useState<Record<string, FiscalPeriod[]>>({});
  const [blockingCountByPeriod, setBlockingCountByPeriod] = useState<Record<string, number>>({});
  const [taxCodes, setTaxCodes] = useState<TaxCode[] | null>(null);
  const [taxPeriods, setTaxPeriods] = useState<TaxPeriod[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [curCode, setCurCode] = useState('');
  const [curName, setCurName] = useState('');
  const [curSymbol, setCurSymbol] = useState('');
  const [curRounding, setCurRounding] = useState<(typeof ROUNDING_MODES)[number]>('half_up');

  const [rateForCode, setRateForCode] = useState('');
  const [rateDate, setRateDate] = useState(new Date().toISOString().slice(0, 10));
  const [rateValue, setRateValue] = useState('');

  const [fyCode, setFyCode] = useState('');
  const [fyStart, setFyStart] = useState('');
  const [fyEnd, setFyEnd] = useState('');

  const [taxCode, setTaxCode] = useState('');
  const [taxName, setTaxName] = useState('');
  const [taxRate, setTaxRate] = useState('');

  const [taxPeriodCode, setTaxPeriodCode] = useState('');
  const [taxPeriodStart, setTaxPeriodStart] = useState('');
  const [taxPeriodEnd, setTaxPeriodEnd] = useState('');

  async function loadCurrencies() {
    try {
      setCurrencies(await api.get<Currency[]>('/accounting/currencies'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load currencies.');
    }
  }
  async function loadFiscalYears() {
    try {
      setFiscalYears(await api.get<FiscalYear[]>('/accounting/fiscal-years'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load fiscal years.');
    }
  }
  async function loadTaxCodes() {
    try {
      setTaxCodes(await api.get<TaxCode[]>('/accounting/tax-codes'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load tax codes.');
    }
  }
  async function loadTaxPeriods() {
    try {
      setTaxPeriods(await api.get<TaxPeriod[]>('/accounting/tax-periods'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load tax periods.');
    }
  }

  useEffect(() => {
    loadCurrencies();
    loadFiscalYears();
    loadTaxCodes();
    loadTaxPeriods();
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

  async function onCreateCurrency(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/currencies', { code: curCode.toUpperCase(), name: curName, symbol: curSymbol, roundingMode: curRounding });
      setCurCode('');
      setCurName('');
      setCurSymbol('');
      await loadCurrencies();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create currency.');
    } finally {
      setBusy(false);
    }
  }

  async function setBaseCurrency(code: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/currencies/${code}/set-base`);
      await loadCurrencies();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set base currency.');
    } finally {
      setBusy(false);
    }
  }

  async function deactivateCurrency(code: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/currencies/${code}/deactivate`);
      await loadCurrencies();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to deactivate currency.');
    } finally {
      setBusy(false);
    }
  }

  async function recordRate(e: FormEvent) {
    e.preventDefault();
    if (!rateForCode) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/currencies/${rateForCode}/exchange-rates`, { rateDate, rate: rateValue, rateSource: 'manual' });
      setRateValue('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record exchange rate.');
    } finally {
      setBusy(false);
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

  async function toggleTaxCodeActive(tc: TaxCode) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounting/tax-codes/${tc.id}`, { isActive: !tc.isActive });
      await loadTaxCodes();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update tax code.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateTaxCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/tax-codes', { code: taxCode, name: taxName, rate: taxRate });
      setTaxCode('');
      setTaxName('');
      setTaxRate('');
      await loadTaxCodes();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create tax code.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateTaxPeriod(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/tax-periods', { code: taxPeriodCode, startDate: taxPeriodStart, endDate: taxPeriodEnd });
      setTaxPeriodCode('');
      setTaxPeriodStart('');
      setTaxPeriodEnd('');
      await loadTaxPeriods();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create tax period.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.accounting_settings')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}
      {message && <div className="empty-state">{message}</div>}

      <ApprovalsPanel requestTypeCodes={FISCAL_CLOSING_REQUEST_TYPE_CODES} decidePath={(id) => `/approvals/requests/${id}/decide`} onDecided={loadFiscalYears} />

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('action.create_currency')}</h3>
        <form onSubmit={onCreateCurrency} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div className="form-field" style={{ marginBottom: 0, width: 80 }}>
            <label>{t('field.currency_code')}</label>
            <input value={curCode} onChange={(e) => setCurCode(e.target.value)} maxLength={3} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.currency_name')}</label>
            <input value={curName} onChange={(e) => setCurName(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, width: 80 }}>
            <label>{t('field.symbol')}</label>
            <input value={curSymbol} onChange={(e) => setCurSymbol(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.rounding_mode')}</label>
            <select value={curRounding} onChange={(e) => setCurRounding(e.target.value as never)}>
              {ROUNDING_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`value.rounding_mode.${m}`)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_currency')}
          </button>
        </form>

        {currencies === null ? (
          <div className="empty-state">Loading…</div>
        ) : currencies.length === 0 ? (
          <div className="empty-state">{t('panel.no_currencies_yet')}</div>
        ) : (
          <table className="data-table" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>{t('field.currency_code')}</th>
                <th>{t('field.currency_name')}</th>
                <th>{t('field.symbol')}</th>
                <th>{t('field.is_base_currency')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => (
                <tr key={c.code}>
                  <td>{c.code}</td>
                  <td>{c.name}</td>
                  <td>{c.symbol}</td>
                  <td>{c.isBaseCurrency ? '✓' : ''}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    {!c.isBaseCurrency && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => setBaseCurrency(c.code)}>
                        {t('action.set_base_currency')}
                      </button>
                    )}
                    {c.isActive && !c.isBaseCurrency && (
                      <button className="btn btn-secondary" disabled={busy} onClick={() => deactivateCurrency(c.code)}>
                        {t('action.deactivate_currency')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form onSubmit={recordRate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.currency_code')}</label>
            <select value={rateForCode} onChange={(e) => setRateForCode(e.target.value)} required>
              <option value="">—</option>
              {(currencies ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.rate_date')}</label>
            <input type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.rate')}</label>
            <input type="number" min="0" step="0.00000001" value={rateValue} onChange={(e) => setRateValue(e.target.value)} required />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={busy}>
            {t('action.record_exchange_rate')}
          </button>
        </form>
      </div>

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
          <div className="empty-state">Loading…</div>
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

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.tax_code')}</h3>
        <form onSubmit={onCreateTaxCode} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.code')}</label>
            <input value={taxCode} onChange={(e) => setTaxCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.name')}</label>
            <input value={taxName} onChange={(e) => setTaxName(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.rate')}</label>
            <input type="number" min="0" step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_tax_code')}
          </button>
        </form>

        {taxCodes === null ? (
          <div className="empty-state">Loading…</div>
        ) : taxCodes.length === 0 ? (
          <div className="empty-state">{t('panel.no_tax_codes_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.code')}</th>
                <th>{t('field.name')}</th>
                <th>{t('field.rate')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {taxCodes.map((tc) => (
                <tr key={tc.id} style={{ opacity: tc.isActive ? 1 : 0.5 }}>
                  <td>{tc.code}</td>
                  <td>{tc.name}</td>
                  <td>{tc.rate}%</td>
                  <td>{tc.isActive ? '✓' : '✗'}</td>
                  <td>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => toggleTaxCodeActive(tc)}>
                      {t(tc.isActive ? 'action.deactivate' : 'action.activate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('field.tax_period')}</h3>
        <form onSubmit={onCreateTaxPeriod} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.code')}</label>
            <input value={taxPeriodCode} onChange={(e) => setTaxPeriodCode(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.start_date')}</label>
            <input type="date" value={taxPeriodStart} onChange={(e) => setTaxPeriodStart(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.end_date')}</label>
            <input type="date" value={taxPeriodEnd} onChange={(e) => setTaxPeriodEnd(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('action.create_tax_period')}
          </button>
        </form>
        {taxPeriods && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.code')}</th>
                <th>{t('field.start_date')}</th>
                <th>{t('field.end_date')}</th>
              </tr>
            </thead>
            <tbody>
              {taxPeriods.map((tp) => (
                <tr key={tp.id}>
                  <td>{tp.code}</td>
                  <td>{tp.startDate}</td>
                  <td>{tp.endDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

