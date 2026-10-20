import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { nameOf, currentLang, STATUS_NAMES } from '../lib/displayNames';

interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Reservation {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: number;
  status: string;
}
interface OrderLine {
  id: string;
  productId: string;
  quantity: number;
}

/**
 * MULTI-LINE FIX (CTO directive): this used to reserve only the order's
 * FIRST line — a real correctness gap, not a cosmetic one, since
 * Fulfillment only ever dispatched what was reserved. Inventory already
 * supports one reservation per (warehouse, product) — see
 * `InventoryService.reserveStock` — so this now reserves every line
 * individually and shows each line's own reservation state. All lines
 * reserve against the SAME warehouse (a single fulfillment order can't
 * span warehouses in V1 — `FulfillmentService.createFulfillmentOrder`
 * enforces this server-side too, not just here).
 */
export function ReserveStockPanel({ salesOrderId, orderStatus, lines }: { salesOrderId: string; orderStatus: string; lines: OrderLine[] }) {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'panel.stock_reservation',
    'panel.waiting_for_rep_reservation',
    'field.warehouse',
    'field.product',
    'field.quantity',
    'field.status',
    'action.reserve',
    'action.applies_to_every_line',
    'action.not_reserved',
  ]);

  async function load() {
    const [wh, res, products] = await Promise.all([
      api.get<Warehouse[]>('/inventory/warehouses'),
      api.get<Reservation[]>(`/inventory/reservations/by-order?salesOrderId=${salesOrderId}`),
      api.get<Array<{ id: string; name: string }>>('/products'),
    ]);
    setWarehouses(wh);
    setReservations(res);
    setProductNames(Object.fromEntries(products.map((p) => [p.id, p.name])));
    if (wh[0] && !warehouseId) setWarehouseId(wh[0].id);
    setLoaded(true);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesOrderId]);

  if (orderStatus !== 'deposit_verification' || !loaded || lines.length === 0) return null;

  async function reserveLine(line: OrderLine) {
    setBusyProductId(line.productId);
    setError(null);
    try {
      await api.post('/inventory/reservations', {
        warehouseId,
        productId: line.productId,
        quantity: line.quantity,
        salesOrderId,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reserve stock.');
    } finally {
      setBusyProductId(null);
    }
  }

  const reservationByProduct = new Map(reservations.map((r) => [r.productId, r]));
  const allReserved = lines.every((l) => reservationByProduct.has(l.productId));

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>{t('panel.stock_reservation')}</h3>
      {error && <div className="error-text">{error}</div>}

      {!allReserved && can('wf.sales.rep.act', 'editable') && (
        <div className="form-field" style={{ maxWidth: 320 }}>
          <label>
            {t('field.warehouse')} ({t('action.applies_to_every_line')})
          </label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.product')}</th>
            <th>{t('field.quantity')}</th>
            <th>{t('field.status')}</th>
            {!allReserved && can('wf.sales.rep.act', 'editable') && <th></th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const reservation = reservationByProduct.get(line.productId);
            return (
              <tr key={line.id}>
                <td>{productNames[line.productId] ?? line.productId}</td>
                <td>{line.quantity}</td>
                <td>
                  {reservation ? (
                    <span className="status-badge positive">{nameOf(STATUS_NAMES, reservation.status, currentLang())}</span>
                  ) : (
                    <span className="status-badge">{t('action.not_reserved')}</span>
                  )}
                </td>
                {!allReserved && can('wf.sales.rep.act', 'editable') && (
                  <td>
                    {!reservation && (
                      <button
                        className="btn btn-secondary"
                        disabled={busyProductId === line.productId || !warehouseId}
                        onClick={() => reserveLine(line)}
                      >
                        {t('action.reserve')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {!allReserved && !can('wf.sales.rep.act', 'editable') && <div className="empty-state">{t('panel.waiting_for_rep_reservation')}</div>}
    </div>
  );
}
