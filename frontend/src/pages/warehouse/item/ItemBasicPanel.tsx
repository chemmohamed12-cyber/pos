import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../../lib/api';
import { useLanguage } from '../../../context/LanguageContext';
import { StatusBadge } from '../../../components/StatusBadge';
import { ITEM_TYPES, type AssignedWarehouse, type Category, type ItemMasterProduct } from './itemMaster';




function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-field">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

/**
 * Master data step 1 — the item's basic information, view + edit. Each field is written through the API that owns it:
 * name / unit → the existing catalog routes; type / category / reorder level / description → `POST /products/:id/update`;
 * the primary default warehouse → the Inventory domain (`POST /inventory/items/:id/default-warehouse`), which only accepts an
 * active warehouse the item is assigned to. The server is the authority for every rule; the form only mirrors them.
 */
export function ItemBasicPanel(props: {
  product: ItemMasterProduct;
  categories: Category[];
  assigned: AssignedWarehouse[] | null;
  canEditCatalog: boolean;
  canEditWarehouse: boolean;
  onSaved: () => Promise<void>;
  onCategoriesChanged: () => Promise<void>;
}) {
  const { product, categories, assigned, canEditCatalog, canEditWarehouse } = props;
  const { t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(() => toForm(product));
  const [newCategory, setNewCategory] = useState<{ code: string; name: string } | null>(null);

  function toForm(p: ItemMasterProduct) {
    return {
      name: p.name,
      unit: p.unit ?? '',
      itemType: p.itemType,
      categoryId: p.categoryId ?? '',
      defaultWarehouseId: p.defaultWarehouseId ?? '',
      reorderLevel: p.reorderLevel === null ? '' : String(Number(p.reorderLevel)),
      description: p.description ?? '',
    };
  }

  const categoryLabel = (id: string | null) => {
    const c = categories.find((x) => x.id === id);
    return c ? `${c.code} — ${c.name}` : '—';
  };
  const warehouseLabel = (id: string | null) => {
    if (!id) return '—';
    const w = assigned?.find((x) => x.id === id);
    return w ? `${w.code} — ${w.name}` : id.slice(0, 8);
  };

  function startEdit() {
    setForm(toForm(product));
    setError(null);
    setNotice(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (canEditCatalog) {
        if (form.name.trim() !== product.name) await api.post(`/products/${product.id}/name`, { name: form.name.trim() });
        if (form.unit.trim() !== (product.unit ?? '')) await api.post(`/products/${product.id}/unit`, { unit: form.unit.trim() });
        const master: Record<string, unknown> = {};
        if (form.itemType !== product.itemType) master.itemType = form.itemType;
        if ((form.categoryId || null) !== product.categoryId) master.categoryId = form.categoryId || null;
        const currentReorder = product.reorderLevel === null ? '' : String(Number(product.reorderLevel));
        if (form.reorderLevel.trim() !== currentReorder) master.reorderLevel = form.reorderLevel.trim() === '' ? null : form.reorderLevel.trim();
        if (form.description.trim() !== (product.description ?? '')) master.description = form.description.trim() || null;
        if (Object.keys(master).length) await api.post(`/products/${product.id}/update`, master);
      }
      if (canEditWarehouse && (form.defaultWarehouseId || null) !== product.defaultWarehouseId) {
        await api.post(`/inventory/items/${product.id}/default-warehouse`, { warehouseId: form.defaultWarehouseId || null });
      }
      await props.onSaved();
      setEditing(false);
      setNotice(t('panel.item_saved'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the item.');
      await props.onSaved(); // show what WAS saved before the failing step
    } finally {
      setSaving(false);
    }
  }

  async function createCategory() {
    if (!newCategory) return;
    setError(null);
    try {
      const created = await api.post<Category>('/product-categories', { code: newCategory.code.trim(), name: newCategory.name.trim() });
      await props.onCategoriesChanged();
      setForm((f) => ({ ...f, categoryId: created.id }));
      setNewCategory(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the category.');
    }
  }

  const notInModel = <span className="item-not-in-model">{t('panel.not_in_data_model')}</span>;

  if (!editing) {
    return (
      <>
        {(canEditCatalog || canEditWarehouse) && (
          <div className="action-row" style={{ marginBottom: 12 }}>
            <button className="btn btn-primary" onClick={startEdit} data-testid="item-edit">
              {t('action.edit')}
            </button>
          </div>
        )}
        {notice && <div className="item-reconciled" style={{ marginBottom: 8 }}>{notice}</div>}
        <div className="detail-grid">
          <Field label={t('field.code')} value={product.sku} />
          <Field label={t('field.name')} value={product.name} />
          <Field label={t('field.status')} value={<StatusBadge code={`product_status.${product.status}`} />} />
          <Field label={t('field.item_type')} value={t(`value.item_type.${product.itemType}`)} />
          <Field label={t('field.item_category')} value={categoryLabel(product.categoryId)} />
          <Field label={t('field.base_unit')} value={product.unit ?? '—'} />
          <Field label={t('field.primary_default_warehouse')} value={warehouseLabel(product.defaultWarehouseId)} />
          <Field label={t('field.assigned_warehouses')} value={assigned ? assigned.map((w) => w.code).join('، ') || '—' : '…'} />
          <Field label={t('field.reorder_level')} value={product.reorderLevel === null ? '—' : String(Number(product.reorderLevel))} />
          <Field label={t('field.item_image')} value={notInModel} />
        </div>
        <Field label={t('field.item_description')} value={<span style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{product.description || '—'}</span>} />
      </>
    );
  }

  return (
    <form
      className="item-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {error && <div className="error-text">{error}</div>}
      <div className="item-form-grid">
        <div className="form-field">
          <label>{t('field.code')}</label>
          <input value={product.sku} disabled />
        </div>
        <div className="form-field">
          <label>{t('field.name')}</label>
          <input value={form.name} disabled={!canEditCatalog} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="form-field">
          <label>{t('field.item_type')}</label>
          <select value={form.itemType} disabled={!canEditCatalog} onChange={(e) => setForm({ ...form, itemType: e.target.value })}>
            {ITEM_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`value.item_type.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>{t('field.item_category')}</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select style={{ flex: 1 }} value={form.categoryId} disabled={!canEditCatalog} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">—</option>
              {categories
                .filter((c) => c.status === 'active' || c.id === product.categoryId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
            </select>
            {canEditCatalog && (
              <button type="button" className="btn btn-secondary" onClick={() => setNewCategory(newCategory ? null : { code: '', name: '' })}>
                {t('action.new_category')}
              </button>
            )}
          </div>
          {newCategory && (
            <div className="item-inline-create">
              <input placeholder={t('field.category_code')} value={newCategory.code} maxLength={32} onChange={(e) => setNewCategory({ ...newCategory, code: e.target.value })} />
              <input placeholder={t('field.category_name')} value={newCategory.name} maxLength={120} onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })} />
              <button type="button" className="btn btn-primary" disabled={!newCategory.code.trim() || !newCategory.name.trim()} onClick={() => void createCategory()}>
                {t('action.save')}
              </button>
            </div>
          )}
        </div>
        <div className="form-field">
          <label>{t('field.base_unit')}</label>
          <input value={form.unit} maxLength={32} disabled={!canEditCatalog} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </div>
        <div className="form-field">
          <label>{t('field.primary_default_warehouse')}</label>
          <select value={form.defaultWarehouseId} disabled={!canEditWarehouse} onChange={(e) => setForm({ ...form, defaultWarehouseId: e.target.value })}>
            <option value="">—</option>
            {(assigned ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
          <small className="item-note">{t('panel.item_default_warehouse_hint')}</small>
        </div>
        <div className="form-field">
          <label>{t('field.reorder_level')}</label>
          <input inputMode="decimal" value={form.reorderLevel} disabled={!canEditCatalog} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
          <small className="item-note">{t('panel.item_reorder_hint')}</small>
        </div>
      </div>
      <div className="form-field">
        <label>{t('field.item_description')}</label>
        <textarea rows={3} maxLength={2000} value={form.description} disabled={!canEditCatalog} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="action-row">
        <button type="submit" className="btn btn-primary" disabled={saving} data-testid="item-save">
          {t('action.save')}
        </button>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setEditing(false)}>
          {t('action.cancel')}
        </button>
      </div>
    </form>
  );
}
