import { useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface SectionAccountRow {
  accountId: string;
  code: string;
  name: string;
  nameAr: string | null;
  balance: string;
}
interface ProfitAndLossData {
  from: string;
  to: string;
  revenue: SectionAccountRow[];
  revenueTotal: string;
  expenses: SectionAccountRow[];
  expensesTotal: string;
  netIncome: string;
}

const PRELOAD = [
  'nav.profit_and_loss',
  'field.from_date',
  'field.to_date',
  'field.section_revenue',
  'field.section_expenses',
  'field.total_revenue',
  'field.total_expenses',
  'field.net_income',
  'action.export_excel',
];

/** F14 — Financial Reporting (ADR-047). Pure read model. */
export function ProfitAndLoss() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ProfitAndLossData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api
      .get<ProfitAndLossData>(`/accounting/reports/profit-and-loss?from=${from}&to=${to}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load profit and loss.'));
  }, [from, to]);

  async function exportXlsx() {
    setExporting(true);
    try {
      const blob = await downloadBlob(`/accounting/reports/profit-and-loss/export?from=${from}&to=${to}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'profit-and-loss.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.profit_and_loss')}</h1>
        <button className="btn btn-secondary" disabled={exporting} onClick={exportXlsx}>
          {t('action.export_excel')}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.from_date')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.to_date')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {data && (
        <>
          <div style={{ marginBottom: 20 }}>
            <h3>{t('field.section_revenue')}</h3>
            <table className="data-table">
              <tbody>
                {data.revenue.map((r) => (
                  <tr key={r.accountId}>
                    <td style={{ fontFamily: 'monospace' }}>{r.code}</td>
                    <td>{r.nameAr ?? r.name}</td>
                    <td style={{ textAlign: 'end' }}>{r.balance}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={2}>{t('field.total_revenue')}</td>
                  <td style={{ textAlign: 'end' }}>{data.revenueTotal}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div style={{ marginBottom: 20 }}>
            <h3>{t('field.section_expenses')}</h3>
            <table className="data-table">
              <tbody>
                {data.expenses.map((r) => (
                  <tr key={r.accountId}>
                    <td style={{ fontFamily: 'monospace' }}>{r.code}</td>
                    <td>{r.nameAr ?? r.name}</td>
                    <td style={{ textAlign: 'end' }}>{r.balance}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={2}>{t('field.total_expenses')}</td>
                  <td style={{ textAlign: 'end' }}>{data.expensesTotal}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.net_income')}</div>
            <div className="value">{data.netIncome}</div>
          </div>
        </>
      )}
    </div>
  );
}
