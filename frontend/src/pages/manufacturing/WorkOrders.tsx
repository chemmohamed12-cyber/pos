import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { fmtDate } from '../../lib/formatDateTime';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  /** 'operational' = a Work Order's WIP sub-warehouse (ADR-061 Option A) — never a place to assemble or plan into. */
  kind?: 'main' | 'operational';
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
  state: string;
  wipValue: string;
}

const STATES = ['draft', 'released', 'in_progress', 'on_hold', 'completed', 'cancelled'];

/** ADR-061 §18 — Work Orders screen: list + create. Lifecycle actions live on WorkOrderDetail. */
export function WorkOrders() {
  const { t, preload } = useLanguage();
  const [workOrders, setWorkOrders] = useState<WorkOrder[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // ADR-061 Addendum 1 (A3): manufacturable = has an ACTIVE BOM. null = list unavailable to this user -> fall back to all products (the server still enforces at create).
  const [manufacturableIds, setManufacturableIds] = useState<Set<string> | null>(null);
  const [finishedProductId, setFinishedProductId] = useState('');
  const [quantityPlanned, setQuantityPlanned] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');

  preload([
    'nav.manufacturing_work_orders',
    'field.work_order_number',
    'field.finished_product',
    'field.warehouse',
    'field.quantity_planned',
    'field.quantity_produced',
    'field.quantity_remaining',
    'field.status',
    'field.wip_value',
    'field.created_at',
    'field.actions',
    'action.create_work_order',
    'action.view',
    'panel.no_work_orders_yet',
    'field.all_document_types',
    ...STATES.map((s) => `work_order_lifecycle.state.${s}`),
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
      try {
        const [prod, wh] = await Promise.all([api.get<Product[]>('/products/all'), api.get<Warehouse[]>('/inventory/warehouses')]);
        setProducts(prod);
        setWarehouses(wh.filter((w) => w.kind !== 'operational'));
        try {
          const boms = await api.get<Array<{ finishedProductId: string; status: string }>>('/manufacturing/boms');
          setManufacturableIds(new Set(boms.filter((b) => b.status === 'active').map((b) => b.finishedProductId)));
        } catch {
          setManufacturableIds(null);
        }
      } catch (err) {
        // Foundation fix: no error handling — the create-work-order form's
        // product/warehouse selects were silently left empty on failure.
        setError(err instanceof ApiError ? err.message : 'Failed to load products/warehouses.');
      }
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

  const filtered = workOrders?.filter((wo) => {
    if (stateFilter && wo.state !== stateFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return wo.workOrderNumber.toLowerCase().includes(q) || productName(wo.finishedProductId).toLowerCase().includes(q);
  });

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
              {products.filter((p) => !manufacturableIds || manufacturableIds.has(p.id)).map((p) => (
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

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <input placeholder={`${t('field.work_order_number')} / ${t('field.finished_product')}`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">{t('field.all_document_types')}</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {t(`work_order_lifecycle.state.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {workOrders === null ? (
        <div className="empty-state">Loading…</div>
      ) : filtered && filtered.length === 0 ? (
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
              <th>{t('field.quantity_remaining')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.wip_value')}</th>
              <th>{t('field.created_at')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((wo) => (
              <tr key={wo.id}>
                <td>{wo.workOrderNumber}</td>
                <td>{productName(wo.finishedProductId)}</td>
                <td>{warehouseName(wo.warehouseId)}</td>
                <td>{wo.quantityPlanned}</td>
                <td>{wo.quantityProduced}</td>
                <td>{wo.quantityPlanned - wo.quantityProduced}</td>
                <td>
                  <StatusBadge code={`work_order_lifecycle.state.${wo.state}`} />
                </td>
                <td>{wo.wipValue}</td>
                <td>{fmtDate(wo.createdAt)}</td>
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
