import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';
import { ItemBasicPanel } from './item/ItemBasicPanel';
import { ItemBarcodesPanel } from './item/ItemBarcodesPanel';
import { ItemBomPanel } from './item/ItemBomPanel';
import { ITEM_BARCODE_LABELS, ITEM_BASIC_LABELS, ITEM_BOM_LABELS, type Category } from './item/itemMaster';

interface Product {
  id: string;
  sku: string;
  name: string;
  unitPrice: string;
  unit: string | null;
  status: string;
  createdAt: string;
  itemType: string;
  categoryId: string | null;
  defaultWarehouseId: string | null;
  reorderLevel: string | null;
  description: string | null;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface InventoryRow {
  productId: string;
  assigned: boolean;
  onHand: number;
  preliminaryHold: number;
  reserved: number;
  available: number;
  lastMovementAt: string | null;
}
interface WarehouseBalance extends InventoryRow {
  warehouse: Warehouse;
}
interface Movement {
  id: string;
  warehouseId: string;
  quantity: number | string;
  movementType: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}
interface UnitCost {
  unitCostBase?: string;
}

const TABS = ['basic', 'balances', 'movements', 'units', 'costing', 'bom'] as const;
const ITEM_TYPES_LABELS = ['finished_good', 'semi_finished', 'raw_material', 'consumable', 'service'].map((v) => `value.item_type.${v}`);
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  basic: 'panel.item_basic_info',
  balances: 'panel.item_warehouse_balances',
  movements: 'panel.item_movements',
  units: 'panel.item_units_barcodes',
  costing: 'panel.item_costing_pricing',
  bom: 'panel.item_bom',
};

/** Reference types with an existing detail route; any other type is shown as text (never a guessed link). */
function documentRoute(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === 'warehouse_transaction') return `/movement-center/${id}`;
  if (type === 'sales_order') return `/sales-orders/${id}`;
  if (type === 'work_order') return `/manufacturing/work-orders/${id}`;
  return null;
}

/** 'YYYY-MM-DD' minus one calendar day (pure date arithmetic, no time zone involved). */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Item Details (2026-10-15) — the click-through page for one inventory item, built on existing, already authorized endpoints
 * (no new calculation):
 *   - the item:              GET /products/:id
 *   - warehouse balances:    GET /inventory/warehouses/:id/inventory (the Inventory grid's own source, per visible warehouse)
 *   - movements:             GET /inventory/reports/movements (date-only `dateTo` covers the whole day — CR-2026-10-15 M-1);
 *                            the opening balance is the same report summed up to the day before `dateFrom`
 *   - cost per warehouse:    GET /inventory/valuation/current-cost (only with `inventory.valuation.view`)
 *   - BOM:                   the Manufacturing BOM facade (`ItemBomPanel`), or `/bom` for read-only users
 * Master data step 1 (2026-10-15) made the basic information, barcodes and BOM editable (`./item/*`); the image is still a
 * reserved placeholder (D-MD8).
 */
/** Route element: remounts the page per item, so following a BOM component link never shows the previous item's state. */
export function ItemDetailsRoute() {
  const { productId = '' } = useParams();
  return <ItemDetails key={productId} productId={productId} />;
}

function ItemDetails({ productId }: { productId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { t, preload } = useLanguage();

  const originWarehouseId = searchParams.get('warehouseId') ?? '';
  const tab: Tab = (TABS as readonly string[]).includes(searchParams.get('tab') ?? '') ? (searchParams.get('tab') as Tab) : 'basic';

  const [product, setProduct] = useState<Product | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [balances, setBalances] = useState<WarehouseBalance[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [mvWarehouseId, setMvWarehouseId] = useState(originWarehouseId);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [opening, setOpening] = useState(0);
  const [docNumbers, setDocNumbers] = useState<Record<string, string>>({});
  const [mvError, setMvError] = useState<string | null>(null);

  const [costs, setCosts] = useState<Record<string, string | null>>({});
  const [categories, setCategories] = useState<Category[]>([]);

  const canViewCost = can('inventory.valuation.view', 'read-only');
  const canEdit = can('sales.catalog.edit', 'editable');
  const canEditWarehouse = can('inventory.warehouse.edit', 'editable');

  preload([
    'nav.inventory',
    'nav.item_details',
    ...Object.values(TAB_LABEL),
    'action.back_to_inventory',
    'action.edit_item',
    'panel.item_no_image',
    'panel.not_in_data_model',
    'panel.item_no_barcode_model',
    'panel.item_no_bom',
    'panel.item_no_movements',
    'panel.item_no_balances',
    'panel.item_balances_reconciled',
    'panel.item_balances_not_reconciled',
    'panel.item_dates_posting_time',
    'panel.item_cost_restricted',
    'field.code',
    'field.name',
    'field.status',
    'field.item_type',
    'field.item_category',
    'field.base_unit',
    'field.primary_default_warehouse',
    'field.assigned_warehouses',
    'field.reorder_level',
    'field.item_description',
    'field.item_image',
    'field.barcode',
    'field.unit',
    'field.warehouse',
    'field.on_hand',
    'field.preliminary_hold',
    'field.reserved',
    'field.available',
    'field.last_movement',
    'field.totals',
    'field.from_date',
    'field.to_date',
    'field.posting_time',
    'field.movement_type',
    'field.source_document',
    'field.incoming_qty',
    'field.outgoing_qty',
    'field.running_balance',
    'field.opening_balance',
    'field.closing_balance',
    'field.all_visible_warehouses',
    'field.base_price',
    'field.unit_cost',
    'field.component',
    'field.quantity',
    'nav.bom',
    'nav.price_lists',
    'panel.item_below_reorder',
    ...ITEM_TYPES_LABELS,
    ...ITEM_BASIC_LABELS,
    ...ITEM_BARCODE_LABELS,
    ...ITEM_BOM_LABELS,
  ]);

  // The item, the visible warehouses and each warehouse's row for this item (the Inventory grid's own numbers).
  useEffect(() => {
    (async () => {
      try {
        const [p, wh, cats] = await Promise.all([
          api.get<Product>(`/products/${productId}`),
          api.get<Warehouse[]>('/inventory/warehouses'),
          api.get<Category[]>('/product-categories').catch(() => [] as Category[]),
        ]);
        setProduct(p);
        setWarehouses(wh);
        setCategories(cats);
        const rows = await Promise.all(
          wh.map(async (w) => {
            const params = new URLSearchParams({ scope: 'all', search: p.sku, page: '1', pageSize: '200' });
            const page = await api.get<{ rows: InventoryRow[] }>(`/inventory/warehouses/${w.id}/inventory?${params}`).catch(() => ({ rows: [] }));
            const row = page.rows.find((r) => r.productId === p.id);
            return row ? { ...row, warehouse: w } : null;
          }),
        );
        setBalances(rows.filter((r): r is WarehouseBalance => r !== null && (r.assigned || r.onHand !== 0 || r.reserved !== 0 || r.preliminaryHold !== 0)));
      } catch (err) {
        setLoadError(err);
      }
    })();
  }, [productId]);

  // Movements: rows of the selected window + opening balance (everything up to the day before `dateFrom`).
  useEffect(() => {
    if (!product) return;
    (async () => {
      try {
        setMvError(null);
        const q = (extra: Record<string, string>) => {
          const params = new URLSearchParams({ productId: product.id, ...extra });
          if (mvWarehouseId) params.set('warehouseId', mvWarehouseId);
          return `/inventory/reports/movements?${params}`;
        };
        const range: Record<string, string> = {};
        if (dateFrom) range.dateFrom = dateFrom;
        if (dateTo) range.dateTo = dateTo;
        const [rows, before] = await Promise.all([
          api.get<Movement[]>(q(range)),
          dateFrom ? api.get<Movement[]>(q({ dateTo: previousDay(dateFrom) })) : Promise.resolve([] as Movement[]),
        ]);
        setOpening(before.reduce((s, m) => s + Number(m.quantity), 0));
        setMovements([...rows].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1)));
        // Document numbers for warehouse transactions (each read is itself warehouse-scoped; a refused one stays unlinked).
        const ids = [...new Set(rows.filter((r) => r.referenceType === 'warehouse_transaction' && r.referenceId).map((r) => r.referenceId as string))];
        const found = await Promise.all(
          ids.map((id) =>
            api
              .get<{ transactionNumber?: string }>(`/warehouse-transactions/${id}`)
              .then((d) => [id, d.transactionNumber ?? ''] as const)
              .catch(() => [id, ''] as const),
          ),
        );
        setDocNumbers(Object.fromEntries(found.filter(([, n]) => n)));
      } catch (err) {
        setMvError(err instanceof ApiError ? err.message : 'Failed to load movements.');
      }
    })();
  }, [product, mvWarehouseId, dateFrom, dateTo]);

  // Unit cost per warehouse holding stock — only for users who may view valuation.
  useEffect(() => {
    if (!product || !balances || !canViewCost) return;
    (async () => {
      const entries = await Promise.all(
        balances
          .filter((b) => b.onHand !== 0)
          .map((b) =>
            api
              .get<UnitCost>(`/inventory/valuation/current-cost?productId=${product.id}&warehouseId=${b.warehouse.id}`)
              .then((c) => [b.warehouse.id, c.unitCostBase ?? null] as const)
              .catch(() => [b.warehouse.id, null] as const),
          ),
      );
      setCosts(Object.fromEntries(entries));
    })();
  }, [product, balances, canViewCost]);

  async function reloadProduct() {
    setProduct(await api.get<Product>(`/products/${productId}`));
  }
  async function reloadCategories() {
    setCategories(await api.get<Category[]>('/product-categories').catch(() => [] as Category[]));
  }

  const totals = useMemo(
    () =>
      (balances ?? []).reduce(
        (s, b) => ({ onHand: s.onHand + b.onHand, preliminaryHold: s.preliminaryHold + b.preliminaryHold, reserved: s.reserved + b.reserved, available: s.available + b.available }),
        { onHand: 0, preliminaryHold: 0, reserved: 0, available: 0 },
      ),
    [balances],
  );
  const ledger = useMemo(
    () =>
      (movements ?? []).reduce<Array<{ m: Movement; incoming: number; outgoing: number; balance: number }>>((rows, m) => {
        const q = Number(m.quantity);
        const previous = rows.length ? rows[rows.length - 1].balance : opening;
        return [...rows, { m, incoming: q > 0 ? q : 0, outgoing: q < 0 ? -q : 0, balance: previous + q }];
      }, []),
    [movements, opening],
  );
  const closing = ledger.length ? ledger[ledger.length - 1].balance : opening;
  const expectedOnHand = mvWarehouseId ? (balances ?? []).find((b) => b.warehouse.id === mvWarehouseId)?.onHand ?? 0 : totals.onHand;

  const warehouseLabel = (id: string) => {
    const w = warehouses.find((x) => x.id === id);
    return w ? `${w.code} — ${w.name}` : id.slice(0, 8);
  };
  const labelOr = (code: string, fallback: string) => {
    const v = t(code);
    return v === code ? fallback : v;
  };
  const backHref = `/inventory${originWarehouseId ? `?warehouseId=${originWarehouseId}` : ''}`;

  function selectTab(next: Tab) {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  }

  if (loadError) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('nav.item_details')}</h1>
          <Link className="btn btn-secondary" to={backHref}>
            {t('action.back_to_inventory')}
          </Link>
        </div>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!product) return <div className="empty-state">Loading…</div>;

  // All six tabs are always shown (the committed Item Details contract); the BOM tab itself explains when an item type has no BOM.
  const visibleTabs = TABS;
  const activeTab: Tab = visibleTabs.includes(tab) ? tab : 'basic';
  const category = categories.find((c) => c.id === product.categoryId);
  const belowReorder = balances !== null && product.reorderLevel !== null && totals.available <= Number(product.reorderLevel);

  return (
    <div className="item-details">
      <div className="page-header">
        <div>
          <div className="item-breadcrumb">
            <Link to={backHref}>{t('nav.inventory')}</Link> / {t('nav.item_details')}
          </div>
          <h1>{t('nav.item_details')}</h1>
        </div>
        <div className="action-row">
          {canEdit && (
            <button className="btn btn-primary" onClick={() => navigate('/products')}>
              {t('action.edit_item')}
            </button>
          )}
          <Link className="btn btn-secondary" to={backHref}>
            {t('action.back_to_inventory')}
          </Link>
        </div>
      </div>

      <div className="card item-header">
        <div className="item-image" role="img" aria-label={t('panel.item_no_image')}>
          <span className="item-image-initials">{product.sku.slice(0, 2).toUpperCase()}</span>
          <span className="item-image-caption">{t('panel.item_no_image')}</span>
        </div>
        <div className="item-header-main">
          <h2 className="item-title">{product.name}</h2>
          <div className="item-sku">{product.sku}</div>
          <div className="item-header-meta">
            <StatusBadge code={`product_status.${product.status}`} />
            <span>
              {t('field.item_type')}: <strong>{t(`value.item_type.${product.itemType}`)}</strong>
            </span>
            {category && (
              <span>
                {t('field.item_category')}: <strong>{category.name}</strong>
              </span>
            )}
            <span>
              {t('field.base_unit')}: <strong>{product.unit ?? '—'}</strong>
            </span>
            <span>
              {t('field.on_hand')}: <strong>{balances ? totals.onHand : '…'}</strong>
            </span>
            <span>
              {t('field.available')}: <strong>{balances ? totals.available : '…'}</strong>
            </span>
            {belowReorder && (
              <span className="status-badge negative" data-testid="item-below-reorder">
                {t('panel.item_below_reorder')} ({Number(product.reorderLevel)})
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="item-tabs" role="tablist">
        {visibleTabs.map((k, i) => (
          <button key={k} role="tab" aria-selected={activeTab === k} className={`item-tab${activeTab === k ? ' active' : ''}`} onClick={() => selectTab(k)}>
            {i + 1}- {t(TAB_LABEL[k])}
          </button>
        ))}
      </div>

      <div className="card item-panel" role="tabpanel">
        {activeTab === 'basic' && (
          <ItemBasicPanel
            product={product}
            categories={categories}
            assigned={balances ? balances.filter((b) => b.assigned).map((b) => b.warehouse) : null}
            canEditCatalog={canEdit}
            canEditWarehouse={canEditWarehouse}
            onSaved={reloadProduct}
            onCategoriesChanged={reloadCategories}
          />
        )}

        {activeTab === 'balances' &&
          (balances === null ? (
            <div className="empty-state">Loading…</div>
          ) : balances.length === 0 ? (
            <div className="empty-state">{t('panel.item_no_balances')}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.warehouse')}</th>
                    <th>{t('field.on_hand')}</th>
                    <th>{t('field.preliminary_hold')}</th>
                    <th>{t('field.reserved')}</th>
                    <th>{t('field.available')}</th>
                    {canViewCost && <th>{t('field.unit_cost')}</th>}
                    <th>{t('field.last_movement')}</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b) => (
                    <tr key={b.warehouse.id}>
                      <td>
                        {b.warehouse.code} — {b.warehouse.name}
                      </td>
                      <td>{b.onHand}</td>
                      <td>{b.preliminaryHold}</td>
                      <td>{b.reserved}</td>
                      <td style={{ color: b.available < 0 ? '#a3262d' : undefined }}>{b.available}</td>
                      {canViewCost && <td>{costs[b.warehouse.id] ?? '—'}</td>}
                      <td>{b.lastMovementAt ? new Date(b.lastMovementAt).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600 }}>
                    <td>{t('field.totals')}</td>
                    <td>{totals.onHand}</td>
                    <td>{totals.preliminaryHold}</td>
                    <td>{totals.reserved}</td>
                    <td>{totals.available}</td>
                    {canViewCost && <td />}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          ))}

        {activeTab === 'movements' && (
          <>
            <div className="item-filters">
              <div className="form-field">
                <label>{t('field.warehouse')}</label>
                <select value={mvWarehouseId} onChange={(e) => setMvWarehouseId(e.target.value)}>
                  <option value="">{t('field.all_visible_warehouses')}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>{t('field.from_date')}</label>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
              <div className="form-field">
                <label>{t('field.to_date')}</label>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
            </div>
            <p className="item-note">{t('panel.item_dates_posting_time')}</p>
            {mvError && <div className="error-text">{mvError}</div>}
            {movements === null ? (
              <div className="empty-state">Loading…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table item-ledger">
                  <thead>
                    <tr>
                      <th>{t('field.posting_time')}</th>
                      <th>{t('field.movement_type')}</th>
                      <th>{t('field.source_document')}</th>
                      <th>{t('field.warehouse')}</th>
                      <th>{t('field.incoming_qty')}</th>
                      <th>{t('field.outgoing_qty')}</th>
                      <th>{t('field.running_balance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="item-ledger-opening">
                      <td colSpan={6}>{t('field.opening_balance')}</td>
                      <td>{opening}</td>
                    </tr>
                    {ledger.length === 0 && (
                      <tr>
                        <td colSpan={7} className="empty-state">
                          {t('panel.item_no_movements')}
                        </td>
                      </tr>
                    )}
                    {ledger.map(({ m, incoming, outgoing, balance }) => {
                      const route = documentRoute(m.referenceType, m.referenceId);
                      const refLabel = m.referenceType ? labelOr(`reference_type.${m.referenceType}`, m.referenceType) : '—';
                      const number = m.referenceId ? docNumbers[m.referenceId] ?? m.referenceId.slice(0, 8) : '';
                      return (
                        <tr key={m.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.createdAt).toLocaleString()}</td>
                          <td>{labelOr(`movement_type.${m.movementType}`, m.movementType)}</td>
                          <td>
                            {refLabel}
                            {number && ' · '}
                            {number && (route ? <Link className="item-doc-number" to={route}>{number}</Link> : <span className="item-doc-number">{number}</span>)}
                          </td>
                          <td>{warehouseLabel(m.warehouseId)}</td>
                          <td>{incoming || ''}</td>
                          <td>{outgoing || ''}</td>
                          <td style={{ fontWeight: 600 }}>{balance}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 600 }}>
                      <td colSpan={4}>{t('field.closing_balance')}</td>
                      <td>{ledger.reduce((s, r) => s + r.incoming, 0)}</td>
                      <td>{ledger.reduce((s, r) => s + r.outgoing, 0)}</td>
                      <td>{closing}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {movements !== null && !dateTo && balances && (
              <p className={closing === expectedOnHand ? 'item-reconciled' : 'error-text'} data-testid="item-reconciliation">
                {t(closing === expectedOnHand ? 'panel.item_balances_reconciled' : 'panel.item_balances_not_reconciled')} ({closing} / {expectedOnHand})
              </p>
            )}
          </>
        )}

        {activeTab === 'units' && <ItemBarcodesPanel productId={product.id} unit={product.unit} canEdit={canEdit} />}

        {activeTab === 'costing' && (
          <>
            <div className="detail-grid">
              <Field label={t('field.base_price')} value={product.unitPrice} />
              <Field label={t('nav.price_lists')} value={<Link to="/price-lists">{t('nav.price_lists')}</Link>} />
            </div>
            {canViewCost ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('field.warehouse')}</th>
                    <th>{t('field.on_hand')}</th>
                    <th>{t('field.unit_cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(balances ?? [])
                    .filter((b) => b.onHand !== 0)
                    .map((b) => (
                      <tr key={b.warehouse.id}>
                        <td>
                          {b.warehouse.code} — {b.warehouse.name}
                        </td>
                        <td>{b.onHand}</td>
                        <td>{costs[b.warehouse.id] ?? '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <p className="item-note">{t('panel.item_cost_restricted')}</p>
            )}
          </>
        )}

        {activeTab === 'bom' && <ItemBomPanel productId={product.id} originWarehouseId={originWarehouseId} />}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-field">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
