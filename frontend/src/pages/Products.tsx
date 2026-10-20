import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { ExcelImportExport } from '../components/ExcelImportExport';
import { loadingLabel } from '../lib/displayNames';
import { useDefaultCode } from '../lib/useDefaultCode';
import { CodeField } from '../components/CodeField';

interface Product {
  id: string;
  sku: string;
  name: string;
  unitPrice: string;
  unit: string | null;
  status: 'draft' | 'active' | 'discontinued';
}

const NEXT_STATUS: Record<string, { action: string; to: string } | null> = {
  draft: { action: 'activate', to: 'active' },
  active: { action: 'discontinue', to: 'discontinued' },
  discontinued: { action: 'reactivate', to: 'active' },
};

export function Products() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  const [products, setProducts] = useState<Product[] | null>(null);
  // Owner request 2026-10-20: the item code starts as the next automatic serial (PRD-000001 …), editable; a duplicate is refused by the server.
  const code = useDefaultCode('/products/next-code', can('sales.catalog.create', 'editable'));
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [unit, setUnit] = useState('');
  const [creating, setCreating] = useState(false);
  // D1 — the item's initial / default (origin) warehouse; optional. It does NOT restrict the item to it: stock location is the movements.
  const [warehouses, setWarehouses] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editUnit, setEditUnit] = useState('');
  // D1 — the item's default/origin warehouses (warehouse_items markers), shown as a column and editable with the item.
  const [assignments, setAssignments] = useState<Map<string, string[]>>(new Map());
  const [editWarehouseIds, setEditWarehouseIds] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  preload([
    'nav.products',
    'field.sku',
    'field.name',
    'field.unit_price',
    'field.unit',
    'field.default_warehouse',
    'field.warehouse',
    'field.status',
    'field.actions',
    'action.create',
    'action.activate',
    'action.discontinue',
    'action.edit',
    'action.save',
    'action.cancel',
    'panel.no_products_yet',
    'action.download_template',
    'action.export_excel',
    'action.import_excel',
    'field.total_rows',
    'field.succeeded_rows',
    'field.rejected_rows',
    'field.row',
    'field.errors',
  ]);

  async function load() {
    try {
      const data = await api.get<Product[]>('/products/all');
      setProducts(data);
      await loadAssignments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load products.');
    }
  }

  async function loadAssignments() {
    try {
      const rows = await api.get<Array<{ warehouseId: string; productId: string }>>('/inventory/warehouse-items');
      const map = new Map<string, string[]>();
      for (const r of rows) map.set(r.productId, [...(map.get(r.productId) ?? []), r.warehouseId]);
      setAssignments(map);
    } catch {
      setAssignments(new Map()); // optional column — the catalogue still works without warehouse access
    }
  }

  const warehouseLabel = (id: string) => {
    const w = warehouses.find((x) => x.id === id);
    return w ? `${w.code} — ${w.name}` : null;
  };
  const canEditWarehouses = can('inventory.warehouse.edit', 'editable') && warehouses.length > 0;

  useEffect(() => {
    load();
    api
      .get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses')
      .then(setWarehouses)
      .catch(() => undefined); // optional field — the form works without it
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/products', { sku: code.payloadCode(), name, unitPrice, unit: unit || undefined });
      if (defaultWarehouseId && created?.id) {
        try {
          await api.post(`/inventory/warehouses/${defaultWarehouseId}/items`, { productIds: [created.id] });
        } catch (err) {
          setError(`${err instanceof ApiError ? err.message : 'Could not set the default warehouse.'} (the item itself was created)`);
        }
      }
      setDefaultWarehouseId('');
      void code.reset();
      setName('');
      setUnitPrice('');
      setUnit('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create product.');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(product: Product) {
    setEditingId(product.id);
    setEditName(product.name);
    setEditPrice(product.unitPrice);
    setEditUnit(product.unit ?? '');
    setEditWarehouseIds(assignments.get(product.id) ?? []);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(product: Product) {
    setSavingEdit(true);
    setError(null);
    try {
      if (editName !== product.name) {
        await api.post(`/products/${product.id}/name`, { name: editName });
      }
      if (editPrice !== product.unitPrice) {
        await api.post(`/products/${product.id}/price`, { unitPrice: editPrice });
      }
      if (editUnit !== (product.unit ?? '')) {
        await api.post(`/products/${product.id}/unit`, { unit: editUnit });
      }
      if (canEditWarehouses) {
        const before = assignments.get(product.id) ?? [];
        for (const id of editWarehouseIds.filter((w) => !before.includes(w))) {
          await api.post(`/inventory/warehouses/${id}/items`, { productIds: [product.id] });
        }
        for (const id of before.filter((w) => !editWarehouseIds.includes(w))) {
          await api.delete(`/inventory/warehouses/${id}/items/${product.id}`);
        }
      }
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update product.');
    } finally {
      setSavingEdit(false);
    }
  }

  async function advanceStatus(product: Product) {
    const next = NEXT_STATUS[product.status];
    if (!next) return;
    setBusyId(product.id);
    setError(null);
    try {
      await api.post(`/products/${product.id}/status`, { status: next.to });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change product status.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.products')}</h1>
        <button className="btn btn-secondary" onClick={() => window.open('/print/products', '_blank')}>
          {t('document.product_catalog_title')}
        </button>
      </div>

      {can('sales.catalog.create', 'editable') && (
        <ExcelImportExport
          templateUrl="/api/products/import-template"
          exportUrl="/api/products/export"
          importUrl="/api/products/import"
          onImported={load}
        />
      )}

      {can('sales.catalog.create', 'editable') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <CodeField label={t('field.sku')} value={code.value} onChange={code.setValue} defaultCode={code.defaultCode} isCustom={code.isCustom} onUseDefault={code.restoreDefault} />
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.unit_price')}</label>
              <input value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.00" required />
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.unit')}</label>
              <input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </div>
            {warehouses.length > 0 && (
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.default_warehouse')}</label>
                <select value={defaultWarehouseId} onChange={(e) => setDefaultWarehouseId(e.target.value)}>
                  <option value="">—</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.create')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      {products === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : products.length === 0 ? (
        <div className="empty-state">{t('panel.no_products_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.sku')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.unit_price')}</th>
              <th>{t('field.unit')}</th>
              <th>{t('field.warehouse')}</th>
              <th>{t('field.status')}</th>
              {can('sales.catalog.edit', 'editable') && <th>{t('field.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const next = NEXT_STATUS[p.status];
              const isEditing = editingId === p.id;
              return (
                <tr
                  key={p.id}
                  // Owner request 2026-10-20: a product row opens the item card (the page set up in the warehouse). Buttons, links and inputs inside the row keep their own behaviour.
                  onClick={(e) => {
                    if (isEditing || (e.target as HTMLElement).closest('button, a, input, select, label')) return;
                    navigate(`/inventory/items/${p.id}`);
                  }}
                  style={isEditing ? undefined : { cursor: 'pointer' }}
                >
                  <td>{isEditing ? p.sku : <Link to={`/inventory/items/${p.id}`}>{p.sku}</Link>}</td>
                  <td>{isEditing ? <input value={editName} onChange={(e) => setEditName(e.target.value)} /> : <Link to={`/inventory/items/${p.id}`}>{p.name}</Link>}</td>
                  <td>
                    {isEditing ? (
                      <input type="number" min={0} step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
                    ) : (
                      p.unitPrice
                    )}
                  </td>
                  <td>{isEditing ? <input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} /> : (p.unit ?? '—')}</td>
                  <td>
                    {isEditing && canEditWarehouses ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {warehouses.map((w) => (
                          <label key={w.id} style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                            <input
                              type="checkbox"
                              checked={editWarehouseIds.includes(w.id)}
                              onChange={(e) =>
                                setEditWarehouseIds((prev) => (e.target.checked ? [...prev, w.id] : prev.filter((x) => x !== w.id)))
                              }
                            />
                            {w.code} — {w.name}
                          </label>
                        ))}
                      </div>
                    ) : (
                      (assignments.get(p.id) ?? []).map(warehouseLabel).filter(Boolean).join('، ') || '—'
                    )}
                  </td>
                  <td>
                    <StatusBadge code={`product_status.${p.status}`} />
                  </td>
                  {can('sales.catalog.edit', 'editable') && (
                    <td style={{ display: 'flex', gap: 6 }}>
                      {isEditing ? (
                        <>
                          <button className="btn btn-primary" disabled={savingEdit} onClick={() => saveEdit(p)}>
                            {savingEdit ? '...' : t('action.save')}
                          </button>
                          <button className="btn btn-secondary" disabled={savingEdit} onClick={cancelEdit}>
                            {t('action.cancel')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-secondary" onClick={() => startEdit(p)}>
                            {t('action.edit')}
                          </button>
                          {next && (
                            <button className="btn btn-secondary" disabled={busyId === p.id} onClick={() => advanceStatus(p)}>
                              {t(`action.${next.action}`)}
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
