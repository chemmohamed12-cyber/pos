import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { SectionCover } from '../components/SectionCover';

interface CustodianOverview {
  warehouseId: string | null;
  custodyAccountId: string | null;
  stock: Array<{ productId: string; onHand: number; reserved: number; available: number }>;
  custodyBalance: string | null;
  activeShipmentsCount: number;
}
interface ShippingCompany {
  id: string;
  code: string;
  name: string;
}
interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface AdminUser {
  id: string;
  fullName: string;
}
interface MainWarehouse {
  id: string;
  code: string;
  name: string;
  kind: string;
}
interface CustodyShipmentSearchResult {
  shipmentId: string;
  waybillNumber: string;
  rshNumber: string | null;
  salesOrderNumber: string | null;
  salesRepUserId: string | null;
  customerName: string | null;
  customerCode: string | null;
  currentCustodyStatus: string;
  items: Array<{ productId: string; quantity: number }>;
}

/**
 * CTO directive (Phase 5 — Custody/Visibility, resumed) — the per-custodian
 * detail page: one Shipping Company or Company Vehicle's full picture
 * (money under custody, goods under custody, and the actual shipments
 * behind those numbers), not just the Cover/print summary. Reuses the same
 * `getCustodianOverview` overview and `searchCustodyShipments` search this
 * codebase already has (Phase 6's ShippingCover, Phase 7's
 * CustodyStatementPrint, Returns Engine's CustodyReturns) — no new backend
 * calculation.
 */
/**
 * Master continuation directive (Company Vehicle Shipping §5) — closing a
 * vehicle's custody warehouse, decided as: a stock-count reconciliation
 * (expected vs. counted, with a supervisor approval step) plus, for
 * genuinely leftover stock, a transfer back to a real warehouse. Reuses
 * the EXISTING Warehouse & Inventory Control `WarehouseTransaction` domain
 * end to end (`count` type = the reconciliation+approval workflow the
 * business already trusts for Stock Count everywhere else; `transfer`
 * type = the settlement-back-to-warehouse leg) — no new backend domain,
 * no new approval mechanism. Only shown for vehicles with zero active
 * shipments: closing custody while a shipment is still in flight would
 * fight the shipment's own state machine, so the operator finishes or
 * returns those first (via the existing per-shipment custody-return flow)
 * before closing the vehicle itself.
 */
export function CustodianDetail() {
  const { type, id } = useParams<{ type: 'company' | 'vehicle'; id: string }>();
  const { t, preload } = useLanguage();
  const { can } = useAuth();
  const navigate = useNavigate();
  preload([
    'panel.custodian_detail',
    'field.custodian_type',
    'panel.shipping_companies',
    'panel.vehicles',
    'field.custody_balance',
    'field.active_shipments',
    'field.stock_report',
    'field.on_hand',
    'field.reserved',
    'field.waybill_number',
    'field.rsh_number',
    'field.sales_order',
    'field.customer',
    'field.custody_status',
    'field.product',
    'field.quantity',
    'field.sales_rep',
    'panel.no_custody_results',
    'panel.close_vehicle_custody',
    'panel.close_vehicle_custody_blocked',
    'action.start_count',
    'field.transfer_destination_warehouse',
    'action.transfer_remaining_stock',
    'action.print',
  ]);

  const [overview, setOverview] = useState<CustodianOverview | null>(null);
  const [custodianLabel, setCustodianLabel] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [warehouses, setWarehouses] = useState<MainWarehouse[]>([]);
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  const [shipmentResults, setShipmentResults] = useState<CustodyShipmentSearchResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isVehicle = type === 'vehicle';
  const canOperateWarehouse = can('inventory.movement.create', 'editable');

  useEffect(() => {
    (async () => {
      if (!type || !id) return;
      try {
        const [overviewData, products, users, results] = await Promise.all([
          api.get<CustodianOverview>(`/shipments/${isVehicle ? 'vehicles' : 'shipping-companies'}/${id}/overview`),
          api.get<Product[]>('/products/all'),
          api.get<AdminUser[]>('/admin/users').catch(() => []),
          api
            .get<CustodyShipmentSearchResult[]>(`/shipments/custody-search?${isVehicle ? 'vehicleId' : 'shippingCompanyId'}=${id}`)
            .catch(() => []),
        ]);
        setOverview(overviewData);
        setProducts(products);
        setUsers(users);
        setShipmentResults(results);

        if (isVehicle) {
          const vehicles = await api.get<Vehicle[]>('/shipments/vehicles');
          const vehicle = vehicles.find((v) => v.id === id);
          setCustodianLabel(vehicle ? `${vehicle.code} — ${vehicle.plateNumber}` : id);
          const wh = await api.get<MainWarehouse[]>('/inventory/warehouses').catch(() => []);
          setWarehouses(wh.filter((w) => w.kind === 'main'));
        } else {
          const companies = await api.get<ShippingCompany[]>('/shipments/shipping-companies');
          const company = companies.find((c) => c.id === id);
          setCustodianLabel(company ? `${company.code} — ${company.name}` : id);
        }
      } catch (err) {
        // Foundation fix: mount-time load had no error handling — the page
        // was stuck on "Loading…" forever on failure (the core overview
        // call is not defensively .catch()'d like its siblings).
        setError(err instanceof ApiError ? err.message : 'Failed to load custodian detail.');
      }
    })();
  }, [type, id, isVehicle]);

  const productLabel = (productId: string) => {
    const p = products.find((x) => x.id === productId);
    return p ? `${p.sku} — ${p.name}` : productId;
  };
  const repLabel = (userId: string | null) => {
    if (!userId) return '—';
    return users.find((u) => u.id === userId)?.fullName ?? userId;
  };

  const nonZeroStock = overview?.stock.filter((s) => s.onHand !== 0) ?? [];

  async function startVehicleCount() {
    if (!overview?.warehouseId || nonZeroStock.length === 0) return;
    setBusy('count');
    setError(null);
    try {
      const txn = await api.post<{ id: string }>('/warehouse-transactions/count', {
        warehouseId: overview.warehouseId,
        productIds: nonZeroStock.map((s) => s.productId),
      });
      navigate(`/stock-count/${txn.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function transferRemainingStock() {
    if (!overview?.warehouseId || !destinationWarehouseId || nonZeroStock.length === 0) return;
    setBusy('transfer');
    setError(null);
    try {
      const txn = await api.post<{ id: string }>('/warehouse-transactions', {
        type: 'transfer',
        warehouseId: overview.warehouseId,
        destinationWarehouseId,
        lines: nonZeroStock.map((s) => ({ productId: s.productId, quantity: s.onHand })),
        reason: 'Vehicle custody closing — remaining stock settled back to warehouse',
      });
      navigate(`/movement-center/${txn.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SectionCover
      titleCode="panel.custodian_detail"
      shortcuts={[]}
      kpis={[
        { labelCode: type === 'vehicle' ? 'panel.vehicles' : 'panel.shipping_companies', value: custodianLabel || '—' },
        { labelCode: 'field.custody_balance', value: overview?.custodyBalance ?? '—' },
        { labelCode: 'field.active_shipments', value: overview?.activeShipmentsCount ?? '—' },
      ]}
    >
      <div className="action-row" style={{ marginBottom: 20 }}>
        <button className="btn btn-secondary" onClick={() => window.open(`/print/custody/${type}/${id}`, '_blank')}>
          {t('action.print')}
        </button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.stock_report')}</h3>
        {!overview || overview.stock.filter((s) => s.onHand !== 0 || s.reserved !== 0).length === 0 ? (
          <div className="empty-state">{t('panel.no_custody_results')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.product')}</th>
                <th>{t('field.on_hand')}</th>
                <th>{t('field.reserved')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.stock
                .filter((s) => s.onHand !== 0 || s.reserved !== 0)
                .map((s) => (
                  <tr key={s.productId}>
                    <td>{productLabel(s.productId)}</td>
                    <td>{s.onHand}</td>
                    <td>{s.reserved}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {isVehicle && canOperateWarehouse && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('panel.close_vehicle_custody')}</h3>
          {error && <div className="error-text">{error}</div>}
          {overview && overview.activeShipmentsCount > 0 ? (
            <div className="empty-state">{t('panel.close_vehicle_custody_blocked')}</div>
          ) : nonZeroStock.length === 0 ? (
            <div className="empty-state">{t('panel.no_custody_results')}</div>
          ) : (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" disabled={busy !== null} onClick={startVehicleCount}>
                {t('action.start_count')}
              </button>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.transfer_destination_warehouse')}</label>
                <select value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)}>
                  <option value="">—</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-secondary" disabled={busy !== null || !destinationWarehouseId} onClick={transferRemainingStock}>
                {t('action.transfer_remaining_stock')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('field.active_shipments')}</h3>
        {shipmentResults === null || shipmentResults.length === 0 ? (
          <div className="empty-state">{t('panel.no_custody_results')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.waybill_number')}</th>
                <th>{t('field.rsh_number')}</th>
                <th>{t('field.sales_order')}</th>
                <th>{t('field.sales_rep')}</th>
                <th>{t('field.customer')}</th>
                <th>{t('field.custody_status')}</th>
                <th>{t('field.product')}</th>
                <th>{t('field.quantity')}</th>
              </tr>
            </thead>
            <tbody>
              {shipmentResults.flatMap((r) =>
                r.items.length === 0
                  ? [
                      <tr key={r.shipmentId}>
                        <td>{r.waybillNumber}</td>
                        <td>{r.rshNumber ?? '—'}</td>
                        <td>{r.salesOrderNumber ?? '—'}</td>
                        <td>{repLabel(r.salesRepUserId)}</td>
                        <td>
                          {r.customerName ?? '—'} {r.customerCode ? `(${r.customerCode})` : ''}
                        </td>
                        <td>
                          <StatusBadge code={`shipment_lifecycle.state.${r.currentCustodyStatus}`} />
                        </td>
                        <td colSpan={2}>—</td>
                      </tr>,
                    ]
                  : r.items.map((item) => (
                      <tr key={`${r.shipmentId}:${item.productId}`}>
                        <td>{r.waybillNumber}</td>
                        <td>{r.rshNumber ?? '—'}</td>
                        <td>{r.salesOrderNumber ?? '—'}</td>
                        <td>{repLabel(r.salesRepUserId)}</td>
                        <td>
                          {r.customerName ?? '—'} {r.customerCode ? `(${r.customerCode})` : ''}
                        </td>
                        <td>
                          <StatusBadge code={`shipment_lifecycle.state.${r.currentCustodyStatus}`} />
                        </td>
                        <td>{productLabel(item.productId)}</td>
                        <td>{item.quantity}</td>
                      </tr>
                    )),
              )}
            </tbody>
          </table>
        )}
      </div>
    </SectionCover>
  );
}
