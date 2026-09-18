import { useEffect, useState } from 'react';
import { api, ApiError, downloadBlob } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface CashFlowData {
  from: string;
  to: string;
  beginningCash: string;
  endingCash: string;
  netChangeActual: string;
  operating: {
    periodNetIncome: string;
    depreciationAddBack: string;
    arDelta: string;
    apDelta: string;
    inventoryDelta: string;
    total: string;
  };
  investing: {
    acquisitionsCashOutflow: string;
    disposalsCashInflow: string;
    total: string;
    note: string;
  };
  financing: {
    total: string;
    note: string;
  };
  unclassifiedOther: string;
}

const PRELOAD = [
  'nav.cash_flow',
  'field.from_date',
  'field.to_date',
  'field.beginning_cash',
  'field.ending_cash',
  'field.net_change_in_cash',
  'field.operating_activities',
  'field.investing_activities',
  'field.financing_activities',
  'field.net_income',
  'field.depreciation_addback',
  'field.ar_movement',
  'field.ap_movement',
  'field.inventory_movement',
  'field.acquisitions_cash_outflow',
  'field.disposals_cash_inflow',
  'field.unclassified_other',
  'note.cash_flow_investing_limitation',
  'note.cash_flow_financing_limitation',
  'action.export_excel',
];

function Row({ labelCode, value }: { labelCode: string; value: string }) {
  const { t } = useLanguage();
  return (
    <tr>
      <td>{t(labelCode)}</td>
      <td style={{ textAlign: 'end' }}>{value}</td>
    </tr>
  );
}

/** F14 — Financial Reporting (ADR-047). Indirect-method cash flow; Investing/Financing scope honestly disclosed via the two `note.*` strings. */
export function CashFlowStatement() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [data, setData] = useState<CashFlowData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api
      .get<CashFlowData>(`/accounting/reports/cash-flow?from=${from}&to=${to}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load cash flow statement.'));
  }, [from, to]);

  async function exportXlsx() {
    setExporting(true);
    try {
      const blob = await downloadBlob(`/accounting/reports/cash-flow/export?from=${from}&to=${to}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cash-flow-statement.xlsx';
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
        <h1>{t('nav.cash_flow')}</h1>
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
          <div className="detail-grid" style={{ marginBottom: 20 }}>
            <div className="kpi-tile">
              <div className="label">{t('field.beginning_cash')}</div>
              <div className="value">{data.beginningCash}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.net_change_in_cash')}</div>
              <div className="value">{data.netChangeActual}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">{t('field.ending_cash')}</div>
              <div className="value">{data.endingCash}</div>
            </div>
          </div>

          <table className="data-table" style={{ marginBottom: 20 }}>
            <thead>
              <tr>
                <th colSpan={2}>{t('field.operating_activities')}</th>
              </tr>
            </thead>
            <tbody>
              <Row labelCode="field.net_income" value={data.operating.periodNetIncome} />
              <Row labelCode="field.depreciation_addback" value={data.operating.depreciationAddBack} />
              <Row labelCode="field.ar_movement" value={data.operating.arDelta} />
              <Row labelCode="field.ap_movement" value={data.operating.apDelta} />
              <Row labelCode="field.inventory_movement" value={data.operating.inventoryDelta} />
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td>{t('field.operating_activities')}</td>
                <td style={{ textAlign: 'end' }}>{data.operating.total}</td>
              </tr>
            </tfoot>
          </table>

          <table className="data-table" style={{ marginBottom: 8 }}>
            <thead>
              <tr>
                <th colSpan={2}>{t('field.investing_activities')}</th>
              </tr>
            </thead>
            <tbody>
              <Row labelCode="field.acquisitions_cash_outflow" value={data.investing.acquisitionsCashOutflow} />
              <Row labelCode="field.disposals_cash_inflow" value={data.investing.disposalsCashInflow} />
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td>{t('field.investing_activities')}</td>
                <td style={{ textAlign: 'end' }}>{data.investing.total}</td>
              </tr>
            </tfoot>
          </table>
          <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>{t('note.cash_flow_investing_limitation')}</p>

          <table className="data-table" style={{ marginBottom: 8 }}>
            <thead>
              <tr>
                <th colSpan={2}>{t('field.financing_activities')}</th>
              </tr>
            </thead>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td>{t('field.financing_activities')}</td>
                <td style={{ textAlign: 'end' }}>{data.financing.total}</td>
              </tr>
            </tfoot>
          </table>
          <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>{t('note.cash_flow_financing_limitation')}</p>

          <table className="data-table">
            <tbody>
              <Row labelCode="field.unclassified_other" value={data.unclassifiedOther} />
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
