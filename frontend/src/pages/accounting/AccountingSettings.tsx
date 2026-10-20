import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel } from '../../lib/displayNames';

const ROUNDING_MODES = ['half_up', 'half_even', 'half_down'] as const;

interface Currency {
  code: string;
  name: string;
  symbol: string;
  roundingMode: (typeof ROUNDING_MODES)[number];
  isBaseCurrency: boolean;
  isActive: boolean;
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
  'action.create_tax_code',
  'action.create_tax_period',
  'action.save',
  'panel.no_currencies_yet',
  'panel.no_tax_codes_yet',
];

/**
 * F01 — Financial Foundation (ADR-032). Currencies + Tax Codes/Periods —
 * module-level configuration screens `nav.accounting_settings` was seeded
 * for. Fiscal Year/Period management (Month-End Closing's own entry
 * point) moved to its own dedicated page/route/sidebar entry, `FiscalPeriods.tsx`
 * (Frontend Gap Closure, 2026-09-19) — it was never a "settings" concept,
 * just co-located here by historical accident.
 */
export function AccountingSettings() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);

  const [currencies, setCurrencies] = useState<Currency[] | null>(null);
  const [taxCodes, setTaxCodes] = useState<TaxCode[] | null>(null);
  const [taxPeriods, setTaxPeriods] = useState<TaxPeriod[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [curCode, setCurCode] = useState('');
  const [curName, setCurName] = useState('');
  const [curSymbol, setCurSymbol] = useState('');
  const [curRounding, setCurRounding] = useState<(typeof ROUNDING_MODES)[number]>('half_up');

  const [rateForCode, setRateForCode] = useState('');
  const [rateDate, setRateDate] = useState(new Date().toISOString().slice(0, 10));
  const [rateValue, setRateValue] = useState('');

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
    loadTaxCodes();
    loadTaxPeriods();
  }, []);

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
          <div className="empty-state">{loadingLabel()}</div>
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
          <div className="empty-state">{loadingLabel()}</div>
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

