import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, FormField, StatusChip, type Tone } from '../../components/mfg';
import { ProcessGraph } from './process/ProcessGraph';
import { FindingsPanel, OperationSummary, ProcessBodyEditor, StructureList, type OpType, type Product } from './process/ProcessEditor';
import { check, layout, type Body, type Edge, type Inp, type Op, type Out } from './process/model';

interface VersionRow {
  id: string;
  productId: string;
  versionNo: number;
  status: 'draft' | 'active' | 'retired';
  name: string;
  productSku: string | null;
  productName: string | null;
  operationCount: number;
}
interface VersionView {
  version: { id: string; productId: string; versionNo: number; status: 'draft' | 'active' | 'retired'; name: string; note: string | null };
  operations: Array<Op & { workCenterId: string | null }>;
  edges: Edge[];
  inputs: Array<{ operationCode: string; componentProductId: string; quantityPerUnit: number; alternateGroup: string | null }>;
  outputs: Out[];
}
type EditState = { versionId: string | null; productId: string; status: 'draft' | 'active' | 'retired'; versionNo: number | null; body: Body; saved: string; mode: 'edit' | 'review' };

const emptyBody = (): Body => ({ name: '', note: '', operations: [], edges: [], inputs: [], outputs: [] });
const TONE: Record<string, Tone> = { draft: 'warning', active: 'success', retired: 'neutral' };

const toBody = (v: VersionView): Body => ({
  name: v.version.name,
  note: v.version.note ?? '',
  operations: v.operations.map((o) => ({ code: o.code, name: o.name, operationTypeCode: o.operationTypeCode, sequenceNo: o.sequenceNo, optional: o.optional, maxRuns: o.maxRuns, workCenterId: o.workCenterId })),
  edges: v.edges.map((e) => ({ from: e.from, to: e.to })),
  inputs: v.inputs.map((i) => ({ operationCode: i.operationCode, componentProductId: i.componentProductId, quantityPerUnit: i.quantityPerUnit, alternateGroup: i.alternateGroup ?? '' })) as Inp[],
  outputs: v.outputs.map((o) => ({ operationCode: o.operationCode, productId: o.productId, quantityPerUnit: o.quantityPerUnit, role: o.role, intermediate: o.intermediate, allocationWeight: o.allocationWeight })),
});
const payload = (b: Body) => ({ name: b.name, note: b.note || null, operations: b.operations, edges: b.edges, inputs: b.inputs.map((i) => ({ ...i, alternateGroup: i.alternateGroup.trim() || null })), outputs: b.outputs });

/**
 * Manufacturing Engine process definitions (UX redesign stage 3): versioned operation graph. A DRAFT is edited as operation cards (identity + predecessors + inputs + outputs together) with a live
 * structure summary and graph; saving then REVIEWS the persisted definition and only that review step can activate it. Active / retired versions open read-only. The server stays the authority.
 */
export function Processes() {
  const { t, lang, preload } = useLanguage();
  const { can } = useAuth();
  const ar = lang === 'ar';
  const canEdit = can('manufacturing.routing.edit', 'editable');
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [types, setTypes] = useState<OpType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [newProductId, setNewProductId] = useState('');

  useEffect(() => {
    void preload(['mfg2.pe.confirm_discard', 'mfg2.pe.confirm_delete']); // read at click time inside window.confirm
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    try {
      const [list, prods, ts] = await Promise.all([api.get<VersionRow[]>('/manufacturing/processes'), api.get<Product[]>('/products/all'), api.get<OpType[]>('/manufacturing/processes/operation-types')]);
      setRows(list);
      setProducts(prods);
      setTypes(ts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const pname = (id: string) => products.find((p) => p.id === id);
  const productLabel = useCallback((id: string) => (products.find((p) => p.id === id) ? `${products.find((p) => p.id === id)!.sku} — ${products.find((p) => p.id === id)!.name}` : t('mfg2.pe.unset')), [products, t]);
  const typeLabel = (c: string) => {
    const x = types.find((tp) => tp.code === c);
    return x ? (ar ? x.nameAr : x.nameEn) : c;
  };
  const statusLabel = (s: string) => t(`mfg2.pe.status.${s}`);
  const dirty = !!edit && edit.mode === 'edit' && JSON.stringify(edit.body) !== edit.saved;

  async function open(id: string, mode?: 'edit' | 'review') {
    setError(null);
    setNotice(null);
    try {
      const v = await api.get<VersionView>(`/manufacturing/processes/${id}`);
      const body = toBody(v);
      setEdit({ versionId: id, productId: v.version.productId, status: v.version.status, versionNo: v.version.versionNo, body, saved: JSON.stringify(body), mode: mode ?? (v.version.status === 'draft' ? 'edit' : 'review') });
      setFocus(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    }
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setBusy(false);
    }
  }

  /** Saves the draft; returns the persisted view so the caller can show what was REALLY stored. */
  async function persist(e: EditState): Promise<VersionView> {
    if (e.versionId) return api.post<VersionView>(`/manufacturing/processes/${e.versionId}/save`, payload(e.body));
    return api.post<VersionView>(`/manufacturing/processes/products/${e.productId}/versions`, payload(e.body));
  }
  const afterSave = (v: VersionView, mode: 'edit' | 'review') => {
    const body = toBody(v);
    setEdit({ versionId: v.version.id, productId: v.version.productId, status: v.version.status, versionNo: v.version.versionNo, body, saved: JSON.stringify(body), mode });
  };

  async function saveDraft(thenReview: boolean) {
    if (!edit) return;
    await run(async () => {
      const v = await persist(edit);
      afterSave(v, thenReview ? 'review' : 'edit');
      setNotice(thenReview ? 'mfg2.pe.notice.saved_review' : 'mfg2.pe.notice.saved');
    });
  }
  async function activate() {
    if (!edit?.versionId) return;
    await run(async () => {
      await api.post(`/manufacturing/processes/${edit.versionId}/activate`, {});
      await open(edit.versionId!, 'review');
      setNotice('mfg2.pe.notice.activated');
    });
  }
  function close() {
    if (dirty && !window.confirm(t('mfg2.pe.confirm_discard'))) return;
    setEdit(null);
    setFocus(null);
  }

  const reviewFindings = useMemo(() => (edit && edit.mode === 'review' ? check(edit.body, edit.productId, productLabel) : []), [edit, productLabel]);
  const reviewErrors = reviewFindings.filter((x) => x.severity === 'error').length;
  const setBody = (fn: (b: Body) => Body) => setEdit((e) => (e ? { ...e, body: fn(e.body) } : e));

  return (
    <div data-testid="processes-page">
      <div className="page-header">
        <h1>{t('nav.manufacturing_processes')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.pe.intro')}
      </p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      {notice && (
        <div className="mfg-blocked" role="status" style={{ background: '#e7f6ec', borderColor: '#7bc596', color: '#1c7a3e', marginBlock: 8 }} data-testid="pe-notice">
          {t(notice)}
        </div>
      )}

      {!edit && (
        <>
          {canEdit && (
            <div className="card" style={{ marginBlockEnd: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ minInlineSize: 280, flex: '1 1 280px' }}>
                  <FormField label={t('mfg2.pe.new.product')} hint={t('mfg2.pe.new.hint')}>
                    {(p) => (
                      <select {...p} value={newProductId} onChange={(e) => setNewProductId(e.target.value)} data-testid="proc-new-product">
                        <option value="">{t('mfg2.common.choose')}</option>
                        {products.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.sku} — {x.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </FormField>
                </div>
                <div style={{ marginBlockEnd: 14 }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!newProductId}
                    data-testid="proc-new"
                    onClick={() => {
                      const body = { ...emptyBody(), name: pname(newProductId)?.name ?? '' };
                      setEdit({ versionId: null, productId: newProductId, status: 'draft', versionNo: null, body, saved: '', mode: 'edit' });
                      setNewProductId('');
                      setNotice(null);
                    }}
                  >
                    {t('mfg2.pe.new.cta')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {rows === null ? (
            <div className="mfg-note">{t('mfg2.common.loading')}</div>
          ) : (
            <DataTable
              caption={t('mfg2.pe.list.title')}
              rows={rows}
              rowKey={(r) => r.id}
              empty={<EmptyState title={t('mfg2.pe.list.empty_title')} description={t('mfg2.pe.list.empty_desc')} />}
              columns={[
                { key: 'p', header: t('mfg2.col.product'), render: (r) => `${r.productSku ?? ''} — ${r.productName ?? ''}` },
                { key: 'v', header: t('mfg2.pe.col.version'), render: (r) => `v${r.versionNo}` },
                { key: 'n', header: t('mfg2.pe.col.name'), render: (r) => r.name },
                { key: 'o', header: t('mfg2.pe.col.operations'), align: 'end', render: (r) => r.operationCount },
                { key: 's', header: t('mfg2.col.status'), render: (r) => <StatusChip tone={TONE[r.status]}>{statusLabel(r.status)}</StatusChip> },
                {
                  key: 'a',
                  header: t('mfg2.pe.col.actions'),
                  render: (r) => (
                    <span className="mfg-row-actions">
                      <button className="btn btn-secondary" type="button" onClick={() => open(r.id, r.status === 'draft' && canEdit ? 'edit' : 'review')} data-testid={`proc-open-${r.status}`}>
                        {r.status === 'draft' && canEdit ? t('mfg2.pe.act.edit') : t('mfg2.pe.act.view')}
                      </button>
                      {canEdit && r.status === 'draft' && (
                        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => open(r.id, 'review')} data-testid="proc-review">
                          {t('mfg2.pe.act.review')}
                        </button>
                      )}
                      {canEdit && (
                        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => run(async () => void (await api.post(`/manufacturing/processes/${r.id}/clone`, {})))}>
                          {t('mfg2.pe.act.clone')}
                        </button>
                      )}
                      {canEdit && r.status === 'draft' && (
                        <button
                          className="btn btn-danger"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(t('mfg2.pe.confirm_delete'))) void run(async () => void (await api.delete(`/manufacturing/processes/${r.id}`)));
                          }}
                        >
                          {t('mfg2.pe.act.delete')}
                        </button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </>
      )}

      {edit && (
        <div data-testid="proc-editor">
          <div className="card" style={{ marginBlockEnd: 16 }}>
            <div className="mfg-row-between">
              <h2 style={{ margin: 0, fontSize: '1.2rem' }}>
                {productLabel(edit.productId)} {edit.versionNo ? `— v${edit.versionNo}` : `— ${t('mfg2.pe.new_version')}`}
              </h2>
              <span>
                <StatusChip tone={TONE[edit.status]}>{statusLabel(edit.status)}</StatusChip> <StatusChip tone="info">{edit.mode === 'edit' ? t('mfg2.pe.mode.edit') : t('mfg2.pe.mode.review')}</StatusChip>
                {dirty && <StatusChip tone="warning">{t('mfg2.pe.unsaved')}</StatusChip>}
              </span>
            </div>
            {edit.mode === 'edit' ? (
              <div className="mfg-grid cols-2" style={{ marginBlockStart: 12 }}>
                <FormField label={t('mfg2.pe.name')} required>
                  {(p) => <input {...p} value={edit.body.name} onChange={(e) => setBody((b) => ({ ...b, name: e.target.value }))} data-testid="proc-name" />}
                </FormField>
                <FormField label={t('mfg2.pe.note')}>{(p) => <input {...p} value={edit.body.note} onChange={(e) => setBody((b) => ({ ...b, note: e.target.value }))} />}</FormField>
              </div>
            ) : (
              <p style={{ marginBlockEnd: 0 }}>
                <strong>{edit.body.name}</strong>
                {edit.body.note && <span className="mfg-note"> — {edit.body.note}</span>}
              </p>
            )}
          </div>

          {edit.mode === 'edit' && edit.status === 'draft' && (
            <>
              <ProcessBodyEditor body={edit.body} setBody={setBody} products={products} types={types} productId={edit.productId} focus={focus} setFocus={setFocus} />
              <div className="mfg-actions" style={{ position: 'sticky', insetBlockEnd: 0, background: '#fff', paddingBlock: 10, borderBlockStart: '1px solid #e2e5eb' }}>
                <button className="btn btn-secondary" type="button" disabled={busy || !edit.body.name.trim()} onClick={() => saveDraft(false)} data-testid="proc-save">
                  {t('mfg2.pe.save')}
                </button>
                <button className="btn btn-primary" type="button" disabled={busy || !edit.body.name.trim()} onClick={() => saveDraft(true)} data-testid="proc-save-review">
                  {t('mfg2.pe.save_review')}
                </button>
                <button className="btn btn-secondary" type="button" onClick={close}>
                  {t('mfg2.pe.close')}
                </button>
              </div>
            </>
          )}

          {edit.mode === 'review' && (
            <div data-testid="proc-review-panel">
              <section className="card" aria-labelledby="pe-rev-title">
                <h3 id="pe-rev-title" style={{ marginBlockStart: 0 }}>
                  {t('mfg2.pe.review.title')}
                </h3>
                <p className="mfg-note">{edit.status === 'draft' ? t('mfg2.pe.review.help_draft') : t('mfg2.pe.review.help_readonly')}</p>
                <FindingsPanel findings={reviewFindings} />
              </section>
              <section className="card" style={{ marginBlockStart: 16 }}>
                <h3 style={{ marginBlockStart: 0 }}>{t('mfg2.pe.flow.title')}</h3>
                <StructureList body={edit.body} label={(c) => `${c} — ${edit.body.operations.find((o) => o.code === c)?.name ?? ''}`} />
                {layout(edit.body.operations, edit.body.edges).levels.length > 0 && <ProcessGraph ops={edit.body.operations} edges={edit.body.edges} selected={focus} onSelect={setFocus} typeLabel={typeLabel} />}
              </section>
              <section style={{ marginBlockStart: 16 }} aria-labelledby="pe-rev-ops">
                <h3 id="pe-rev-ops">{t('mfg2.pe.ops.title')}</h3>
                {[...edit.body.operations]
                  .sort((a, b) => a.sequenceNo - b.sequenceNo)
                  .map((o) => (
                    <OperationSummary key={o.code} body={edit.body} o={o} productLabel={productLabel} typeLabel={typeLabel} />
                  ))}
              </section>
              <div className="mfg-actions">
                {edit.status === 'draft' && canEdit && (
                  <>
                    <button className="btn btn-primary" type="button" disabled={busy || reviewErrors > 0} onClick={activate} data-testid="proc-activate">
                      {t('mfg2.pe.activate')}
                    </button>
                    <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setEdit((e) => (e ? { ...e, mode: 'edit' } : e))}>
                      {t('mfg2.pe.back_edit')}
                    </button>
                  </>
                )}
                {edit.status !== 'draft' && canEdit && edit.versionId && (
                  <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => run(async () => { const v = await api.post<VersionView>(`/manufacturing/processes/${edit.versionId}/clone`, {}); afterSave(v, 'edit'); setNotice('mfg2.pe.notice.cloned'); })}>
                    {t('mfg2.pe.act.clone')}
                  </button>
                )}
                <button className="btn btn-secondary" type="button" onClick={close}>
                  {t('mfg2.pe.close')}
                </button>
              </div>
              {edit.status === 'draft' && reviewErrors > 0 && (
                <div style={{ marginBlockStart: 8 }}>
                  <BlockedReason>{t('mfg2.pe.chk.cannot_activate')}</BlockedReason>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
