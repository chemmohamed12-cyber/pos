import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { ExcelImportExport } from '../components/ExcelImportExport';
import { ProductCombobox } from '../components/ProductCombobox';
import type { ProductOption } from '../components/ProductCombobox';
import { ErrorState } from '../components/ErrorState';

interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface InventoryRow {
  /** D1 — whether the item is assigned to this warehouse (false = it still holds stock here but is not assigned). */
  assigned: boolean;
  productId: string;
  sku: string;
  name: string;
  unit: string | null;
  status: string;
  onHand: number;
  preliminaryHold: number;
  reserved: number;
  available: number;
  lastMovementAt: string | null;
}
interface InventoryPage {
  rows: InventoryRow[];
  total: number;
}

const PAGE_SIZE = 50;
const SORTABLE_COLUMNS = ['sku', 'name', 'onHand', 'reserved', 'available', 'status', 'lastMovementAt'] as const;
type SortColumn = (typeof SORTABLE_COLUMNS)[number];

/**
 * Warehouse & Inventory Control UX rebuild (CTO decision: keep the
 * existing domain, rebuild the operational UX) — the Inventory Grid
 * (§5/§6): server-side search/sort/pagination, scoped to one selected
 * warehouse at a time (never a client-side dump of every inventory row —
 * the directive's explicit performance requirement).
 */
export function Inventory() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<SortColumn>('sku');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [data, setData] = useState<InventoryPage | null>(null);
  // D1 — default: this warehouse's assigned items (plus any item still holding stock); 'all' = the whole catalogue
  const [scope, setScope] = useState<'assigned' | 'all'>('assigned');
  const [assignSearch, setAssignSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload([
    'nav.inventory',
    'field.warehouse',
    'field.code',
    'field.name',
    'field.unit',
    'field.on_hand',
    'field.preliminary_hold',
    'field.reserved',
    'field.available',
    'field.status',
    'field.last_movement',
    'field.item_scope',
    'value.item_scope.assigned',
    'value.item_scope.all',
    'field.assigned',
    'value.assigned.yes',
    'value.assigned.no',
    'panel.assign_item_to_warehouse',
    'action.remove_from_warehouse',
    'field.search_product_placeholder',
    'panel.no_matching_products',
    'panel.no_inventory_rows',
    'panel.opening_stock_import',
    'action.export_excel',
    'action.previous_page',
    'action.next_page',
    'field.page_of_total',
    'action.download_template',
    'action.import_excel',
    'field.total_rows',
    'field.succeeded_rows',
    'field.rejected_rows',
    'field.row',
    'field.errors',
    'action.open_item_details',
  ]);

  useEffect(() => {
    (async () => {
      try {
        const [wh, prod] = await Promise.all([api.get<Warehouse[]>('/inventory/warehouses'), api.get<ProductOption[]>('/products/all')]);
        setWarehouses(wh);
        setProducts(prod);
        const fromUrl = searchParams.get('warehouseId');
        if (fromUrl && wh.some((w) => w.id === fromUrl)) setWarehouseId(fromUrl);
        else if (wh[0]) setWarehouseId(wh[0].id);
      } catch (err) {
        // Foundation fix: no warehouse ever gets selected on failure, so
        // the grid silently never loads — surface it as a real Error state.
        setLoadError(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search (directive §19 — no query fired on every keystroke).
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, warehouseId, scope]);

  async function load() {
    if (!warehouseId) return;
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sortBy,
        sortDir,
        scope,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      const result = await api.get<InventoryPage>(`/inventory/warehouses/${warehouseId}/inventory?${params.toString()}`);
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load inventory.');
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, debouncedSearch, page, sortBy, sortDir, scope]);

  async function assignItem(productId: string) {
    if (!warehouseId) return;
    setError(null);
    setNotice(null);
    try {
      await api.post(`/inventory/warehouses/${warehouseId}/items`, { productIds: [productId] });
      setAssignSearch('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign the item.');
    }
  }

  async function removeItem(productId: string) {
    if (!warehouseId) return;
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/inventory/warehouses/${warehouseId}/items/${productId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove the item.');
    }
  }

  function onSelectWarehouse(id: string) {
    setWarehouseId(id);
    setSearchParams(id ? { warehouseId: id } : {});
  }

  function toggleSort(col: SortColumn) {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  }

  // The originating warehouse travels with the item link so its page can return here.
  const itemHref = (productId: string) => `/inventory/items/${productId}${warehouseId ? `?warehouseId=${warehouseId}` : ''}`;

  const totalPages = useMemo(() => (data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1), [data]);

  function sortIndicator(col: SortColumn) {
    if (sortBy !== col) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  if (loadError) {
    return (
      <div>
        <div className="page-header">
          <h1>{t('nav.inventory')}</h1>
        </div>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.inventory')}</h1>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.warehouse')}</label>
            <select value={warehouseId} onChange={(e) => onSelectWarehouse(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field" style={{ marginBottom: 0 }}>
            <label>{t('field.item_scope')}</label>
            <select value={scope} onChange={(e) => setScope(e.target.value as 'assigned' | 'all')}>
              <option value="assigned">{t('value.item_scope.assigned')}</option>
              <option value="all">{t('value.item_scope.all')}</option>
            </select>
          </div>
          {can('inventory.warehouse.edit', 'editable') && warehouseId && (
            <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
              <label>{t('panel.assign_item_to_warehouse')}</label>
              <ProductCombobox
                products={products}
                value={assignSearch}
                onValueChange={setAssignSearch}
                onSelect={(p) => assignItem(p.id)}
                placeholder={t('field.search_product_placeholder')}
                clearOnSelect
              />
            </div>
          )}
          <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
            <label>{t('field.search_product_placeholder')}</label>
            <ProductCombobox
              products={products}
              value={search}
              onValueChange={setSearch}
              onSelect={(p) => setSearch(p.name)}
              placeholder={t('field.search_product_placeholder')}
            />
          </div>
          {warehouseId && (
            <a
              className="btn btn-secondary"
              href={`/api/inventory/reports/stock/export?warehouseId=${warehouseId}`}
              target="_blank"
              rel="noreferrer"
            >
              {t('action.export_excel')}
            </a>
          )}
        </div>
      </div>

      {can('inventory.movement.create', 'editable') && (
        <div style={{ marginBottom: 20 }}>
          <h3>{t('panel.opening_stock_import')}</h3>
          <ExcelImportExport
            templateUrl="/api/inventory/opening-stock/import-template"
            importUrl="/api/inventory/opening-stock/import"
            onImported={load}
          />
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      {notice && <div style={{ color: '#166534', marginBottom: 8 }}>{notice}</div>}

      {data === null ? (
        <div className="empty-state">Loading…</div>
      ) : data.rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_inventory_rows')}</div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('sku')}>
                    {t('field.code')}
                    {sortIndicator('sku')}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('name')}>
                    {t('field.name')}
                    {sortIndicator('name')}
                  </th>
                  <th>{t('field.unit')}</th>
                  <th>{t('field.assigned')}</th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('onHand')}>
                    {t('field.on_hand')}
                    {sortIndicator('onHand')}
                  </th>
                  <th>{t('field.preliminary_hold')}</th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('reserved')}>
                    {t('field.reserved')}
                    {sortIndicator('reserved')}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('available')}>
                    {t('field.available')}
                    {sortIndicator('available')}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('status')}>
                    {t('field.status')}
                    {sortIndicator('status')}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('lastMovementAt')}>
                    {t('field.last_movement')}
                    {sortIndicator('lastMovementAt')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  // Item Details click-through: the whole row opens the item; SKU and name are real links (keyboard / new tab).
                  <tr key={r.productId} className="clickable-row" onClick={() => navigate(itemHref(r.productId))}>
                    <td>
                      <Link to={itemHref(r.productId)} onClick={(e) => e.stopPropagation()} title={t('action.open_item_details')}>
                        {r.sku}
                      </Link>
                    </td>
                    <td>
                      <Link to={itemHref(r.productId)} onClick={(e) => e.stopPropagation()} title={t('action.open_item_details')}>
                        {r.name}
                      </Link>
                    </td>
                    <td>{r.unit ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.assigned ? (
                        <>
                          <span style={{ color: '#166534' }}>{t('value.assigned.yes')}</span>
                          {can('inventory.warehouse.edit', 'editable') && (
                            <button
                              className="btn btn-secondary"
                              style={{ marginInlineStart: 8 }}
                              title={t('action.remove_from_warehouse')}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeItem(r.productId);
                              }}
                            >
                              ×
                            </button>
                          )}
                        </>
                      ) : (
                        // 'has stock (not default)' only when it really holds stock here — an unassigned zero-stock row (All items scope) is just not assigned
                        r.onHand !== 0 ? <span style={{ color: '#b45309' }}>{t('value.assigned.no')}</span> : <span>—</span>
                      )}
                    </td>
                    <td>{r.onHand}</td>
                    <td>{r.preliminaryHold}</td>
                    <td>{r.reserved}</td>
                    <td style={{ color: r.available < 0 ? '#a3262d' : undefined, fontWeight: r.available < 0 ? 600 : undefined }}>
                      {r.available}
                    </td>
                    <td>
                      <StatusBadge code={`product_status.${r.status}`} />
                    </td>
                    <td>{r.lastMovementAt ? new Date(r.lastMovementAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="action-row" style={{ marginTop: 14, alignItems: 'center' }}>
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('action.previous_page')}
            </button>
            <span style={{ fontSize: '0.85rem', color: '#6b7280' }}>
              {t('field.page_of_total').replace('{page}', String(page)).replace('{total}', String(totalPages))}
            </span>
            <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              {t('action.next_page')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
