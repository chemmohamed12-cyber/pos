import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { ExcelImportExport } from '../components/ExcelImportExport';

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
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [unit, setUnit] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  preload([
    'nav.products',
    'field.sku',
    'field.name',
    'field.unit_price',
    'field.unit',
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load products.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/products', { sku, name, unitPrice, unit: unit || undefined });
      setSku('');
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

      {hasRole('admin') && (
        <ExcelImportExport
          templateUrl="/api/products/import-template"
          exportUrl="/api/products/export"
          importUrl="/api/products/import"
          onImported={load}
        />
      )}

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.sku')}</label>
              <input value={sku} onChange={(e) => setSku(e.target.value)} required />
            </div>
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
            <button className="btn btn-primary" type="submit" disabled={creating}>
              {t('action.create')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      {products === null ? (
        <div className="empty-state">Loading…</div>
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
              <th>{t('field.status')}</th>
              {hasRole('admin') && <th>{t('field.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const next = NEXT_STATUS[p.status];
              const isEditing = editingId === p.id;
              return (
                <tr key={p.id}>
                  <td>{p.sku}</td>
                  <td>{isEditing ? <input value={editName} onChange={(e) => setEditName(e.target.value)} /> : p.name}</td>
                  <td>
                    {isEditing ? (
                      <input type="number" min={0} step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
                    ) : (
                      p.unitPrice
                    )}
                  </td>
                  <td>{isEditing ? <input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} /> : (p.unit ?? '—')}</td>
                  <td>
                    <StatusBadge code={`product_status.${p.status}`} />
                  </td>
                  {hasRole('admin') && (
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
