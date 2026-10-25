import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, FormField, StatusChip } from '../../components/mfg';
import { ProductUnits } from './ProductUnits';
import { toBase } from './units';

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
interface Line {
  componentProductId: string;
  /** Decimal typed by the user, in `unitCode` (blank = the component's base unit); the server converts it exactly to whole base units (S2 / D-ME-2). */
  quantity: string;
  unitCode: string;
}
type Conv = Record<string, number>; // unitCode -> base units per 1 unit
type Mode = { kind: 'none' } | { kind: 'view'; productId: string } | { kind: 'edit'; productId: string; isNew: boolean };

const blank = (): Line => ({ componentProductId: '', quantity: '1', unitCode: '' });

/**
 * Bills of Materials / recipes (UX redesign stage 3). The recipe is stored per product in WHOLE base units; a line may be typed as a decimal in one of the component's pack units and the server converts it exactly.
 * This screen shows - before saving - the exact stored equivalent (or why the typed amount does not land on a whole count, with the two nearest valid counts). Active/inactive is explained, not just shown.
 */
export function ManufacturingBoms() {
  const { t, preload } = useLanguage();
  const { can } = useAuth();
  const canCreate = can('manufacturing.bom.create', 'editable');
  const canEdit = can('manufacturing.bom.edit', 'editable');
  const canDelete = can('manufacturing.bom.delete', 'editable');
  const [boms, setBoms] = useState<BomListEntry[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [detail, setDetail] = useState<BomView | null>(null);
  const [draft, setDraft] = useState<Line[]>([blank()]);
  const [newProductId, setNewProductId] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [convs, setConvs] = useState<Record<string, Conv>>({});

  useEffect(() => {
    void preload(['mfg2.bom.confirm_delete']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadConvs = useCallback(async (productId: string) => {
    if (!productId) return;
    try {
      const v = await api.get<{ baseUnit: string; conversions: Array<{ unitCode: string; factor: number }> }>(`/manufacturing/unit-conversions/${productId}`);
      setConvs((prev) => (prev[productId] ? prev : { ...prev, [productId]: Object.fromEntries(v.conversions.map((c) => [c.unitCode, c.factor])) }));
    } catch {
      setConvs((prev) => (prev[productId] ? prev : { ...prev, [productId]: {} }));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, prods] = await Promise.all([api.get<BomListEntry[]>('/manufacturing/boms'), api.get<Product[]>('/products/all')]);
      setBoms(list);
      setProducts(prods);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function loadDetail(productId: string): Promise<BomView | null> {
    try {
      const data = await api.get<BomView>(`/manufacturing/boms/${productId}`);
      setDetail(data);
      return data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
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
    setNotice(null);
    setDetail(null);
    const data = await loadDetail(productId);
    if (!data) return;
    setDraft(data.components.map((c) => ({ componentProductId: c.componentProductId, quantity: String(c.quantityPerUnit), unitCode: '' })));
    data.components.forEach((c) => void loadConvs(c.componentProductId));
    setMode({ kind: 'edit', productId, isNew: false });
  }
  function startNew() {
    if (!newProductId) return;
    setError(null);
    setNotice(null);
    setDetail(null);
    setDraft([blank()]);
    setMode({ kind: 'edit', productId: newProductId, isNew: true });
    setNewProductId('');
  }

  const product = (id: string) => products.find((p) => p.id === id);

  /** Per-line validation + the exact stored equivalent. Everything here is advisory; the server re-validates on save. */
  const lineInfo = useMemo(() => {
    const seen = new Map<string, number>();
    draft.forEach((l) => l.componentProductId && seen.set(l.componentProductId, (seen.get(l.componentProductId) ?? 0) + 1));
    return draft.map((l) => {
      const comp = product(l.componentProductId);
      const factor = l.unitCode ? (convs[l.componentProductId]?.[l.unitCode] ?? 0) : 1;
      const r = l.quantity.trim() === '' ? null : toBase(l.quantity, factor || 1);
      let error: string | null = null;
      if (!l.componentProductId) error = 'mfg2.bom.err.component';
      else if (mode.kind === 'edit' && l.componentProductId === mode.productId) error = 'mfg2.bom.err.self';
      else if ((seen.get(l.componentProductId) ?? 0) > 1) error = 'mfg2.bom.err.duplicate';
      else if (!r || r.kind === 'invalid') error = 'mfg2.bom.err.qty_invalid';
      else if (r.kind === 'zero') error = 'mfg2.bom.err.qty_zero';
      else if (r.kind === 'fraction') error = 'mfg2.bom.err.fraction';
      return { comp, factor, r, error };
    });
  }, [draft, convs, products, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = draft.length > 0 && lineInfo.every((x) => !x.error);

  async function save() {
    if (mode.kind !== 'edit' || !valid) return;
    const components = draft.map((l) => ({ componentProductId: l.componentProductId, quantity: l.quantity.trim().replace(',', '.'), ...(l.unitCode ? { unitCode: l.unitCode } : {}) }));
    setSaving(true);
    setError(null);
    try {
      await api.post(mode.isNew ? `/manufacturing/boms/${mode.productId}` : `/manufacturing/boms/${mode.productId}/replace`, { components });
      await load();
      await openView(mode.productId);
      setNotice('mfg2.bom.notice.saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
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
      setNotice(status === 'active' ? 'mfg2.bom.notice.activated' : 'mfg2.bom.notice.deactivated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    }
  }
  async function remove(productId: string) {
    if (!window.confirm(t('mfg2.bom.confirm_delete'))) return;
    setError(null);
    try {
      await api.delete(`/manufacturing/boms/${productId}`);
      setMode({ kind: 'none' });
      setDetail(null);
      await load();
      setNotice('mfg2.bom.notice.deleted');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = boms?.filter((b) => !q || b.sku.toLowerCase().includes(q) || b.name.toLowerCase().includes(q));
  const bomProductIds = new Set((boms ?? []).map((b) => b.finishedProductId));
  const statusChip = (s: 'active' | 'inactive') => <StatusChip tone={s === 'active' ? 'success' : 'warning'}>{t(`mfg2.bom.status.${s}`)}</StatusChip>;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_boms')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.bom.intro')}
      </p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      {notice && (
        <div className="mfg-blocked" role="status" style={{ background: '#e7f6ec', borderColor: '#7bc596', color: '#1c7a3e', marginBlock: 8 }} data-testid="bom-notice">
          {t(notice)}
        </div>
      )}

      {canCreate && mode.kind === 'none' && (
        <div className="card" style={{ marginBlockEnd: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ minInlineSize: 280, flex: '1 1 280px' }}>
            <FormField label={t('mfg2.bom.new.product')} hint={t('mfg2.bom.new.hint')}>
              {(p) => (
                <select {...p} value={newProductId} onChange={(e) => setNewProductId(e.target.value)} data-testid="bom-new-product">
                  <option value="">{t('mfg2.common.choose')}</option>
                  {products
                    .filter((x) => !bomProductIds.has(x.id))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.sku} — {x.name}
                      </option>
                    ))}
                </select>
              )}
            </FormField>
          </div>
          <div style={{ marginBlockEnd: 14 }}>
            <button className="btn btn-primary" type="button" disabled={!newProductId} onClick={startNew} data-testid="bom-new">
              {t('mfg2.bom.new.cta')}
            </button>
          </div>
          <div style={{ minInlineSize: 220, marginInlineStart: 'auto' }}>
            <FormField label={t('mfg2.bom.search')}>{(p) => <input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}</FormField>
          </div>
        </div>
      )}

      {mode.kind === 'edit' && (
        <div className="card" style={{ marginBlockEnd: 16 }} data-testid="bom-editor">
          <h2 style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
            {t('mfg2.bom.edit.title')}: {product(mode.productId)?.sku} — {product(mode.productId)?.name} {product(mode.productId)?.unit && <small>({product(mode.productId)!.unit})</small>}
          </h2>
          <p className="mfg-note">{t('mfg2.bom.edit.help')}</p>
          {draft.map((line, i) => {
            const info = lineInfo[i];
            const baseUnit = info.comp?.unit || t('mfg2.bom.base_unit');
            const units = convs[line.componentProductId] ?? {};
            return (
              <div key={i} className="mfg-subrow bom" data-testid={`bom-line-${i}`}>
                <FormField label={t('mfg2.bom.line.component')} required>
                  {(p) => (
                    <select
                      {...p}
                      value={line.componentProductId}
                      onChange={(e) => {
                        void loadConvs(e.target.value);
                        setDraft((prev) => prev.map((l, idx) => (idx === i ? { ...l, componentProductId: e.target.value, unitCode: '' } : l)));
                      }}
                    >
                      <option value="">{t('mfg2.common.choose')}</option>
                      {products
                        .filter((x) => x.id !== mode.productId)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.sku} — {x.name}
                          </option>
                        ))}
                    </select>
                  )}
                </FormField>
                <FormField label={t('mfg2.bom.line.qty')} hint={t('mfg2.bom.line.qty_hint')} required>
                  {(p) => <input {...p} inputMode="decimal" value={line.quantity} onChange={(e) => setDraft((prev) => prev.map((l, idx) => (idx === i ? { ...l, quantity: e.target.value } : l)))} data-testid={`bom-qty-${i}`} />}
                </FormField>
                <FormField label={t('mfg2.bom.line.unit')} hint={Object.keys(units).length === 0 ? t('mfg2.bom.line.unit_none') : undefined}>
                  {(p) => (
                    <select {...p} value={line.unitCode} onChange={(e) => setDraft((prev) => prev.map((l, idx) => (idx === i ? { ...l, unitCode: e.target.value } : l)))} data-testid="bom-unit-select">
                      <option value="">{baseUnit}</option>
                      {Object.keys(units).map((u) => (
                        <option key={u} value={u}>
                          {u} ({units[u]} {baseUnit})
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <div className="mfg-equiv" aria-live="polite" data-testid={`bom-equiv-${i}`}>
                  <span className="mfg-check-label">{t('mfg2.bom.line.equiv')}</span>
                  {info.r?.kind === 'whole' ? (
                    <strong>
                      {info.r.base} {baseUnit}
                    </strong>
                  ) : info.r?.kind === 'fraction' ? (
                    <span className="mfg-field-error">
                      {t('mfg2.bom.err.fraction')} {t('mfg2.bom.suggest')} <strong>{info.r.below}</strong> / <strong>{info.r.above}</strong> {baseUnit}
                    </span>
                  ) : (
                    <span className="mfg-note">—</span>
                  )}
                  {info.error && info.error !== 'mfg2.bom.err.fraction' && line.componentProductId && <div className="mfg-field-error">{t(info.error)}</div>}
                </div>
                {draft.length > 1 && (
                  <button className="btn btn-secondary mfg-remove" type="button" aria-label={t('mfg2.pe.remove')} onClick={() => setDraft((prev) => prev.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <div className="mfg-actions">
            <button className="btn btn-secondary" type="button" onClick={() => setDraft((prev) => [...prev, blank()])}>
              + {t('mfg2.bom.add_line')}
            </button>
            <button className="btn btn-primary" type="button" disabled={saving || !valid} onClick={save} data-testid="bom-save">
              {t('mfg2.bom.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setMode({ kind: 'none' })}>
              {t('mfg2.pe.close')}
            </button>
          </div>
          {!valid && <p className="mfg-note">{t('mfg2.bom.save_blocked')}</p>}
          <p className="mfg-note">{t('mfg2.bom.draft_note')}</p>
        </div>
      )}

      {mode.kind === 'view' && (
        <div className="card" style={{ marginBlockEnd: 16 }}>
          {detail ? (
            <>
              <div className="mfg-row-between">
                <h2 style={{ margin: 0, fontSize: '1.15rem' }}>
                  {detail.finishedProductSku} — {detail.finishedProductName} {statusChip(detail.status)}
                </h2>
                <span className="mfg-row-actions">
                  {canEdit && (
                    <button className="btn btn-secondary" type="button" onClick={() => openEdit(detail.finishedProductId)}>
                      {t('mfg2.bom.act.edit')}
                    </button>
                  )}
                  {canEdit && (
                    <button className="btn btn-primary" type="button" onClick={() => setStatus(detail.finishedProductId, detail.status === 'active' ? 'inactive' : 'active')} data-testid="bom-toggle-status">
                      {detail.status === 'active' ? t('mfg2.bom.act.deactivate') : t('mfg2.bom.act.activate')}
                    </button>
                  )}
                  <button className="btn btn-secondary" type="button" onClick={() => setMode({ kind: 'none' })}>
                    {t('mfg2.pe.close')}
                  </button>
                </span>
              </div>
              <p className="mfg-note">{detail.status === 'active' ? t('mfg2.bom.status.active_help') : t('mfg2.bom.status.inactive_help')}</p>
              <DataTable
                caption={t('mfg2.bom.components')}
                rows={detail.components}
                rowKey={(c) => c.componentProductId}
                columns={[
                  { key: 'sku', header: t('mfg2.bom.col.sku'), render: (c) => c.sku },
                  { key: 'n', header: t('mfg2.bom.line.component'), render: (c) => c.productName },
                  { key: 'q', header: t('mfg2.bom.col.qty_base'), align: 'end', render: (c) => c.quantityPerUnit },
                  { key: 'u', header: t('mfg2.col.unit'), render: (c) => c.unit ?? '—' },
                ]}
              />
              <p className="mfg-note">{t('mfg2.bom.stored_note')}</p>
            </>
          ) : (
            <div className="mfg-note">{t('mfg2.common.loading')}</div>
          )}
        </div>
      )}

      {boms === null ? (
        <div className="mfg-note">{t('mfg2.common.loading')}</div>
      ) : (
        <DataTable
          caption={t('mfg2.bom.list.title')}
          rows={filtered ?? []}
          rowKey={(b) => b.finishedProductId}
          empty={<EmptyState title={t('mfg2.bom.list.empty_title')} description={t('mfg2.bom.list.empty_desc')} />}
          columns={[
            { key: 'sku', header: t('mfg2.bom.col.sku'), render: (b) => b.sku },
            { key: 'n', header: t('mfg2.bom.col.product'), render: (b) => b.name },
            { key: 'c', header: t('mfg2.bom.col.components'), align: 'end', render: (b) => b.componentCount },
            { key: 's', header: t('mfg2.col.status'), render: (b) => statusChip(b.status) },
            {
              key: 'a',
              header: t('mfg2.pe.col.actions'),
              render: (b) => (
                <span className="mfg-row-actions">
                  <button className="btn btn-secondary" type="button" onClick={() => openView(b.finishedProductId)}>
                    {t('mfg2.pe.act.view')}
                  </button>
                  {canEdit && (
                    <button className="btn btn-secondary" type="button" onClick={() => openEdit(b.finishedProductId)}>
                      {t('mfg2.bom.act.edit')}
                    </button>
                  )}
                  {canEdit && (
                    <button className="btn btn-secondary" type="button" onClick={() => setStatus(b.finishedProductId, b.status === 'active' ? 'inactive' : 'active')}>
                      {b.status === 'active' ? t('mfg2.bom.act.deactivate') : t('mfg2.bom.act.activate')}
                    </button>
                  )}
                  {canDelete && (
                    <button className="btn btn-danger" type="button" onClick={() => remove(b.finishedProductId)}>
                      {t('mfg2.bom.act.delete')}
                    </button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}

      <ProductUnits products={products} />
    </div>
  );
}
