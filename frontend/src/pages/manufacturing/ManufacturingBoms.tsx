import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { loadingLabel } from '../../lib/displayNames';

interface BomListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
  status: 'active' | 'inactive';
  componentCount: number;
}
interface BomComponentView {
  componentProductId: string;
  sku: string;
  productName: string;
  unit: string | null;
  quantityPerUnit: number;
}
interface BomView {
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  status: 'active' | 'inactive';
  components: BomComponentView[];
}
interface Product {
  id: string;
  sku: string;
  name: string;
  unit?: string | null;
}
interface DraftLine {
  componentProductId: string;
  quantityPerUnit: number;
}

type Mode = { kind: 'none' } | { kind: 'view'; productId: string } | { kind: 'edit'; productId: string; isNew: boolean };

/**
 * ADR-061 Addendum 1 (A2) — Bills of Materials / Recipes inside the Manufacturing workspace
 * (list · create · edit · view · activate/deactivate · delete). One BOM per product, unversioned.
 * Authority is the API (`manufacturing.bom.*`); a denied action surfaces the server's message.
 */
export function ManufacturingBoms() {
  const { t, preload } = useLanguage();
  const [boms, setBoms] = useState<BomListEntry[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [detail, setDetail] = useState<BomView | null>(null);
  const [draft, setDraft] = useState<DraftLine[]>([{ componentProductId: '', quantityPerUnit: 1 }]);
  const [newProductId, setNewProductId] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  preload([
    'nav.manufacturing_boms',
    'field.sku',
    'field.name',
    'field.status',
    'field.finished_product',
    'field.component',
    'field.quantity_per_unit',
    'field.actions',
    'action.save',
    'action.add_component',
    'mfg.field.unit',
    'mfg.field.component_count',
    'mfg.status.active',
    'mfg.status.inactive',
    'mfg.action.new_bom',
    'mfg.action.view',
    'mfg.action.edit',
    'mfg.action.activate',
    'mfg.action.deactivate',
    'mfg.action.delete',
    'mfg.action.close',
    'mfg.panel.no_boms',
    'mfg.panel.bom_hint',
  ]);

  async function load() {
    try {
      const [list, prods] = await Promise.all([api.get<BomListEntry[]>('/manufacturing/boms'), api.get<Product[]>('/products/all')]);
      setBoms(list);
      setProducts(prods);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Bills of Materials.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(productId: string): Promise<BomView | null> {
    try {
      const data = await api.get<BomView>(`/manufacturing/boms/${productId}`);
      setDetail(data);
      return data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Bill of Materials.');
      return null;
    }
  }

  async function openView(productId: string) {
    setError(null);
    setDetail(null);
    setMode({ kind: 'view', productId });
    await loadDetail(productId);
  }

  async function openEdit(productId: string) {
    setError(null);
    setDetail(null);
    const data = await loadDetail(productId);
    if (!data) return;
    setDraft(data.components.map((c) => ({ componentProductId: c.componentProductId, quantityPerUnit: c.quantityPerUnit })));
    setMode({ kind: 'edit', productId, isNew: false });
  }

  function startNew() {
    if (!newProductId) return;
    setError(null);
    setDetail(null);
    setDraft([{ componentProductId: '', quantityPerUnit: 1 }]);
    setMode({ kind: 'edit', productId: newProductId, isNew: true });
    setNewProductId('');
  }

  async function save() {
    if (mode.kind !== 'edit') return;
    const components = draft.filter((l) => l.componentProductId && l.quantityPerUnit > 0);
    if (components.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(mode.isNew ? `/manufacturing/boms/${mode.productId}` : `/manufacturing/boms/${mode.productId}/replace`, { components });
      await load();
      await openView(mode.productId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Bill of Materials.');
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(productId: string, status: 'active' | 'inactive') {
    setError(null);
    try {
      await api.post(`/manufacturing/boms/${productId}/status`, { status });
      await load();
      if (mode.kind === 'view' && mode.productId === productId) await loadDetail(productId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change status.');
    }
  }

  async function remove(productId: string) {
    setError(null);
    try {
      await api.delete(`/manufacturing/boms/${productId}`);
      setMode({ kind: 'none' });
      setDetail(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove Bill of Materials.');
    }
  }

  const product = (id: string) => products.find((p) => p.id === id);
  const q = search.trim().toLowerCase();
  const filtered = boms?.filter((b) => !q || b.sku.toLowerCase().includes(q) || b.name.toLowerCase().includes(q));
  const bomProductIds = new Set((boms ?? []).map((b) => b.finishedProductId));

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_boms')}</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('mfg.panel.bom_hint')}
      </p>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>{t('field.finished_product')}</label>
          <select value={newProductId} onChange={(e) => setNewProductId(e.target.value)}>
            <option value="">—</option>
            {products
              .filter((p) => !bomProductIds.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
          </select>
        </div>
        <button className="btn btn-primary" type="button" disabled={!newProductId} onClick={startNew}>
          {t('mfg.action.new_bom')}
        </button>
        <input placeholder={`${t('field.sku')} / ${t('field.name')}`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 220, marginInlineStart: 'auto' }} />
      </div>

      {error && <div className="error-text">{error}</div>}

      {mode.kind === 'edit' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>
            {product(mode.productId)?.sku} — {product(mode.productId)?.name}
          </h3>
          {draft.map((line, i) => {
            const comp = product(line.componentProductId);
            return (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 10 }}>
                <div className="form-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label>{t('field.component')}</label>
                  <select value={line.componentProductId} onChange={(e) => setDraft((prev) => prev.map((l, idx) => (idx === i ? { ...l, componentProductId: e.target.value } : l)))}>
                    <option value="">—</option>
                    {products
                      .filter((p) => p.id !== mode.productId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="form-field" style={{ width: 120, marginBottom: 0 }}>
                  <label>{t('field.quantity_per_unit')}</label>
                  <input type="number" min={1} step={1} value={line.quantityPerUnit} onChange={(e) => setDraft((prev) => prev.map((l, idx) => (idx === i ? { ...l, quantityPerUnit: Number(e.target.value) } : l)))} />
                </div>
                <div style={{ width: 70 }} className="muted">
                  {comp?.unit ?? ''}
                </div>
                {draft.length > 1 && (
                  <button className="btn btn-secondary" type="button" onClick={() => setDraft((prev) => prev.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" type="button" onClick={() => setDraft((prev) => [...prev, { componentProductId: '', quantityPerUnit: 1 }])}>
              + {t('action.add_component')}
            </button>
            <button className="btn btn-primary" type="button" disabled={saving} onClick={save}>
              {t('action.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setMode({ kind: 'none' })}>
              {t('mfg.action.close')}
            </button>
          </div>
        </div>
      )}

      {mode.kind === 'view' && (
        <div className="card" style={{ marginBottom: 20 }}>
          {detail ? (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>
                  {detail.finishedProductSku} — {detail.finishedProductName}
                </h3>
                <StatusBadge code={`mfg.status.${detail.status}`} />
                <button className="btn btn-secondary" type="button" style={{ marginInlineStart: 'auto' }} onClick={() => setMode({ kind: 'none' })}>
                  {t('mfg.action.close')}
                </button>
              </div>
              <table className="data-table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>{t('field.sku')}</th>
                    <th>{t('field.component')}</th>
                    <th>{t('field.quantity_per_unit')}</th>
                    <th>{t('mfg.field.unit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.components.map((c) => (
                    <tr key={c.componentProductId}>
                      <td>{c.sku}</td>
                      <td>{c.productName}</td>
                      <td>{c.quantityPerUnit}</td>
                      <td>{c.unit ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="empty-state">{loadingLabel()}</div>
          )}
        </div>
      )}

      {boms === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : filtered && filtered.length === 0 ? (
        <div className="empty-state">{t('mfg.panel.no_boms')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.sku')}</th>
              <th>{t('field.finished_product')}</th>
              <th>{t('mfg.field.component_count')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((b) => (
              <tr key={b.finishedProductId}>
                <td>{b.sku}</td>
                <td>{b.name}</td>
                <td>{b.componentCount}</td>
                <td>
                  <StatusBadge code={`mfg.status.${b.status}`} />
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" type="button" onClick={() => openView(b.finishedProductId)}>
                    {t('mfg.action.view')}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => openEdit(b.finishedProductId)}>
                    {t('mfg.action.edit')}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => setStatus(b.finishedProductId, b.status === 'active' ? 'inactive' : 'active')}>
                    {b.status === 'active' ? t('mfg.action.deactivate') : t('mfg.action.activate')}
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => remove(b.finishedProductId)}>
                    {t('mfg.action.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
