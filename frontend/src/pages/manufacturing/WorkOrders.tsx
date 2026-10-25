import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { BlockedReason, DataTable, EmptyState, FormField, StatusChip } from '../../components/mfg';
import { fmtDate } from '../../lib/formatDateTime';
import { NewProcessOrder } from './NewProcessOrder';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  /** 'operational' = a Work Order's WIP sub-warehouse (ADR-061 Option A) - never a place to assemble or plan into. */
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
  quantityScrapped?: number;
  processVersionId?: string | null;
  warehouseId: string;
  createdAt: string;
  state: string;
  wipValue: string;
}

const STATES = ['draft', 'released', 'in_progress', 'on_hold', 'completed', 'cancelled'];
type PathFilter = '' | 'basic' | 'process';
type Tab = 'basic' | 'process';

/** Quantity still to be accounted for on an order: what is planned minus what was produced AND what was scrapped (scrap uses up plan units too). */
export const remainingOf = (wo: { quantityPlanned: number; quantityProduced: number; quantityScrapped?: number }) => wo.quantityPlanned - wo.quantityProduced - (wo.quantityScrapped ?? 0);

/** ADR-061 §18 + UX redesign stage 4 - Work Orders: create a basic or a multi-stage order, and a list that tells the two kinds apart and shows the correct remaining quantity. */
export function WorkOrders() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canCreate = can('manufacturing.work_order.create', 'editable');
  const canProcesses = can('manufacturing.routing.view', 'read-only');
  const [workOrders, setWorkOrders] = useState<WorkOrder[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // ADR-061 Addendum 1 (A3): manufacturable = has an ACTIVE BOM. null = list unavailable to this user -> fall back to all products (the server still enforces at create).
  const [manufacturableIds, setManufacturableIds] = useState<Set<string> | null>(null);
  const [tab, setTab] = useState<Tab>('basic');
  const [finishedProductId, setFinishedProductId] = useState('');
  const [quantityPlanned, setQuantityPlanned] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pathFilter, setPathFilter] = useState<PathFilter>('');
  const stateFilter = STATES.includes(params.get('state') ?? '') ? (params.get('state') as string) : '';

  async function loadWorkOrders() {
    try {
      setWorkOrders(await api.get<WorkOrder[]>('/manufacturing/work-orders'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
    }
  }

  useEffect(() => {
    void (async () => {
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
        setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
      }
    })();
    void loadWorkOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/manufacturing/work-orders', { finishedProductId, quantityPlanned: Number(quantityPlanned), warehouseId });
      setFinishedProductId('');
      setQuantityPlanned('');
      setWarehouseId('');
      await loadWorkOrders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setCreating(false);
    }
  }

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.name ?? id.slice(0, 8);
  const qtyNum = Number(quantityPlanned);
  const qtyError = quantityPlanned.trim() !== '' && (!Number.isInteger(qtyNum) || qtyNum < 1) ? t('mfg2.qa.qty_invalid') : null;

  const filtered = useMemo(
    () =>
      (workOrders ?? []).filter((wo) => {
        if (stateFilter && wo.state !== stateFilter) return false;
        if (pathFilter === 'basic' && wo.processVersionId) return false;
        if (pathFilter === 'process' && !wo.processVersionId) return false;
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return wo.workOrderNumber.toLowerCase().includes(q) || productName(wo.finishedProductId).toLowerCase().includes(q);
      }),
    [workOrders, stateFilter, pathFilter, search, products], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const setState = (s: string) => {
    const next = new URLSearchParams(params);
    if (s) next.set('state', s);
    else next.delete('state');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_work_orders')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.wo.intro')}
      </p>
      {error && <BlockedReason danger>{error}</BlockedReason>}

      {canCreate && (
        <section className="card" style={{ marginBlockEnd: 20 }} aria-labelledby="wo-new-title">
          <h2 id="wo-new-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
            {t('mfg2.wo.new.title')}
          </h2>
          <div role="tablist" aria-label={t('mfg2.wo.new.title')} className="mfg-tabs">
            {(['basic', 'process'] as const).map((k) => (
              <button key={k} role="tab" type="button" aria-selected={tab === k} className={`mfg-tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)} data-testid={`wo-tab-${k}`}>
                {t(`mfg2.wo.tab.${k}`)}
              </button>
            ))}
          </div>
          {tab === 'basic' ? (
            <form onSubmit={onCreate} data-testid="wo-basic-form">
              <p className="mfg-note" style={{ marginBlockStart: 0 }}>
                {t('mfg2.wo.basic.help')}
              </p>
              <div className="mfg-grid cols-3">
                <FormField label={t('field.finished_product')} hint={t('mfg2.wo.basic.product_hint')} required>
                  {(p) => (
                    <select {...p} value={finishedProductId} onChange={(e) => setFinishedProductId(e.target.value)}>
                      <option value="">{t('mfg2.common.choose')}</option>
                      {products
                        .filter((x) => !manufacturableIds || manufacturableIds.has(x.id))
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.sku} — {x.name}
                          </option>
                        ))}
                    </select>
                  )}
                </FormField>
                <FormField label={t('field.quantity_planned')} hint={t('mfg2.qa.qty_hint')} error={qtyError} required>
                  {(p) => <input {...p} type="number" min={1} step={1} value={quantityPlanned} onChange={(e) => setQuantityPlanned(e.target.value)} />}
                </FormField>
                <FormField label={t('field.warehouse')} hint={t('mfg2.qa.warehouse_hint')} required>
                  {(p) => (
                    <select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                      <option value="">{t('mfg2.common.choose')}</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} — {w.name}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
              </div>
              <div className="mfg-actions">
                <button className="btn btn-primary" type="submit" disabled={creating || !finishedProductId || !warehouseId || !qtyNum || !!qtyError}>
                  {t('action.create_work_order')}
                </button>
                <span className="mfg-note">{t('mfg2.wo.basic.quick_hint')}</span>{' '}
                {can('inventory.assembly.create', 'editable') && <Link to="/manufacturing/assembly">{t('nav.manufacturing_quick_assembly')}</Link>}
              </div>
            </form>
          ) : (
            <NewProcessOrder canReadProcesses={canProcesses} />
          )}
        </section>
      )}

      <section className="card" style={{ marginBlockEnd: 16 }} aria-label={t('mfg2.wo.filters')}>
        <div className="mfg-grid cols-3">
          <FormField label={t('mfg2.wo.search')}>{(p) => <input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}</FormField>
          <FormField label={t('field.status')}>
            {(p) => (
              <select {...p} value={stateFilter} onChange={(e) => setState(e.target.value)} data-testid="wo-state-filter">
                <option value="">{t('mfg2.wo.all')}</option>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {t(`work_order_lifecycle.state.${s}`)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('mfg2.col.path')}>
            {(p) => (
              <select {...p} value={pathFilter} onChange={(e) => setPathFilter(e.target.value as PathFilter)}>
                <option value="">{t('mfg2.wo.all')}</option>
                <option value="basic">{t('mfg2.path.basic')}</option>
                <option value="process">{t('mfg2.path.process')}</option>
              </select>
            )}
          </FormField>
        </div>
      </section>

      {workOrders === null ? (
        <div className="mfg-note">{t('mfg2.common.loading')}</div>
      ) : (
        <DataTable
          caption={t('mfg2.wo.list.title')}
          rows={filtered}
          rowKey={(wo) => wo.id}
          empty={<EmptyState title={t('mfg2.wo.list.empty_title')} description={workOrders.length === 0 ? t('mfg2.wo.list.empty_desc') : t('mfg2.wo.list.empty_filtered')} />}
          columns={[
            { key: 'n', header: t('field.work_order_number'), render: (wo) => <Link to={`/manufacturing/work-orders/${wo.id}`}>{wo.workOrderNumber}</Link> },
            { key: 'p', header: t('field.finished_product'), render: (wo) => productName(wo.finishedProductId) },
            { key: 'path', header: t('mfg2.col.path'), render: (wo) => <StatusChip tone={wo.processVersionId ? 'info' : 'neutral'}>{wo.processVersionId ? t('mfg2.path.process') : t('mfg2.path.basic')}</StatusChip> },
            { key: 'w', header: t('field.warehouse'), render: (wo) => warehouseName(wo.warehouseId) },
            { key: 'pl', header: t('field.quantity_planned'), align: 'end', render: (wo) => wo.quantityPlanned },
            { key: 'pr', header: t('field.quantity_produced'), align: 'end', render: (wo) => wo.quantityProduced },
            { key: 'sc', header: t('mfg2.col.scrapped'), align: 'end', render: (wo) => wo.quantityScrapped ?? 0 },
            { key: 'rm', header: t('field.quantity_remaining'), align: 'end', render: (wo) => remainingOf(wo) },
            { key: 'st', header: t('field.status'), render: (wo) => <StatusBadge code={`work_order_lifecycle.state.${wo.state}`} /> },
            { key: 'wip', header: t('field.wip_value'), align: 'end', render: (wo) => wo.wipValue },
            { key: 'cr', header: t('field.created_at'), render: (wo) => fmtDate(wo.createdAt) },
            {
              key: 'a',
              header: t('field.actions'),
              render: (wo) => (
                <Link className="btn btn-secondary" to={`/manufacturing/work-orders/${wo.id}`}>
                  {t('action.view')}
                </Link>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
