import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { loadingLabel } from '../../lib/displayNames';

interface RoutingListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
  status: 'active' | 'inactive';
  operationCount: number;
}
interface RoutingOperationView {
  id: string;
  sequence: number;
  name: string;
  description: string | null;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
}
interface RoutingView {
  finishedProductId: string;
  finishedProductSku: string;
  finishedProductName: string;
  status: 'active' | 'inactive';
  operations: RoutingOperationView[];
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface WorkCenter {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
}
interface DraftOp {
  sequence: number;
  name: string;
  workCenterId: string;
}

type Mode = { kind: 'none' } | { kind: 'view'; productId: string } | { kind: 'edit'; productId: string; isNew: boolean };

/**
 * ADR-061 Addendum 1 (A1) — Routings / Operations: the ordered steps (each at a Work Center) for a finished
 * product. One routing per product; snapshotted onto a Work Order at release. Sequencing only — no hours/cost.
 */
export function Routings() {
  const { t, preload } = useLanguage();
  const [rows, setRows] = useState<RoutingListEntry[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [detail, setDetail] = useState<RoutingView | null>(null);
  const [draft, setDraft] = useState<DraftOp[]>([{ sequence: 10, name: '', workCenterId: '' }]);
  const [newProductId, setNewProductId] = useState('');
  const [saving, setSaving] = useState(false);

  preload([
    'nav.manufacturing_routings',
    'field.sku',
    'field.status',
    'field.finished_product',
    'field.actions',
    'action.save',
    'mfg.field.sequence',
    'mfg.field.operation',
    'mfg.field.work_center',
    'mfg.field.operations_count',
    'mfg.status.active',
    'mfg.status.inactive',
    'mfg.action.new_routing',
    'mfg.action.add_operation',
    'mfg.action.view',
    'mfg.action.edit',
    'mfg.action.activate',
    'mfg.action.deactivate',
    'mfg.action.delete',
    'mfg.action.close',
    'mfg.panel.no_routings',
    'mfg.panel.routing_hint',
  ]);

  async function load() {
    try {
      const [list, prods, wcs] = await Promise.all([
        api.get<RoutingListEntry[]>('/manufacturing/routings'),
        api.get<Product[]>('/products/all'),
        api.get<WorkCenter[]>('/manufacturing/work-centers'),
      ]);
      setRows(list);
      setProducts(prods);
      setWorkCenters(wcs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load routings.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(productId: string): Promise<RoutingView | null> {
    try {
      const data = await api.get<RoutingView>(`/manufacturing/routings/${productId}`);
      setDetail(data);
      return data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load routing.');
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
    const data = await loadDetail(productId);
    if (!data) return;
    setDraft(data.operations.map((o) => ({ sequence: o.sequence, name: o.name, workCenterId: o.workCenterId })));
    setMode({ kind: 'edit', productId, isNew: false });
  }

  function startNew() {
    if (!newProductId) return;
    setError(null);
    setDraft([{ sequence: 10, name: '', workCenterId: '' }]);
    setMode({ kind: 'edit', productId: newProductId, isNew: true });
    setNewProductId('');
  }

  async function save() {
    if (mode.kind !== 'edit') return;
    const operations = draft.filter((o) => o.name.trim() && o.workCenterId && o.sequence > 0);
    if (operations.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(mode.isNew ? `/manufacturing/routings/${mode.productId}` : `/manufacturing/routings/${mode.productId}/replace`, { operations });
      await load();
      await openView(mode.productId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save routing.');
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(productId: string, status: 'active' | 'inactive') {
    setError(null);
    try {
      await api.post(`/manufacturing/routings/${productId}/status`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change status.');
    }
  }

  async function remove(productId: string) {
    setError(null);
    try {
      await api.delete(`/manufacturing/routings/${productId}`);
      setMode({ kind: 'none' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove routing.');
    }
  }

  const product = (id: string) => products.find((p) => p.id === id);
  const routedIds = new Set((rows ?? []).map((r) => r.finishedProductId));
  const patch = (i: number, p: Partial<DraftOp>) => setDraft((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...p } : o)));

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_routings')}</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('mfg.panel.routing_hint')}
      </p>

      <div className="card" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>{t('field.finished_product')}</label>
          <select value={newProductId} onChange={(e) => setNewProductId(e.target.value)}>
            <option value="">—</option>
            {products
              .filter((p) => !routedIds.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
          </select>
        </div>
        <button className="btn btn-primary" type="button" disabled={!newProductId} onClick={startNew}>
          {t('mfg.action.new_routing')}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      {mode.kind === 'edit' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>
            {product(mode.productId)?.sku} — {product(mode.productId)?.name}
          </h3>
          {draft.map((op, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 10, flexWrap: 'wrap' }}>
              <div className="form-field" style={{ width: 100, marginBottom: 0 }}>
                <label>{t('mfg.field.sequence')}</label>
                <input type="number" min={1} step={1} value={op.sequence} onChange={(e) => patch(i, { sequence: Number(e.target.value) })} />
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
                <label>{t('mfg.field.operation')}</label>
                <input value={op.name} maxLength={255} onChange={(e) => patch(i, { name: e.target.value })} />
              </div>
              <div className="form-field" style={{ minWidth: 220, marginBottom: 0 }}>
                <label>{t('mfg.field.work_center')}</label>
                <select value={op.workCenterId} onChange={(e) => patch(i, { workCenterId: e.target.value })}>
                  <option value="">—</option>
                  {workCenters
                    .filter((w) => w.status === 'active' || w.id === op.workCenterId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} — {w.name}
                      </option>
                    ))}
                </select>
              </div>
              {draft.length > 1 && (
                <button className="btn btn-secondary" type="button" onClick={() => setDraft((prev) => prev.filter((_, idx) => idx !== i))}>
                  ×
                </button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setDraft((prev) => [...prev, { sequence: (prev.length ? Math.max(...prev.map((o) => o.sequence)) : 0) + 10, name: '', workCenterId: '' }])}
            >
              + {t('mfg.action.add_operation')}
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
                    <th>{t('mfg.field.sequence')}</th>
                    <th>{t('mfg.field.operation')}</th>
                    <th>{t('mfg.field.work_center')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.operations.map((o) => (
                    <tr key={o.id}>
                      <td>{o.sequence}</td>
                      <td>{o.name}</td>
                      <td>
                        {o.workCenterCode} — {o.workCenterName}
                      </td>
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

      {rows === null ? (
        <div className="empty-state">{loadingLabel()}</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('mfg.panel.no_routings')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.sku')}</th>
              <th>{t('field.finished_product')}</th>
              <th>{t('mfg.field.operations_count')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.finishedProductId}>
                <td>{r.sku}</td>
                <td>{r.name}</td>
                <td>{r.operationCount}</td>
                <td>
                  <StatusBadge code={`mfg.status.${r.status}`} />
                </td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" type="button" onClick={() => openView(r.finishedProductId)}>
                    {t('mfg.action.view')}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => openEdit(r.finishedProductId)}>
                    {t('mfg.action.edit')}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => setStatus(r.finishedProductId, r.status === 'active' ? 'inactive' : 'active')}>
                    {r.status === 'active' ? t('mfg.action.deactivate') : t('mfg.action.activate')}
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => remove(r.finishedProductId)}>
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
