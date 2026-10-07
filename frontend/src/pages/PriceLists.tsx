import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { ExcelImportExport } from '../components/ExcelImportExport';

interface PriceList {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  role: 'main' | 'general' | null;
}
interface PriceListItem {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  price: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
  status: string;
}

const NEXT_STATUS: Record<string, { action: 'activate_price_list' | 'deactivate_price_list'; to: 'active' | 'inactive' }> = {
  active: { action: 'deactivate_price_list', to: 'inactive' },
  inactive: { action: 'activate_price_list', to: 'active' },
};

export function PriceLists() {
  const { can } = useAuth();
  const canManage = can('sales.price_list.edit', 'editable');
  const { t, preload } = useLanguage();
  const [priceLists, setPriceLists] = useState<PriceList[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [items, setItems] = useState<PriceListItem[] | null>(null);
  const [itemProductId, setItemProductId] = useState('');
  const [itemPrice, setItemPrice] = useState('');
  const [savingItem, setSavingItem] = useState(false);

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editItemPrice, setEditItemPrice] = useState('');
  const [savingEditItem, setSavingEditItem] = useState(false);

  preload([
    'nav.price_lists',
    'field.code',
    'field.name',
    'field.status',
    'field.actions',
    'field.price',
    'field.sku',
    'field.product',
    'action.create',
    'action.activate_price_list',
    'action.deactivate_price_list',
    'field.price_list_role',
    'price_list_role.main',
    'price_list_role.general',
    'action.set_main_price_list',
    'action.unset_main_price_list',
    'action.view_items',
    'action.add_item',
    'action.remove',
    'action.print',
    'action.edit',
    'action.save',
    'action.cancel',
    'panel.no_price_lists_yet',
    'panel.no_price_list_items_yet',
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
      const data = await api.get<PriceList[]>('/price-lists');
      setPriceLists(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load price lists.');
    }
  }

  useEffect(() => {
    load();
    api.get<Product[]>('/products/all').then(setProducts).catch(() => undefined);
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/price-lists', { name });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create price list.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(pl: PriceList) {
    const next = NEXT_STATUS[pl.status];
    setBusyId(pl.id);
    setError(null);
    try {
      await api.post(`/price-lists/${pl.id}/status`, { status: next.to });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change price list status.');
    } finally {
      setBusyId(null);
    }
  }

  // Post-v1.0.2 Hotfix 3 — marks/unmarks a list as the "Main" list
  // consulted when a customer has no price list of their own assigned.
  // Setting a different list as Main auto-clears whichever one previously
  // held it (server-enforced) — this button never needs to un-set another
  // list first. The General list is system-managed (auto-populated on
  // every product creation) and never offered here.
  async function toggleMain(pl: PriceList) {
    setBusyId(pl.id);
    setError(null);
    try {
      await api.post(`/price-lists/${pl.id}/role`, { role: pl.role === 'main' ? null : 'main' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change price list role.');
    } finally {
      setBusyId(null);
    }
  }

  async function loadItems(priceListId: string) {
    try {
      const data = await api.get<PriceListItem[]>(`/price-lists/${priceListId}/items`);
      setItems(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load price list items.');
    }
  }

  async function toggleExpand(pl: PriceList) {
    if (expandedId === pl.id) {
      setExpandedId(null);
      setItems(null);
      return;
    }
    setExpandedId(pl.id);
    setItems(null);
    await loadItems(pl.id);
  }

  async function onAddItem(e: FormEvent) {
    e.preventDefault();
    if (!expandedId || !itemProductId || !itemPrice) return;
    setSavingItem(true);
    setError(null);
    try {
      await api.post(`/price-lists/${expandedId}/items`, { productId: itemProductId, price: itemPrice });
      setItemProductId('');
      setItemPrice('');
      await loadItems(expandedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save item.');
    } finally {
      setSavingItem(false);
    }
  }

  function startEditItem(item: PriceListItem) {
    setEditingItemId(item.id);
    setEditItemPrice(item.price);
    setError(null);
  }

  function cancelEditItem() {
    setEditingItemId(null);
  }

  async function saveEditItem(item: PriceListItem) {
    if (!expandedId) return;
    setSavingEditItem(true);
    setError(null);
    try {
      await api.post(`/price-lists/${expandedId}/items`, { productId: item.productId, price: editItemPrice });
      setEditingItemId(null);
      await loadItems(expandedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update item price.');
    } finally {
      setSavingEditItem(false);
    }
  }

  async function removeItem(itemId: string) {
    if (!expandedId) return;
    setError(null);
    try {
      await api.delete(`/price-lists/${expandedId}/items/${itemId}`);
      await loadItems(expandedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove item.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.price_lists')}</h1>
      </div>

      {canManage && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.create')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      {priceLists === null ? (
        <div className="empty-state">Loading…</div>
      ) : priceLists.length === 0 ? (
        <div className="empty-state">{t('panel.no_price_lists_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.code')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.price_list_role')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {priceLists.map((pl) => (
              <Fragment key={pl.id}>
                <tr>
                  <td>{pl.code}</td>
                  <td>{pl.name}</td>
                  <td>
                    <StatusBadge code={`price_list_status.${pl.status}`} />
                  </td>
                  <td>{pl.role ? t(`price_list_role.${pl.role}`) : '—'}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary" onClick={() => toggleExpand(pl)}>
                      {t('action.view_items')}
                    </button>
                    {canManage && (
                      <button className="btn btn-secondary" disabled={busyId === pl.id} onClick={() => toggleStatus(pl)}>
                        {t(`action.${NEXT_STATUS[pl.status].action}`)}
                      </button>
                    )}
                    {canManage && pl.role !== 'general' && (
                      <button className="btn btn-secondary" disabled={busyId === pl.id} onClick={() => toggleMain(pl)}>
                        {t(pl.role === 'main' ? 'action.unset_main_price_list' : 'action.set_main_price_list')}
                      </button>
                    )}
                    <button className="btn btn-secondary" onClick={() => window.open(`/print/price-list/${pl.id}`, '_blank')}>
                      {t('action.print')}
                    </button>
                  </td>
                </tr>
                {expandedId === pl.id && (
                  <tr>
                    <td colSpan={5}>
                      <div className="card" style={{ margin: '8px 0' }}>
                        {canManage && (
                          <ExcelImportExport
                            templateUrl={`/api/price-lists/${pl.id}/items/import-template`}
                            exportUrl={`/api/price-lists/${pl.id}/items/export`}
                            importUrl={`/api/price-lists/${pl.id}/items/import`}
                            onImported={() => loadItems(pl.id)}
                          />
                        )}

                        {canManage && (
                          <form onSubmit={onAddItem} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
                            <div className="form-field" style={{ marginBottom: 0 }}>
                              <label>{t('field.product')}</label>
                              <select value={itemProductId} onChange={(e) => setItemProductId(e.target.value)} required>
                                <option value="" disabled>
                                  —
                                </option>
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.sku} — {p.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="form-field" style={{ width: 120, marginBottom: 0 }}>
                              <label>{t('field.price')}</label>
                              <input type="number" min={0} step="0.01" value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} required />
                            </div>
                            <button className="btn btn-primary" type="submit" disabled={savingItem}>
                              {t('action.add_item')}
                            </button>
                          </form>
                        )}

                        {items === null ? (
                          <div className="empty-state">Loading…</div>
                        ) : items.length === 0 ? (
                          <div className="empty-state">{t('panel.no_price_list_items_yet')}</div>
                        ) : (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>{t('field.sku')}</th>
                                <th>{t('field.product')}</th>
                                <th>{t('field.price')}</th>
                                {canManage && <th>{t('field.actions')}</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {items.map((it) => {
                                const isEditingItem = editingItemId === it.id;
                                return (
                                  <tr key={it.id}>
                                    <td>{it.sku}</td>
                                    <td>{it.productName}</td>
                                    <td>
                                      {isEditingItem ? (
                                        <input
                                          type="number"
                                          min={0}
                                          step="0.01"
                                          value={editItemPrice}
                                          onChange={(e) => setEditItemPrice(e.target.value)}
                                          style={{ width: 100 }}
                                        />
                                      ) : (
                                        it.price
                                      )}
                                    </td>
                                    {canManage && (
                                      <td style={{ display: 'flex', gap: 6 }}>
                                        {isEditingItem ? (
                                          <>
                                            <button className="btn btn-primary" disabled={savingEditItem} onClick={() => saveEditItem(it)}>
                                              {savingEditItem ? '...' : t('action.save')}
                                            </button>
                                            <button className="btn btn-secondary" disabled={savingEditItem} onClick={cancelEditItem}>
                                              {t('action.cancel')}
                                            </button>
                                          </>
                                        ) : (
                                          <>
                                            <button className="btn btn-secondary" onClick={() => startEditItem(it)}>
                                              {t('action.edit')}
                                            </button>
                                            <button className="btn btn-danger" onClick={() => removeItem(it.id)}>
                                              {t('action.remove')}
                                            </button>
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
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
