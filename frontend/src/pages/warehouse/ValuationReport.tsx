import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { useAutoRefresh } from '../../lib/useAutoRefresh';
import { RefreshStamp } from '../../components/RefreshStamp';

interface ReportRow {
  warehouseId: string;
  productId: string | null;
  quantity: number;
  totalValueBase: string;
  averageCostBase: string | null;
}
interface Report {
  asOf: string;
  basis: 'current' | 'as_of';
  groupBy: 'warehouse' | 'item';
  rows: ReportRow[];
  totals: { quantity: number; valueBase: string };
  /** number of (warehouse, item) positions whose running state differs from the dated history; null on the current basis (not computed) */
  historyInconsistencies: number | null;
  note: string | null;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}

const PRELOAD = [
  'nav.valuation_report',
  'field.val_as_of',
  'field.val_group_by',
  'value.val_group_warehouse',
  'value.val_group_item',
  'field.val_warehouse',
  'field.val_item',
  'field.val_quantity',
  'field.val_value',
  'field.val_avg_cost',
  'panel.val_total',
  'panel.val_no_rows',
  'panel.val_history_issue',
];

/**
 * Inventory valuation report (C1, ADR-INV-08): the moving-average valuation - the figure the General Ledger inventory account must equal - by warehouse or by
 * item, now or as of a past date (rebuilt from the dated valuation history). Read-only; the F6 warehouse scope is applied by the server.
 */
export function ValuationReport() {
  const { t, preload } = useLanguage();
  preload(PRELOAD);
  const [asOf, setAsOf] = useState('');
  const [groupBy, setGroupBy] = useState<'warehouse' | 'item'>('warehouse');
  const [warehouseId, setWarehouseId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useAutoRefresh(
    async (isCurrent) => {
      const qs = new URLSearchParams({ groupBy });
      if (asOf) qs.set('asOf', asOf);
      if (warehouseId) qs.set('warehouseId', warehouseId);
      try {
        const [r, wh, prod] = await Promise.all([
          api.get<Report>(`/inventory/valuation/report?${qs}`),
          api.get<Warehouse[]>('/inventory/warehouses'),
          api.get<Product[]>('/products/all'),
        ]);
        if (!isCurrent()) return;
        setReport(r);
        setWarehouses(wh);
        setProducts(prod);
        setError(null);
      } catch (err) {
        if (isCurrent()) setError(err instanceof ApiError ? err.message : 'Failed to load the valuation report.');
        throw err;
      }
    },
    [asOf, groupBy, warehouseId],
  );

  const whLabel = (id: string) => warehouses.find((w) => w.id === id)?.code ?? id;
  const itemLabel = (id: string | null) => {
    if (!id) return '—';
    const p = products.find((x) => x.id === id);
    return p ? `${p.sku} — ${p.name}` : id;
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>{t('nav.valuation_report')}</h1>
        <RefreshStamp refresh={refresh} />
      </div>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.val_as_of')}</label>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.val_group_by')}</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'warehouse' | 'item')}>
            <option value="warehouse">{t('value.val_group_warehouse')}</option>
            <option value="item">{t('value.val_group_item')}</option>
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label>{t('field.val_warehouse')}</label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">—</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      {report && (
        <>
          {(report.historyInconsistencies ?? 0) > 0 && <div className="error-text">{t('panel.val_history_issue')}</div>}
          {report.note && <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>{report.note}</p>}
          {report.rows.length === 0 ? (
            <div className="empty-state">{t('panel.val_no_rows')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.val_warehouse')}</th>
                  {groupBy === 'item' && <th>{t('field.val_item')}</th>}
                  <th>{t('field.val_quantity')}</th>
                  <th>{t('field.val_avg_cost')}</th>
                  <th>{t('field.val_value')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={`${r.warehouseId}:${r.productId ?? ''}`}>
                    <td>{whLabel(r.warehouseId)}</td>
                    {groupBy === 'item' && <td>{itemLabel(r.productId)}</td>}
                    <td>{r.quantity}</td>
                    <td>{r.averageCostBase ?? '—'}</td>
                    <td>{r.totalValueBase}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td colSpan={groupBy === 'item' ? 2 : 1}>{t('panel.val_total')}</td>
                  <td>{report.totals.quantity}</td>
                  <td />
                  <td>{report.totals.valueBase}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </>
      )}
    </div>
  );
}
