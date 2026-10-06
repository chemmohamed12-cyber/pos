import { useEffect, useMemo, useState } from 'react';
import { api, uploadFile, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface Shipment {
  id: string;
  waybillNumber: string;
  fulfillmentOrderId: string;
  driverUserId: string | null;
  shippingCompanyId: string | null;
  vehicleId: string | null;
  codAmount: string | null;
  state: string;
  rshNumber: string | null;
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  salesRepUserId: string | null;
  carrierWaybillNumber: string | null;
  waybillImageMediaAssetId: string | null;
  carrierContactPhone: string | null;
  createdAt: string;
  /** Warehouse / Shipment Operations Requirement (2026-09-17) — the dispatch-warehouse board's own fields: the shipment is the primary operating unit, not the SKU. */
  customerName: string | null;
  governorate: string | null;
  totalAmount: string | null;
  salesRepName: string | null;
}
interface AdminUser {
  id: string;
  email: string;
  fullName: string;
}
interface ShippingCompany {
  id: string;
  code: string;
  name: string;
  status: string;
}
interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
  status: 'active' | 'retired';
}
interface SalesOrderLine {
  productId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}
/** Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — the frozen, per-shipment snapshot (what was actually shipped), never the order's live/ordered lines. */
interface ShipmentLineView {
  productId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  salesOrderLineId: string;
}
interface SalesOrderDetail {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string | null;
  customerGovernorate: string | null;
  customerAddress: string | null;
  salesRepName: string;
  shippingMethod: string | null;
  totalAmount: string;
  lines: SalesOrderLine[];
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface TrackingEvent {
  id: string;
  eventType: string;
  detail: string | null;
  occurredAt: string;
}

type Bucket = 'in_progress' | 'delivered' | 'returned';

function bucketOf(state: string): Bucket {
  if (state === 'delivered') return 'delivered';
  if (state === 'returned') return 'returned';
  return 'in_progress'; // created, assigned, picked_up, in_transit, out_for_delivery, failed — all still open
}

const DRIVER_ACTIONS: Record<string, string[]> = {
  assigned: ['pickup'],
  picked_up: ['depart'],
  in_transit: ['arrive_for_delivery'],
  out_for_delivery: ['fail_delivery'], // 'deliver' handled separately (bundles collection recording)
};

/** Shipping Screen Redesign directive §14 — order detail: Header → Items → Shipping/Custody info → context-sensitive Action Panel, plus §11 tracking timeline. Reuses GET /sales-orders/:id for header/items (already returns everything needed — no new backend read). */
function ShipmentDetail({
  shipment,
  companies,
  vehicles,
  users,
  onBack,
  onChanged,
}: {
  shipment: Shipment;
  companies: ShippingCompany[];
  vehicles: Vehicle[];
  users: AdminUser[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const { hasRole, user } = useAuth();
  const { t } = useLanguage();
  const [order, setOrder] = useState<SalesOrderDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [tracking, setTracking] = useState<TrackingEvent[]>([]);
  const [shipmentLines, setShipmentLines] = useState<ShipmentLineView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [routeChoice, setRouteChoice] = useState<'company' | 'vehicle' | 'none'>(
    shipment.shippingCompanyId ? 'company' : shipment.vehicleId ? 'vehicle' : 'none',
  );
  const [routeCompanyId, setRouteCompanyId] = useState(shipment.shippingCompanyId ?? '');
  const [routeVehicleId, setRouteVehicleId] = useState(shipment.vehicleId ?? '');
  const [routeReason, setRouteReason] = useState('');

  const [waybillNumber, setWaybillNumber] = useState(shipment.carrierWaybillNumber ?? '');
  const [waybillImageAssetId, setWaybillImageAssetId] = useState(shipment.waybillImageMediaAssetId ?? '');
  const [carrierPhone, setCarrierPhone] = useState(shipment.carrierContactPhone ?? '');

  const [driverChoice, setDriverChoice] = useState('');
  const [collectionAmount, setCollectionAmount] = useState(shipment.codAmount ?? '');
  const [failureReason, setFailureReason] = useState('');

  useEffect(() => {
    (async () => {
      const [products, trackingData] = await Promise.all([
        // Foundation fix: every sibling call in this Promise.all already
        // degrades gracefully on failure — this one didn't, so a single
        // /products/all failure silently broke the whole detail load.
        api.get<Product[]>('/products/all').catch(() => []),
        api.get<TrackingEvent[]>(`/shipments/${shipment.id}/tracking`).catch(() => []),
      ]);
      setProducts(products);
      setTracking(trackingData);
      // Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — the frozen shipment
      // content snapshot, not the order's live lines (which can exceed what was actually shipped,
      // or drift if reservations changed after dispatch — see ShipmentLine's own doc comment).
      const detail = await api.get<{ lines: ShipmentLineView[] }>(`/shipments/${shipment.id}/detail`).catch(() => null);
      setShipmentLines(detail?.lines ?? []);
      if (shipment.salesOrderId) {
        const o = await api.get<SalesOrderDetail>(`/sales-orders/${shipment.salesOrderId}`).catch(() => null);
        setOrder(o);
        // Shipping Screen Redesign directive §2 — "طريقة الشحن التي اختارها
        // المندوب سابقًا يجب أن تظهر بوضوح، وتكون هي الـDefault Route": a
        // shipment with no route assigned yet defaults to whatever the Sales
        // Order's own pre-determined shipping method was, not a blank choice.
        if (!shipment.shippingCompanyId && !shipment.vehicleId && o?.shippingMethod) {
          setRouteChoice(o.shippingMethod === 'company_vehicles' ? 'vehicle' : 'company');
        }
      }
    })();
  }, [shipment.id, shipment.salesOrderId]);

  const productLabel = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? `${p.sku} — ${p.name}` : id;
  };
  const userLabel = (id: string | null) => (id ? users.find((u) => u.id === id)?.fullName ?? id : '—');
  const custodianLabel = shipment.shippingCompanyId
    ? companies.find((c) => c.id === shipment.shippingCompanyId)?.name ?? '—'
    : shipment.vehicleId
      ? vehicles.find((v) => v.id === shipment.vehicleId)?.plateNumber ?? '—'
      : '—';

  const routeLocked = shipment.state !== 'created' && shipment.state !== 'assigned';
  const isMyShipment = shipment.driverUserId === user?.id;

  async function saveRoute() {
    setBusy('route');
    setError(null);
    try {
      await api.post(`/shipments/${shipment.id}/assign-route`, {
        shippingCompanyId: routeChoice === 'company' ? routeCompanyId || undefined : undefined,
        vehicleId: routeChoice === 'vehicle' ? routeVehicleId || undefined : undefined,
        reason: routeReason || undefined,
      });
      setRouteReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign route.');
    } finally {
      setBusy(null);
    }
  }

  async function uploadWaybillImage(file: File) {
    setBusy('waybill-upload');
    setError(null);
    try {
      const asset = await uploadFile<{ id: string }>('/media/upload', file);
      setWaybillImageAssetId(asset.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to upload waybill image.');
    } finally {
      setBusy(null);
    }
  }

  async function saveCarrierWaybill() {
    setBusy('waybill-save');
    setError(null);
    try {
      await api.post(`/shipments/${shipment.id}/carrier-waybill`, {
        ...(waybillNumber ? { carrierWaybillNumber: waybillNumber } : {}),
        ...(waybillImageAssetId ? { waybillImageMediaAssetId: waybillImageAssetId } : {}),
        ...(carrierPhone ? { carrierContactPhone: carrierPhone } : {}),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save carrier waybill.');
    } finally {
      setBusy(null);
    }
  }

  async function assignDriver() {
    if (!driverChoice) return;
    setBusy('assign-driver');
    setError(null);
    try {
      await api.post(`/shipments/${shipment.id}/assign-driver`, { driverUserId: driverChoice });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign driver.');
    } finally {
      setBusy(null);
    }
  }

  async function doTransition(action: string) {
    setBusy(action);
    setError(null);
    try {
      await api.post(`/shipments/${shipment.id}/transition`, { action });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update shipment.');
    } finally {
      setBusy(null);
    }
  }

  /** Shipping Screen Redesign directive §8 — one action bundles: Delivery Confirmation, then (if a COD amount is owed) Collection recording in the same step, matching "Vehicle Custody → Delivery Confirmation → ... → تسجيل قيمة التحصيل" as one integrated cycle rather than two disconnected screens. Final inventory dispatch/Treasury/custody-close all already fire server-side off these two calls (DeliveryService), not duplicated here. */
  async function confirmDelivered() {
    setBusy('deliver');
    setError(null);
    try {
      await api.post('/delivery/outcomes', { shipmentId: shipment.id, outcome: 'delivered' });
      if (collectionAmount && Number(collectionAmount) > 0) {
        await api.post('/delivery/collections', { shipmentId: shipment.id, amount: collectionAmount, method: 'cash' });
      }
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record delivery.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmFailed() {
    setBusy('fail');
    setError(null);
    try {
      await api.post('/delivery/outcomes', { shipmentId: shipment.id, outcome: 'failed', failureReason: failureReason || undefined });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record failed delivery.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <button className="btn btn-secondary" style={{ marginBottom: 16 }} onClick={onBack}>
        ← {t('nav.shipments')}
      </button>
      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>
          {shipment.rshNumber ?? shipment.waybillNumber} <StatusBadge code={`shipment_lifecycle.state.${shipment.state}`} />
        </h3>
        <div className="detail-grid">
          <div className="kpi-tile">
            <div className="label">{t('field.customer')}</div>
            <div className="value">{order?.customerName ?? '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.sales_order')}</div>
            <div className="value">{shipment.salesOrderNumber ?? '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.sales_rep')}</div>
            <div className="value">{order?.salesRepName ?? userLabel(shipment.salesRepUserId)}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.customer_phone')}</div>
            <div className="value">{order?.customerPhone ?? '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.governorate')}</div>
            <div className="value">{order?.customerGovernorate ?? '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.address')}</div>
            <div className="value">{order?.customerAddress ?? '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.shipping_method')}</div>
            <div className="value">{order?.shippingMethod ? t(`shipping_method.${order.shippingMethod}`) : '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.cod_amount')}</div>
            <div className="value">{shipment.codAmount ?? '—'}</div>
          </div>
          <div className="kpi-tile">
            <div className="label">{t('field.total_amount')}</div>
            <div className="value">{order?.totalAmount ?? '—'}</div>
          </div>
        </div>
      </div>

      {(() => {
        // Prefer the frozen shipment-content snapshot; fall back to the order's own lines only
        // for a shipment created before ShipmentLine existed (no snapshot ever recorded for it).
        const items: Array<{ productId: string; quantity: number; unitPrice: string; lineTotal: string }> =
          shipmentLines.length > 0 ? shipmentLines : order?.lines ?? [];
        return items.length > 0 ? (
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>{t('field.shipment_items')}</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.product')}</th>
                  <th>{t('field.quantity')}</th>
                  <th>{t('field.unit_price')}</th>
                  <th>{t('field.line_total')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l, i) => (
                  <tr key={`${l.productId}-${i}`}>
                    <td>{productLabel(l.productId)}</td>
                    <td>{l.quantity}</td>
                    <td>{l.unitPrice}</td>
                    <td>{l.lineTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null;
      })()}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.shipping_company')} / {t('field.vehicle')}</h3>
        <div style={{ marginBottom: 12 }}>
          {t('field.current_custodian')}: <strong>{custodianLabel}</strong>
        </div>
        {hasRole('admin') && !routeLocked ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.shipping_method')}</label>
              <select
                value={routeChoice}
                onChange={(e) => setRouteChoice(e.target.value as 'company' | 'vehicle' | 'none')}
              >
                <option value="none">—</option>
                <option value="company">{t('shipping_method.shipping_company')}</option>
                <option value="vehicle">{t('shipping_method.company_vehicles')}</option>
              </select>
            </div>
            {routeChoice === 'company' && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{t('field.shipping_company')}</label>
                <select value={routeCompanyId} onChange={(e) => setRouteCompanyId(e.target.value)}>
                  <option value="">—</option>
                  {companies
                    .filter((c) => c.status === 'active')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {routeChoice === 'vehicle' && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{t('field.vehicle')}</label>
                <select value={routeVehicleId} onChange={(e) => setRouteVehicleId(e.target.value)}>
                  <option value="">—</option>
                  {vehicles
                    .filter((v) => v.status === 'active')
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.code} — {v.plateNumber}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {(shipment.shippingCompanyId || shipment.vehicleId) && (
              <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
                <label>{t('field.route_reason')}</label>
                <input value={routeReason} onChange={(e) => setRouteReason(e.target.value)} />
              </div>
            )}
            <button className="btn btn-primary" disabled={busy === 'route'} onClick={saveRoute}>
              {shipment.shippingCompanyId || shipment.vehicleId ? t('action.reassign_route') : t('action.assign_route')}
            </button>
          </div>
        ) : routeLocked ? (
          <div className="empty-state">{t('panel.close_vehicle_custody_blocked')}</div>
        ) : null}
      </div>

      {shipment.shippingCompanyId && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('field.carrier_waybill_number')}</h3>
          {(!shipment.carrierWaybillNumber || !shipment.waybillImageMediaAssetId) && (
            <div style={{ color: '#b45309', marginBottom: 8 }}>{t('panel.carrier_waybill_required')}</div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.carrier_waybill_number')}</label>
              <input value={waybillNumber} onChange={(e) => setWaybillNumber(e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.carrier_contact_phone')}</label>
              <input value={carrierPhone} onChange={(e) => setCarrierPhone(e.target.value)} />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.waybill_image')}</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="file"
                  accept="image/*"
                  disabled={busy === 'waybill-upload'}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadWaybillImage(file);
                  }}
                />
                {waybillImageAssetId && <span>✓</span>}
              </div>
            </div>
            <button className="btn btn-secondary" disabled={busy === 'waybill-save'} onClick={saveCarrierWaybill}>
              {t('action.save_carrier_waybill')}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.actions')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {!shipment.driverUserId && hasRole('admin') && (
            <>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.driver')}</label>
                <select value={driverChoice} onChange={(e) => setDriverChoice(e.target.value)}>
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-secondary" disabled={busy === 'assign-driver' || !driverChoice} onClick={assignDriver}>
                {t('shipment_lifecycle.action.assign_driver')}
              </button>
            </>
          )}

          {(isMyShipment || hasRole('admin')) &&
            (DRIVER_ACTIONS[shipment.state] ?? [])
              .filter((a) => a !== 'fail_delivery')
              .map((action) => (
                <button key={action} className="btn btn-secondary" disabled={busy === action} onClick={() => doTransition(action)}>
                  {t(`shipment_lifecycle.action.${action}`)}
                </button>
              ))}

          {(isMyShipment || hasRole('admin')) && shipment.state === 'out_for_delivery' && (
            <>
              <div className="form-field" style={{ marginBottom: 0, width: 140 }}>
                <label>{t('field.collected_amount')}</label>
                <input type="number" min={0} step="0.01" value={collectionAmount} onChange={(e) => setCollectionAmount(e.target.value)} />
              </div>
              <button className="btn btn-primary" disabled={busy === 'deliver'} onClick={confirmDelivered}>
                {t('shipment_lifecycle.action.deliver')}
              </button>
              <div className="form-field" style={{ marginBottom: 0, width: 180 }}>
                <label>{t('field.reason')}</label>
                <input value={failureReason} onChange={(e) => setFailureReason(e.target.value)} />
              </div>
              <button className="btn btn-secondary" disabled={busy === 'fail'} onClick={confirmFailed}>
                {t('shipment_lifecycle.action.fail_delivery')}
              </button>
            </>
          )}

          {(shipment.state === 'failed' || shipment.shippingCompanyId || shipment.vehicleId) && shipment.state !== 'delivered' && shipment.state !== 'returned' && (
            <a href="/custody-returns" className="btn btn-secondary">
              {t('action.initiate_shipping_return')}
            </a>
          )}

          {/* Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16) — a post-delivery Shipment Return (customer sends goods back), distinct from the pre-delivery custody-return link above. */}
          {shipment.state === 'delivered' && (
            <a href={`/shipment-returns?shipmentId=${shipment.id}`} className="btn btn-secondary">
              {t('action.create_shipment_return')}
            </a>
          )}

          <button className="btn btn-secondary" onClick={() => window.open(`/print/waybill/${shipment.id}`, '_blank')}>
            {t('action.print')}
          </button>
          {shipment.state === 'delivered' && (
            <button className="btn btn-secondary" onClick={() => window.open(`/print/delivery/${shipment.id}`, '_blank')}>
              {t('document.delivery_title')}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>{t('panel.order_tracking')}</h3>
        {tracking.length === 0 ? (
          <div className="empty-state">{t('panel.no_custody_results')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.date')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.notes')}</th>
              </tr>
            </thead>
            <tbody>
              {tracking.map((ev) => (
                <tr key={ev.id}>
                  <td>{new Date(ev.occurredAt).toLocaleString()}</td>
                  <td>{ev.eventType}</td>
                  <td>{ev.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Shipping Screen Redesign directive — the Shipments screen redesigned as an operational dashboard: dynamic per-company/vehicle buckets on top (§1), a "New Shipping Orders" bucket for routeless auto-created RSH shipments (§2/§3), and a filtered list below that opens into ShipmentDetail for the full header/items/custody/tracking/action-panel view (§14). RSH Shipping Orders auto-create when a Pack Task closes (ShipmentService.onModuleInit) — there is nothing left to "create" here; this screen's job is to route and progress what already exists, never a parallel shipping/custody/inventory mechanism. */
export function Shipments() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'panel.no_shipments_yet',
    'field.rsh_number',
    'field.waybill',
    'field.driver',
    'field.status',
    'field.actions',
    'action.create',
    'field.shipping_company',
    'field.cod_amount',
    'field.vehicle',
    'field.carrier_waybill_number',
    'field.waybill_image',
    'action.save_carrier_waybill',
    'panel.carrier_waybill_required',
    'field.sales_rep',
    'panel.new_shipping_orders',
    'panel.bucket_in_progress',
    'panel.bucket_delivered',
    'panel.bucket_returned',
    'field.select_rsh',
    'action.assign_route',
    'action.reassign_route',
    'panel.order_tracking',
    'field.current_custodian',
    'action.record_collection',
    'action.initiate_shipping_return',
    'field.route_reason',
    'field.shipment_items',
    'action.create_shipment_return',
    'panel.select_rsh_to_view_details',
    'field.customer',
    'field.sales_order',
    'field.customer_phone',
    'field.governorate',
    'field.address',
    'field.shipping_method',
    'field.total_amount',
    'field.unit_price',
    'field.line_total',
    'field.product',
    'field.quantity',
    'field.date',
    'field.notes',
    'field.reason',
    'field.you',
    'field.sales_order',
    'field.total_amount',
    'field.shipment_or_order_number',
    'field.from_date',
    'field.to_date',
    'action.clear',
  ]);

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [companies, setCompanies] = useState<ShippingCompany[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedBucketKey, setSelectedBucketKey] = useState<string | null>(null);
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Warehouse / Shipment Operations Requirement (2026-09-17) — mandatory board filters
  // (customer, governorate, representative), plus the preferred ones (shipment #, order #,
  // status, date range). Operate on the shipment-level dataset, on top of the existing
  // custodian-bucket filter, never on individual SKU rows (this screen has none).
  const [customerFilter, setCustomerFilter] = useState('');
  const [governorateFilter, setGovernorateFilter] = useState('');
  const [repFilter, setRepFilter] = useState('');
  const [numberFilter, setNumberFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  async function loadAll() {
    try {
      const [shipmentData, companyData, vehicleData] = await Promise.all([
        api.get<Shipment[]>('/shipments'),
        api.get<ShippingCompany[]>('/shipments/shipping-companies'),
        api.get<Vehicle[]>('/shipments/vehicles'),
      ]);
      setShipments(shipmentData);
      setCompanies(companyData);
      setVehicles(vehicleData);
      if (hasRole('admin')) {
        const u = await api.get<AdminUser[]>('/admin/users').catch(() => []);
        setUsers(u);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load shipments.');
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newOrders = useMemo(
    () => shipments.filter((s) => !s.shippingCompanyId && !s.vehicleId && (s.state === 'created' || s.state === 'assigned')),
    [shipments],
  );

  type CustodianBucket = { kind: 'company' | 'vehicle'; id: string; label: string; counts: Record<Bucket, number> };
  // Only ACTIVE custodians get a dashboard tile — a retired vehicle or an
  // inactive shipping company has nothing new to route through it, so a
  // permanent tile for it is just clutter, not a real shortcut.
  const custodianBuckets: CustodianBucket[] = useMemo(() => {
    const buckets: CustodianBucket[] = [];
    for (const c of companies.filter((x) => x.status === 'active')) {
      const own = shipments.filter((s) => s.shippingCompanyId === c.id);
      buckets.push({
        kind: 'company',
        id: c.id,
        label: `${c.code} — ${c.name}`,
        counts: {
          in_progress: own.filter((s) => bucketOf(s.state) === 'in_progress').length,
          delivered: own.filter((s) => bucketOf(s.state) === 'delivered').length,
          returned: own.filter((s) => bucketOf(s.state) === 'returned').length,
        },
      });
    }
    for (const v of vehicles.filter((x) => x.status === 'active')) {
      const own = shipments.filter((s) => s.vehicleId === v.id);
      buckets.push({
        kind: 'vehicle',
        id: v.id,
        label: `${v.code} — ${v.plateNumber}`,
        counts: {
          in_progress: own.filter((s) => bucketOf(s.state) === 'in_progress').length,
          delivered: own.filter((s) => bucketOf(s.state) === 'delivered').length,
          returned: own.filter((s) => bucketOf(s.state) === 'returned').length,
        },
      });
    }
    return buckets;
  }, [shipments, companies, vehicles]);

  const governorateOptions = useMemo(
    () => [...new Set(shipments.map((s) => s.governorate).filter((g): g is string => !!g))].sort(),
    [shipments],
  );
  const repOptions = useMemo(
    () => [...new Set(shipments.map((s) => s.salesRepName).filter((r): r is string => !!r))].sort(),
    [shipments],
  );

  const bucketFiltered = useMemo(() => {
    if (!selectedBucketKey) return shipments;
    if (selectedBucketKey === 'new') return newOrders;
    const [kind, id, sub] = selectedBucketKey.split('::');
    return shipments.filter((s) => {
      const matchesCustodian = kind === 'company' ? s.shippingCompanyId === id : s.vehicleId === id;
      return matchesCustodian && bucketOf(s.state) === sub;
    });
  }, [shipments, selectedBucketKey, newOrders]);

  const visibleShipments = useMemo(() => {
    const numberNeedle = numberFilter.trim().toLowerCase();
    return bucketFiltered.filter((s) => {
      if (customerFilter && !(s.customerName ?? '').toLowerCase().includes(customerFilter.trim().toLowerCase())) return false;
      if (governorateFilter && s.governorate !== governorateFilter) return false;
      if (repFilter && s.salesRepName !== repFilter) return false;
      if (statusFilter && s.state !== statusFilter) return false;
      if (numberNeedle) {
        const haystack = `${s.rshNumber ?? ''} ${s.waybillNumber} ${s.salesOrderNumber ?? ''}`.toLowerCase();
        if (!haystack.includes(numberNeedle)) return false;
      }
      if (dateFrom && s.createdAt.slice(0, 10) < dateFrom) return false;
      if (dateTo && s.createdAt.slice(0, 10) > dateTo) return false;
      return true;
    });
  }, [bucketFiltered, customerFilter, governorateFilter, repFilter, statusFilter, numberFilter, dateFrom, dateTo]);

  const selectedShipment = shipments.find((s) => s.id === selectedShipmentId) ?? null;

  if (selectedShipment) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('nav.shipments')}</h1>
        </div>
        <ShipmentDetail
          shipment={selectedShipment}
          companies={companies}
          vehicles={vehicles}
          users={users}
          onBack={() => setSelectedShipmentId(null)}
          onChanged={async () => {
            await loadAll();
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.shipments')}</h1>
      </div>
      {error && <div className="error-text">{error}</div>}

      {/* Compact clickable dashboard strip — a shortcut row, not a block that
          pushes the actual shipment list off-screen. Only active custodians
          get a pill; counts are muted gray at zero and pick up their status
          color (amber/green/red) the moment there's something in them. */}
      <div className="custodian-bucket-strip">
        <div className="custodian-pill">
          <button
            className={selectedBucketKey === 'new' ? 'count-in-progress count-active' : newOrders.length > 0 ? 'count-in-progress' : 'count-zero'}
            onClick={() => setSelectedBucketKey(selectedBucketKey === 'new' ? null : 'new')}
          >
            {t('panel.new_shipping_orders')}: {newOrders.length}
          </button>
        </div>
        {custodianBuckets.map((b) => (
          <div key={`${b.kind}:${b.id}`} className="custodian-pill">
            <span className="custodian-name">{b.label}</span>
            {(['in_progress', 'delivered', 'returned'] as Bucket[]).map((sub) => {
              const key = `${b.kind}::${b.id}::${sub}`;
              const isActive = selectedBucketKey === key;
              const toneClass = b.counts[sub] > 0 ? `count-${sub.replace('_', '-')}` : 'count-zero';
              return (
                <button
                  key={sub}
                  className={`${toneClass}${isActive ? ' count-active' : ''}`}
                  title={t(sub === 'in_progress' ? 'panel.bucket_in_progress' : sub === 'delivered' ? 'panel.bucket_delivered' : 'panel.bucket_returned')}
                  onClick={() => setSelectedBucketKey(isActive ? null : key)}
                >
                  {b.counts[sub]}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Warehouse / Shipment Operations Requirement (2026-09-17) — the dispatch-warehouse
          board's mandatory filters (customer/governorate/rep) plus the preferred ones
          (shipment or order number/status/date range). Operates on the shipment-level
          dataset (`bucketFiltered`) — never on SKU rows, this screen has none. */}
      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
          <label>{t('field.customer')}</label>
          <input value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 150 }}>
          <label>{t('field.governorate')}</label>
          <select value={governorateFilter} onChange={(e) => setGovernorateFilter(e.target.value)}>
            <option value="">—</option>
            {governorateOptions.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
          <label>{t('field.sales_rep')}</label>
          <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)}>
            <option value="">—</option>
            {repOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}>
          <label>{t('field.shipment_or_order_number')}</label>
          <input value={numberFilter} onChange={(e) => setNumberFilter(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 140 }}>
          <label>{t('field.status')}</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">—</option>
            {[...new Set(shipments.map((s) => s.state))].map((st) => (
              <option key={st} value={st}>
                {t(`shipment_lifecycle.state.${st}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.from_date')}</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 0 }}>
          <label>{t('field.to_date')}</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        {(customerFilter || governorateFilter || repFilter || numberFilter || statusFilter || dateFrom || dateTo) && (
          <button
            className="btn btn-secondary"
            onClick={() => {
              setCustomerFilter('');
              setGovernorateFilter('');
              setRepFilter('');
              setNumberFilter('');
              setStatusFilter('');
              setDateFrom('');
              setDateTo('');
            }}
          >
            {t('action.clear')}
          </button>
        )}
      </div>

      {visibleShipments.length === 0 ? (
        <div className="empty-state">{t('panel.no_shipments_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.rsh_number')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('field.sales_order')}</th>
              <th>{t('field.total_amount')}</th>
              <th>{t('field.governorate')}</th>
              <th>{t('field.sales_rep')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.date')}</th>
              <th>{t('field.waybill')}</th>
              <th>{t('field.shipping_company')}</th>
              <th>{t('field.vehicle')}</th>
              <th>{t('field.cod_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleShipments.map((s) => (
              <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedShipmentId(s.id)}>
                <td>{s.rshNumber ?? '—'}</td>
                <td>{s.customerName ?? '—'}</td>
                <td>{s.salesOrderNumber ?? '—'}</td>
                <td>{s.totalAmount ?? '—'}</td>
                <td>{s.governorate ?? '—'}</td>
                <td>{s.salesRepName ?? '—'}</td>
                <td>
                  <StatusBadge code={`shipment_lifecycle.state.${s.state}`} />
                </td>
                <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                <td>{s.waybillNumber}</td>
                <td>{s.shippingCompanyId ? companies.find((c) => c.id === s.shippingCompanyId)?.name ?? '—' : '—'}</td>
                <td>{s.vehicleId ? vehicles.find((v) => v.id === s.vehicleId)?.plateNumber ?? '—' : '—'}</td>
                <td>{s.codAmount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
