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
interface BalanceSheetData {
  asOfDate: string;
  assets: SectionAccountRow[];
  assetsTotal: string;
  liabilities: SectionAccountRow[];
  liabilitiesTotal: string;
  equity: SectionAccountRow[];
  unclosedNetIncome: string;
  equityTotal: string;
  balanced: boolean;
}

const PRELOAD = [
  'nav.balance_sheet',
  'field.as_of_date',
  'field.section_assets',
  'field.section_liabilities',
  'field.section_equity',
  'field.total_assets',
  'field.total_liabilities',
  'field.total_equity',
  'field.unclosed_net_income',
  'panel.balanced',
  'panel.not_balanced',
  'action.export_excel',
];

function Section({ titleCode, rows, total }: { titleCode: string; rows: SectionAccountRow[]; total: string }) {
  const { t } = useLanguage();
  return (
    <div style={{ marginBottom: 20 }}>
      <h3>{t(titleCode)}</h3>
      <table className="data-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.accountId}>
              <td style={{ fontFamily: 'monospace' }}>{r.code}</td>
              <td>{r.nameAr ?? r.name}</td>
              <td style={{ textAlign: 'end' }}>{r.balance}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 600 }}>
            <td colSpan={2}>{t(titleCode)} — {t('panel.trial_balance_footer')}</td>
            <td style={{ textAlign: 'end' }}>{total}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** F14 — Financial Reporting (ADR-047). Pure read model over the same posted GL data `TrialBalance.tsx` reads. */
export function BalanceSheet() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api
      .get<BalanceSheetData>(`/accounting/reports/balance-sheet?asOfDate=${asOfDate}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load balance sheet.'));
  }, [asOfDate]);

  async function exportXlsx() {
    setExporting(true);
    try {
      const blob = await downloadBlob(`/accounting/reports/balance-sheet/export?asOfDate=${asOfDate}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'balance-sheet.xlsx';
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
        <h1>{t('nav.balance_sheet')}</h1>
        <button className="btn btn-secondary" disabled={exporting} onClick={exportXlsx}>
          {t('action.export_excel')}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="form-field" style={{ marginBottom: 0, maxWidth: 220 }}>
          <label>{t('field.as_of_date')}</label>
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {data && (
        <>
          <p>
            <span className={data.balanced ? 'status-badge positive' : 'status-badge negative'}>{t(data.balanced ? 'panel.balanced' : 'panel.not_balanced')}</span>
          </p>
          <Section titleCode="field.section_assets" rows={data.assets} total={data.assetsTotal} />
          <Section titleCode="field.section_liabilities" rows={data.liabilities} total={data.liabilitiesTotal} />
          <div style={{ marginBottom: 20 }}>
            <h3>{t('field.section_equity')}</h3>
            <table className="data-table">
              <tbody>
                {data.equity.map((r) => (
                  <tr key={r.accountId}>
                    <td style={{ fontFamily: 'monospace' }}>{r.code}</td>
                    <td>{r.nameAr ?? r.name}</td>
                    <td style={{ textAlign: 'end' }}>{r.balance}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>{t('field.unclosed_net_income')}</td>
                  <td style={{ textAlign: 'end' }}>{data.unclosedNetIncome}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={2}>{t('field.total_equity')}</td>
                  <td style={{ textAlign: 'end' }}>{data.equityTotal}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
