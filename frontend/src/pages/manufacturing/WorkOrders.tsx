import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

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
interface WorkOrder {
  id: string;
  workOrderNumber: string;
  finishedProductId: string;
  quantityPlanned: number;
  quantityProduced: number;
  warehouseId: string;
  createdAt: string;
}

/** ADR-061 §18 — Work Orders screen: list + create. Lifecycle actions live on WorkOrderDetail. */
export function WorkOrders() {
  const { t, preload } = useLanguage();
  const [workOrders, setWorkOrders] = useState<WorkOrder[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [finishedProductId, setFinishedProductId] = useState('');
  const [quantityPlanned, setQuantityPlanned] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.manufacturing_work_orders',
    'field.work_order_number',
    'field.finished_product',
    'field.warehouse',
    'field.quantity_planned',
    'field.quantity_produced',
    'field.created_at',
    'field.actions',
    'action.create_work_order',
    'action.view',
    'panel.no_work_orders_yet',
  ]);

  async function loadWorkOrders() {
    try {
      setWorkOrders(await api.get<WorkOrder[]>('/manufacturing/work-orders'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load work orders.');
    }
  }

  useEffect(() => {
    (async () => {
      const [prod, wh] = await Promise.all([api.get<Product[]>('/products/all'), api.get<Warehouse[]>('/inventory/warehouses')]);
      setProducts(prod);
      setWarehouses(wh);
    })();
    loadWorkOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/manufacturing/work-orders', {
        finishedProductId,
        quantityPlanned: Number(quantityPlanned),
        warehouseId,
      });
      setFinishedProductId('');
      setQuantityPlanned('');
      setWarehouseId('');
      await loadWorkOrders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create work order.');
    } finally {
      setCreating(false);
    }
  }

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.name ?? id.slice(0, 8);

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_work_orders')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.finished_product')}</label>
            <select value={finishedProductId} onChange={(e) => setFinishedProductId(e.target.value)} required>
              <option value="">—</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.quantity_planned')}</label>
            <input type="number" min={1} step={1} value={quantityPlanned} onChange={(e) => setQuantityPlanned(e.target.value)} required />
          </div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 200 }}>
            <label>{t('field.warehouse')}</label>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
              <option value="">—</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {t('action.create_work_order')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {workOrders === null ? (
        <div className="empty-state">Loading…</div>
      ) : workOrders.length === 0 ? (
        <div className="empty-state">{t('panel.no_work_orders_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.work_order_number')}</th>
              <th>{t('field.finished_product')}</th>
              <th>{t('field.warehouse')}</th>
              <th>{t('field.quantity_planned')}</th>
              <th>{t('field.quantity_produced')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {workOrders.map((wo) => (
              <tr key={wo.id}>
                <td>{wo.workOrderNumber}</td>
                <td>{productName(wo.finishedProductId)}</td>
                <td>{warehouseName(wo.warehouseId)}</td>
                <td>{wo.quantityPlanned}</td>
                <td>{wo.quantityProduced}</td>
                <td>{new Date(wo.createdAt).toLocaleDateString()}</td>
                <td>
                  <Link className="btn btn-secondary" to={`/manufacturing/work-orders/${wo.id}`}>
                    {t('action.view')}
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
