import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, FormField, StatusChip, StepIndicator } from '../../components/mfg';

interface Warehouse {
  id: string;
  code: string;
  name: string;
  /** 'operational' = a Work Order's WIP sub-warehouse - never a place to assemble. */
  kind?: 'main' | 'operational';
}
interface BomListEntry {
  finishedProductId: string;
  sku: string;
  name: string;
  status: 'active' | 'inactive';
}
interface ProductLite {
  id: string;
  sku: string;
  name: string;
  unit?: string | null;
}
interface PreviewComponent {
  productId: string;
  sku: string;
  name: string;
  unit: string | null;
  perUnit: number;
  required: number;
  available: number;
  shortage: number;
  status: 'ok' | 'short';
}
interface Preview {
  canAssemble: boolean;
  quantity: number;
  product: { id: string; sku: string; name: string; unit: string | null } | null;
  warehouse: { id: string; code: string; name: string } | null;
  components: PreviewComponent[];
  blockers: Array<{ code: string; message: string }>;
  estimatedCostBase: string | null;
}
interface Result {
  workOrderId: string;
  workOrderNumber: string;
  state: string;
  product: { sku: string; name: string; unit: string | null };
  warehouse: { code: string; name: string };
  plannedQuantity: number;
  producedQuantity: number;
  components: Array<{ productId: string; sku: string; name: string; unit: string | null; required: number; consumed: number }>;
  materialValueBase: string | null;
  outputValueBase: string | null;
  unitCostBase: string | null;
  events: Array<{ eventType: string; status: string; rejectionReason: string | null }>;
  warnings: string[];
}
interface Row {
  id: string;
  sku: string;
  name: string;
  unit: string | null;
  bom: 'active' | 'inactive' | 'none';
}

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const money = (v: string | null) => (v == null ? null : Number(v).toFixed(2));

/**
 * Quick Assembly (UX redesign, stage 2): select product -> quantity + materials check -> review -> result. A direct, one-step assembly from the active BOM; no process graph, no stages.
 * The preview is informational (nothing is reserved); the confirmation revalidates stock and every rule atomically on the server and is idempotent per confirmation.
 */
export function Assembly() {
  const { t } = useLanguage();
  const { can } = useAuth();
  const [step, setStep] = useState(0);
  const [boms, setBoms] = useState<BomListEntry[] | null>(null);
  const [products, setProducts] = useState<ProductLite[] | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Row | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [qty, setQty] = useState('1');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const idemKey = useRef<string>(newKey());

  useEffect(() => {
    void (async () => {
      try {
        const [b, w] = await Promise.all([api.get<BomListEntry[]>('/manufacturing/boms'), api.get<Warehouse[]>('/inventory/warehouses')]);
        setBoms(b);
        setWarehouses(w.filter((x) => x.kind !== 'operational'));
        if (w.filter((x) => x.kind !== 'operational').length === 1) setWarehouseId(w.filter((x) => x.kind !== 'operational')[0].id);
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
      }
      try {
        setProducts(await api.get<ProductLite[]>('/products/all')); // optional: lets us explain WHY a product without a BOM is unavailable
      } catch {
        setProducts(null);
      }
    })();
  }, [t]);

  const rows: Row[] = useMemo(() => {
    const bomOf = new Map((boms ?? []).map((b) => [b.finishedProductId, b.status]));
    const base: Row[] = products
      ? products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, unit: p.unit ?? null, bom: bomOf.get(p.id) ?? 'none' }))
      : (boms ?? []).map((b) => ({ id: b.finishedProductId, sku: b.sku, name: b.name, unit: null, bom: b.status }));
    const f = filter.trim().toLowerCase();
    const list = f ? base.filter((r) => `${r.sku} ${r.name}`.toLowerCase().includes(f)) : base;
    return list.sort((a, b) => Number(b.bom === 'active') - Number(a.bom === 'active') || a.sku.localeCompare(b.sku)).slice(0, 60);
  }, [boms, products, filter]);

  // Informational preview: refreshed (debounced) whenever the product, warehouse or quantity changes while on step 2.
  useEffect(() => {
    if (step !== 1 || !selected || !warehouseId) return;
    const q = Number(qty);
    if (!Number.isInteger(q) || q < 1) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    const h = setTimeout(async () => {
      try {
        const p = await api.get<Preview>(`/manufacturing/quick-assembly/preview?finishedProductId=${selected.id}&warehouseId=${warehouseId}&quantity=${q}`);
        if (!cancelled) {
          setPreview(p);
          setPreviewError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(err instanceof ApiError ? err.message : t('mfg2.common.load_failed'));
        }
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [step, selected, warehouseId, qty, t]);

  const qtyNumber = Number(qty);
  const qtyError = qty.trim() === '' ? t('mfg2.qa.qty_required') : !Number.isInteger(qtyNumber) || qtyNumber < 1 ? t('mfg2.qa.qty_invalid') : null;
  const whName = warehouses.find((w) => w.id === warehouseId);

  function reasonFor(r: Row): string | null {
    if (r.bom === 'active') return null;
    return r.bom === 'inactive' ? t('mfg2.qa.reason_inactive_bom') : t('mfg2.qa.reason_no_bom');
  }

  async function confirm() {
    if (!selected || !preview) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const r = await api.post<Result>('/manufacturing/quick-assembly', { warehouseId, finishedProductId: selected.id, quantity: Number(qty) }, { idempotencyKey: idemKey.current });
      setResult(r);
      setStep(3);
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setConfirming(false);
    }
  }

  function restart() {
    setStep(0);
    setSelected(null);
    setQty('1');
    setPreview(null);
    setResult(null);
    setConfirmError(null);
    idemKey.current = newKey();
  }

  const steps = [t('mfg2.qa.step1'), t('mfg2.qa.step2'), t('mfg2.qa.step3'), t('mfg2.qa.step4')];
  const shortCount = preview ? preview.components.filter((c) => c.status === 'short').length : 0;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.manufacturing_quick_assembly')}</h1>
      </div>
      <p className="mfg-note" style={{ marginBlockStart: 0, fontSize: '0.95rem' }}>
        {t('mfg2.qa.intro')}
      </p>
      <StepIndicator steps={steps} current={step} label={t('mfg2.qa.steps_label')} />
      {loadError && <BlockedReason danger>{loadError}</BlockedReason>}

      {step === 0 && (
        <div className="card">
          <div className="mfg-grid cols-2">
            <FormField label={t('mfg2.qa.product')} hint={t('mfg2.qa.product_hint')} required>
              {(p) => <input {...p} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('mfg2.qa.product_search')} />}
            </FormField>
            <FormField label={t('mfg2.qa.warehouse')} hint={t('mfg2.qa.warehouse_hint')} required>
              {(p) => (
                <select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">{t('mfg2.common.choose')}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          </div>
          {boms === null && !loadError ? (
            <div className="empty-state">{t('mfg2.common.loading')}</div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('mfg2.qa.no_products_title')}
              description={t('mfg2.qa.no_products_desc')}
              action={can('manufacturing.bom.create', 'editable') ? <Link to="/manufacturing/boms">{t('nav.manufacturing_boms')}</Link> : undefined}
            />
          ) : (
            <ul className="mfg-option-list" role="listbox" aria-label={t('mfg2.qa.product')} data-testid="qa-product-list">
              {rows.map((r) => {
                const why = reasonFor(r);
                return (
                  <li
                    key={r.id}
                    role="option"
                    aria-selected={selected?.id === r.id}
                    aria-disabled={why ? true : undefined}
                    tabIndex={why ? -1 : 0}
                    className="mfg-option"
                    data-testid={`qa-product-${r.sku}`}
                    onClick={() => !why && setSelected(r)}
                    onKeyDown={(e) => {
                      if (!why && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        setSelected(r);
                      }
                    }}
                  >
                    <span>
                      <strong>{r.sku}</strong> — {r.name} {r.unit && <small>({r.unit})</small>}
                    </span>
                    <small>{why ?? t('mfg2.qa.ready')}</small>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mfg-actions">
            <button className="btn btn-primary" type="button" disabled={!selected || !warehouseId} onClick={() => setStep(1)} data-testid="qa-next-1">
              {t('mfg2.common.next')}
            </button>
            {(!selected || !warehouseId) && <span className="mfg-note">{!selected ? t('mfg2.qa.pick_product_first') : t('mfg2.qa.pick_warehouse_first')}</span>}
          </div>
        </div>
      )}

      {step === 1 && selected && (
        <div className="card">
          <p style={{ marginBlockStart: 0 }}>
            <strong>{selected.sku}</strong> — {selected.name} · {whName ? `${whName.code} — ${whName.name}` : ''}
          </p>
          <div style={{ maxInlineSize: 320 }}>
            <FormField label={t('mfg2.qa.qty')} hint={`${t('mfg2.qa.qty_hint')}${preview?.product?.unit ? ` (${preview.product.unit})` : selected.unit ? ` (${selected.unit})` : ''}`} error={qtyError} required>
              {(p) => <input {...p} type="number" min={1} step={1} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="qa-qty" />}
            </FormField>
          </div>
          {previewError && <BlockedReason danger>{previewError}</BlockedReason>}
          {loadingPreview && <div className="mfg-note">{t('mfg2.common.loading')}</div>}
          {preview && (
            <>
              <DataTable
                caption={t('mfg2.qa.materials')}
                rows={preview.components}
                rowKey={(c) => c.productId}
                warnRow={(c) => c.status === 'short'}
                columns={[
                  { key: 'c', header: t('mfg2.col.component'), render: (c) => `${c.sku} — ${c.name}` },
                  { key: 'r', header: t('mfg2.col.required'), align: 'end', render: (c) => c.required },
                  { key: 'u', header: t('mfg2.col.unit'), render: (c) => c.unit ?? '—' },
                  { key: 'a', header: t('mfg2.col.available'), align: 'end', render: (c) => c.available },
                  { key: 's', header: t('mfg2.col.shortage'), align: 'end', render: (c) => c.shortage },
                  { key: 'st', header: t('mfg2.col.availability'), render: (c) => <StatusChip tone={c.status === 'ok' ? 'success' : 'danger'}>{c.status === 'ok' ? t('mfg2.qa.avail_ok') : t('mfg2.qa.avail_short')}</StatusChip> },
                ]}
              />
              {preview.blockers.length > 0 && (
                <div style={{ marginBlockStart: 12 }}>
                  <BlockedReason danger>
                    {shortCount > 0 ? t('mfg2.qa.blocked_shortage') : preview.blockers.map((b) => b.message).join(' ')}
                  </BlockedReason>
                </div>
              )}
              <p className="mfg-note">{t('mfg2.qa.preview_note')}</p>
            </>
          )}
          <div className="mfg-actions">
            <button className="btn btn-secondary" type="button" onClick={() => setStep(0)}>
              {t('mfg2.common.back')}
            </button>
            <button className="btn btn-primary" type="button" disabled={!preview?.canAssemble || !!qtyError || loadingPreview} onClick={() => { idemKey.current = newKey(); setStep(2); }} data-testid="qa-next-2">
              {t('mfg2.common.next')}
            </button>
          </div>
        </div>
      )}

      {step === 2 && selected && preview && (
        <div className="card">
          <div className="mfg-summary">
            <dl>
              <dt>{t('mfg2.qa.product')}</dt>
              <dd>
                {selected.sku} — {selected.name}
              </dd>
              <dt>{t('mfg2.qa.qty')}</dt>
              <dd>
                {preview.quantity} {preview.product?.unit ?? ''}
              </dd>
              <dt>{t('mfg2.qa.warehouse')}</dt>
              <dd>{preview.warehouse ? `${preview.warehouse.code} — ${preview.warehouse.name}` : '—'}</dd>
              <dt>{t('mfg2.qa.effect_out')}</dt>
              <dd>{preview.components.map((c) => `${c.sku} −${c.required}`).join(' · ')}</dd>
              <dt>{t('mfg2.qa.effect_in')}</dt>
              <dd>
                {selected.sku} +{preview.quantity}
              </dd>
              <dt>{t('mfg2.qa.cost_estimate')}</dt>
              <dd>{preview.estimatedCostBase ? money(preview.estimatedCostBase) : t('mfg2.qa.cost_unknown')}</dd>
            </dl>
            <p className="mfg-note">{t('mfg2.qa.cost_note')}</p>
          </div>
          {confirmError && (
            <div style={{ marginBlockStart: 12 }}>
              <BlockedReason danger>
                {confirmError} {t('mfg2.qa.confirm_failed_hint')}
              </BlockedReason>
            </div>
          )}
          <div className="mfg-actions">
            <button className="btn btn-secondary" type="button" disabled={confirming} onClick={() => setStep(1)}>
              {t('mfg2.common.back')}
            </button>
            <button className="btn btn-primary" type="button" disabled={confirming} aria-busy={confirming} onClick={confirm} data-testid="qa-confirm">
              {confirming ? t('mfg2.common.working') : t('mfg2.qa.confirm')}
            </button>
          </div>
        </div>
      )}

      {step === 3 && result && (
        <div className="card" data-testid="qa-result">
          <h2 style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
            {t('mfg2.qa.done_title')} <StatusChip tone="success">{result.workOrderNumber}</StatusChip>
          </h2>
          <div className="mfg-summary">
            <dl>
              <dt>{t('mfg2.qa.product')}</dt>
              <dd>
                {result.product.sku} — {result.product.name}
              </dd>
              <dt>{t('mfg2.qa.produced')}</dt>
              <dd>
                {result.producedQuantity} / {result.plannedQuantity} {result.product.unit ?? ''}
              </dd>
              <dt>{t('mfg2.qa.warehouse')}</dt>
              <dd>
                {result.warehouse.code} — {result.warehouse.name}
              </dd>
              <dt>{t('mfg2.qa.material_value')}</dt>
              <dd>{money(result.materialValueBase) ?? t('mfg2.qa.value_unavailable')}</dd>
              <dt>{t('mfg2.qa.output_value')}</dt>
              <dd>{money(result.outputValueBase) ?? t('mfg2.qa.value_unavailable')}</dd>
              <dt>{t('mfg2.qa.unit_cost')}</dt>
              <dd>{money(result.unitCostBase) ?? t('mfg2.qa.value_unavailable')}</dd>
            </dl>
          </div>
          <div style={{ marginBlockStart: 14 }}>
            <DataTable
              caption={t('mfg2.qa.consumption')}
              rows={result.components}
              rowKey={(c) => c.productId}
              columns={[
                { key: 'c', header: t('mfg2.col.component'), render: (c) => `${c.sku} — ${c.name}` },
                { key: 'r', header: t('mfg2.col.required'), align: 'end', render: (c) => c.required },
                { key: 'x', header: t('mfg2.col.consumed'), align: 'end', render: (c) => c.consumed },
                { key: 'u', header: t('mfg2.col.unit'), render: (c) => c.unit ?? '—' },
              ]}
            />
          </div>
          {result.warnings.length > 0 ? (
            <div style={{ marginBlockStart: 12 }}>
              <BlockedReason danger to="/accounting/financial-events" linkText={can('accounting.financial_event.view', 'read-only') ? t('mfg2.qa.open_events') : undefined}>
                {t('mfg2.qa.warnings')}: {result.warnings.join(' | ')}
              </BlockedReason>
            </div>
          ) : (
            <p className="mfg-note">{t('mfg2.qa.no_warnings')}</p>
          )}
          <div className="mfg-actions">
            <button className="btn btn-primary" type="button" onClick={restart}>
              {t('mfg2.qa.again')}
            </button>
            {can('manufacturing.work_order.view', 'read-only') && (
              <Link className="btn btn-secondary mfg-linkbtn" to={`/manufacturing/work-orders/${result.workOrderId}`}>
                {t('mfg2.qa.open_order')}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
