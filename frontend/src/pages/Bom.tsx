import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useVisibleRoutes } from '../lib/navVisibility';
import { loadingLabel } from '../lib/displayNames';

interface BomListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
}
interface BomComponentView {
  componentProductId: string;
  sku: string;
  productName: string;
  quantityPerUnit: number;
}
interface BomView {
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  components: BomComponentView[];
}
interface Product {
  id: string;
  sku: string;
  name: string;
  status: string;
}
interface DraftLine {
  componentProductId: string;
  quantityPerUnit: number;
}

export function Bom() {
  const { t, preload } = useLanguage();
  const visibleRoutes = useVisibleRoutes();
  const [boms, setBoms] = useState<BomListEntry[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BomView | null>(null);
  const [draft, setDraft] = useState<DraftLine[]>([{ componentProductId: '', quantityPerUnit: 1 }]);
  const [newFinishedProductId, setNewFinishedProductId] = useState('');
  const [saving, setSaving] = useState(false);

  preload([
    'nav.bom',
    'field.sku',
    'field.name',
    'field.finished_product',
    'field.component',
    'field.quantity_per_unit',
    'field.actions',
    'action.create',
    'action.save',
    'action.remove',
    'action.add_component',
    'action.define_bom',
    'action.view_items',
    'panel.no_boms_yet',
    'panel.no_bom_components_yet',
  ]);

  async function load() {
    try {
      const [list, prods] = await Promise.all([api.get<BomListEntry[]>('/bom'), api.get<Product[]>('/products/all')]);
      setBoms(list);
      setProducts(prods);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Bills of Materials.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(finishedProductId: string) {
    try {
      const data = await api.get<BomView>(`/bom/${finishedProductId}`);
      setDetail(data);
      setDraft(data.components.map((c) => ({ componentProductId: c.componentProductId, quantityPerUnit: c.quantityPerUnit })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Bill of Materials.');
    }
  }

  async function toggleExpand(finishedProductId: string) {
    if (expandedId === finishedProductId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(finishedProductId);
    setDetail(null);
    setDraft([{ componentProductId: '', quantityPerUnit: 1 }]);
    await loadDetail(finishedProductId);
  }

  function updateDraftLine(index: number, patch: Partial<DraftLine>) {
    setDraft((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function saveBom(finishedProductId: string) {
    const components = draft.filter((l) => l.componentProductId && l.quantityPerUnit > 0);
    if (components.length === 0 || !finishedProductId) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/bom/${finishedProductId}`, { components });
      await load();
      await loadDetail(finishedProductId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Bill of Materials.');
    } finally {
      setSaving(false);
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!newFinishedProductId) return;
    setExpandedId(newFinishedProductId);
    setDetail(null);
    setDraft([{ componentProductId: '', quantityPerUnit: 1 }]);
    setNewFinishedProductId('');
  }

  async function removeBom(finishedProductId: string) {
    setError(null);
    try {
      await api.delete(`/bom/${finishedProductId}`);
      setExpandedId(null);
      setDetail(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove Bill of Materials.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.bom')}</h1>
      </div>

      {/* NAV-06 — when Manufacturing is available to this user, its BOM screen is the canonical one; this screen stays for Sales-only Companies. */}
      {visibleRoutes?.has('/manufacturing/boms') && (
        <div className="card" style={{ marginBottom: 20 }} data-testid="bom-canonical-notice">
          {t('panel.bom_canonical_notice')} <Link to="/manufacturing/boms">{t('nav.manufacturing_boms')}</Link>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={onCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>{t('field.finished_product')}</label>
            <select value={newFinishedProductId} onChange={(e) => setNewFinishedProductId(e.target.value)} required>
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
          <button className="btn btn-primary" type="submit">
            {t('action.create')}
          </button>
        </form>
      </div>

      {error && <div className="error-text">{error}</div>}

      {boms === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : boms.length === 0 && expandedId === null ? (
        <div className="empty-state">{t('panel.no_boms_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.sku')}</th>
              <th>{t('field.name')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {[
              ...boms,
              ...(expandedId && !boms.some((b) => b.finishedProductId === expandedId)
                ? [
                    {
                      finishedProductId: expandedId,
                      sku: products.find((p) => p.id === expandedId)?.sku ?? expandedId,
                      name: products.find((p) => p.id === expandedId)?.name ?? expandedId,
                    },
                  ]
                : []),
            ].map((b) => (
              <Fragment key={b.finishedProductId}>
                <tr>
                  <td>{b.sku}</td>
                  <td>{b.name}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary" onClick={() => toggleExpand(b.finishedProductId)}>
                      {t('action.view_items')}
                    </button>
                    {boms.some((x) => x.finishedProductId === b.finishedProductId) && (
                      <button className="btn btn-danger" onClick={() => removeBom(b.finishedProductId)}>
                        {t('action.remove')}
                      </button>
                    )}
                  </td>
                </tr>
                {expandedId === b.finishedProductId && (
                  <tr>
                    <td colSpan={3}>
                      <div className="card" style={{ margin: '8px 0' }}>
                        {draft.map((line, i) => (
                          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 10 }}>
                            <div className="form-field" style={{ flex: 1, marginBottom: 0 }}>
                              <label>{t('field.component')}</label>
                              <select
                                value={line.componentProductId}
                                onChange={(e) => updateDraftLine(i, { componentProductId: e.target.value })}
                              >
                                <option value="" disabled>
                                  —
                                </option>
                                {products
                                  .filter((p) => p.id !== b.finishedProductId)
                                  .map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.sku} — {p.name}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div className="form-field" style={{ width: 120, marginBottom: 0 }}>
                              <label>{t('field.quantity_per_unit')}</label>
                              <input
                                type="number"
                                min={1}
                                value={line.quantityPerUnit}
                                onChange={(e) => updateDraftLine(i, { quantityPerUnit: Number(e.target.value) })}
                              />
                            </div>
                            {draft.length > 1 && (
                              <button className="btn btn-secondary" onClick={() => setDraft((prev) => prev.filter((_, idx) => idx !== i))}>
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 10 }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => setDraft((prev) => [...prev, { componentProductId: '', quantityPerUnit: 1 }])}
                          >
                            + {t('action.add_component')}
                          </button>
                          <button className="btn btn-primary" disabled={saving} onClick={() => saveBom(b.finishedProductId)}>
                            {t('action.define_bom')}
                          </button>
                        </div>
                        {detail && detail.components.length === 0 && (
                          <div className="empty-state" style={{ marginTop: 10 }}>
                            {t('panel.no_bom_components_yet')}
                          </div>
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
