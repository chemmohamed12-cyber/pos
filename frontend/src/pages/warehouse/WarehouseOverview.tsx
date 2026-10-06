import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { ErrorState } from '../../components/ErrorState';

interface Overview {
  totalWarehouses: number;
  totalInventoryValueAtSellingPrice: string;
  todaysMovementsCount: number;
  reservedStockUnits: number;
  pendingApprovalsCount: number;
  openCountsCount: number;
  negativeStockItems: Array<{ warehouseId: string; productId: string; onHand: number }>;
}
interface Warehouse {
  id: string;
  code: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}

/**
 * Warehouse & Inventory Control UX/UI V1 (CTO directive §4) — an
 * Operational Control Center, not a CRUD page: a manager reads the
 * warehouse network's state in seconds and every exception links
 * straight to the action that resolves it. Every number here is real
 * (directive §31 — trustworthy for Finance); `totalInventoryValue` is
 * explicitly labeled "at selling price" since no cost/valuation layer
 * exists yet, and Low Stock is omitted rather than faked (no
 * minimum-stock threshold is tracked yet — disclosed, not silently
 * papered over).
 */
export function WarehouseOverview() {
  const { t, preload } = useLanguage();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload([
    'nav.warehouse_overview',
    'nav.warehouses',
    'nav.movement_center',
    'nav.inventory',
    'nav.stock_count',
    'field.total_inventory_value',
    'field.at_selling_price',
    'field.total_warehouses',
    'field.todays_movements',
    'field.reserved_stock',
    'field.pending_approvals',
    'panel.exceptions',
    'panel.no_exceptions',
    'exception.pending_approval',
    'exception.negative_stock_attempt',
    'field.exception_type',
    'field.detail',
    'action.review',
    'field.transactions_awaiting_approval',
    'field.in_warehouse',
    'field.on_hand',
  ]);

  function load() {
    setLoadError(null);
    setOverview(null);
    (async () => {
      try {
        const [ov, wh, prod] = await Promise.all([
          api.get<Overview>('/warehouse-transactions/overview'),
          api.get<Warehouse[]>('/inventory/warehouses'),
          api.get<Product[]>('/products/all'),
        ]);
        setOverview(ov);
        setWarehouses(wh);
        setProducts(prod);
      } catch (err) {
        // Foundation fix: this load had no error handling — a failure left
        // the page stuck on "Loading…" forever with no explanation.
        setLoadError(err);
      }
    })();
  }

  useEffect(load, []);

  if (loadError) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('nav.warehouse_overview')}</h1>
        </div>
        <ErrorState error={loadError} onRetry={load} />
      </div>
    );
  }

  if (!overview) return <div className="empty-state">Loading…</div>;

  const warehouseCode = (id: string) => warehouses.find((w) => w.id === id)?.code ?? id;
  const productLabel = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? `${p.sku} — ${p.name}` : id;
  };

  const exceptionCount = overview.pendingApprovalsCount + overview.negativeStockItems.length;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.warehouse_overview')}</h1>
      </div>

      {/* CTO directive ("Section Cover / Main Dashboard System") — the shortcut row every section's Cover shares. */}
      <div className="section-cover-shortcuts">
        <Link to="/warehouses" className="section-cover-shortcut">{t('nav.warehouses')}</Link>
        <Link to="/movement-center" className="section-cover-shortcut">{t('nav.movement_center')}</Link>
        <Link to="/inventory" className="section-cover-shortcut">{t('nav.inventory')}</Link>
        <Link to="/stock-count" className="section-cover-shortcut">{t('nav.stock_count')}</Link>
      </div>

      <div className="detail-grid" style={{ marginBottom: 20 }}>
        <div className="card detail-field">
          <div className="label">{t('field.total_warehouses')}</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>{overview.totalWarehouses}</div>
        </div>
        <div className="card detail-field">
          <div className="label">{t('field.total_inventory_value')} <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>({t('field.at_selling_price')})</span></div>
          <div className="value" style={{ fontSize: '1.6rem' }}>{overview.totalInventoryValueAtSellingPrice}</div>
        </div>
        <div className="card detail-field">
          <div className="label">{t('field.todays_movements')}</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>{overview.todaysMovementsCount}</div>
        </div>
        <div className="card detail-field">
          <div className="label">{t('field.reserved_stock')}</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>{overview.reservedStockUnits}</div>
        </div>
        <Link to="/movement-center" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="label">{t('field.pending_approvals')}</div>
          <div className="value" style={{ fontSize: '1.6rem', color: overview.pendingApprovalsCount > 0 ? '#a3262d' : undefined }}>
            {overview.pendingApprovalsCount}
          </div>
        </Link>
        <Link to="/stock-count" className="card detail-field" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="label">{t('nav.stock_count')}</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>{overview.openCountsCount}</div>
        </Link>
      </div>

      <h3>{t('panel.exceptions')}</h3>
      {exceptionCount === 0 ? (
        <div className="empty-state">{t('panel.no_exceptions')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.exception_type')}</th>
              <th>{t('field.detail')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {overview.pendingApprovalsCount > 0 && (
              <tr onClick={() => (window.location.href = '/movement-center')} style={{ cursor: 'pointer' }}>
                <td>{t('exception.pending_approval')}</td>
                <td>{overview.pendingApprovalsCount} {t('field.transactions_awaiting_approval')}</td>
                <td>
                  <Link to="/movement-center" className="btn btn-secondary">
                    {t('action.review')}
                  </Link>
                </td>
              </tr>
            )}
            {overview.negativeStockItems.map((item) => (
              <tr key={`${item.warehouseId}:${item.productId}`}>
                <td>{t('exception.negative_stock_attempt')}</td>
                <td>
                  {productLabel(item.productId)} {t('field.in_warehouse')} {warehouseCode(item.warehouseId)} — {t('field.on_hand')}: {item.onHand}
                </td>
                <td>
                  <Link to="/movement-center/new/adjustment" className="btn btn-secondary">
                    {t('action.create_adjustment')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
