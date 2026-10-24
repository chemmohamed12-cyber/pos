import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { loadingLabel } from '../../lib/displayNames';

interface Product {
  id: string;
  sku: string;
  name: string;
}
interface OpType {
  code: string;
  nameAr: string;
  nameEn: string;
  kind: string;
  active: boolean;
}
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
interface Op {
  code: string;
  name: string;
  operationTypeCode: string;
  sequenceNo: number;
  optional: boolean;
  maxRuns: number;
}
interface Edge {
  from: string;
  to: string;
}
interface Inp {
  operationCode: string;
  componentProductId: string;
  quantityPerUnit: number;
  alternateGroup: string;
}
interface Out {
  operationCode: string;
  productId: string;
  quantityPerUnit: number;
  role: 'good' | 'co_product' | 'by_product';
  intermediate: boolean;
  allocationWeight: number;
}
interface Body {
  name: string;
  note: string;
  operations: Op[];
  edges: Edge[];
  inputs: Inp[];
  outputs: Out[];
}
interface VersionView {
  version: { id: string; productId: string; versionNo: number; status: 'draft' | 'active' | 'retired'; name: string; note: string | null };
  operations: Array<Op & { workCenterId: string | null }>;
  edges: Edge[];
  inputs: Array<{ operationCode: string; componentProductId: string; quantityPerUnit: number; alternateGroup: string | null }>;
  outputs: Array<Out>;
}

const emptyBody = (): Body => ({ name: '', note: '', operations: [], edges: [], inputs: [], outputs: [] });
const STATUS_AR: Record<string, string> = { draft: 'مسودة', active: 'نشطة', retired: 'متقاعدة' };
const ROLE_AR: Record<string, string> = { good: 'منتج رئيسي', co_product: 'ناتج مشترك', by_product: 'ناتج ثانوي' };

/**
 * Manufacturing Engine S3 - process definitions: versioned operation graph (types, predecessors, optional / repeatable), inputs with alternates and outputs
 * (good / co-product / by-product, intermediate or final). A draft is edited as a whole; activating it makes it the product's one active version.
 */
export function Processes() {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const tx = (a: string, e: string) => (ar ? a : e);
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [types, setTypes] = useState<OpType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ versionId: string | null; productId: string; status: string; versionNo: number | null; body: Body } | null>(null);
  const [newProductId, setNewProductId] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, prods, ts] = await Promise.all([api.get<VersionRow[]>('/manufacturing/processes'), api.get<Product[]>('/products/all'), api.get<OpType[]>('/manufacturing/processes/operation-types')]);
      setRows(list);
      setProducts(prods);
      setTypes(ts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function openVersion(id: string) {
    setError(null);
    try {
      const v = await api.get<VersionView>(`/manufacturing/processes/${id}`);
      setEdit({
        versionId: id,
        productId: v.version.productId,
        status: v.version.status,
        versionNo: v.version.versionNo,
        body: {
          name: v.version.name,
          note: v.version.note ?? '',
          operations: v.operations.map((o) => ({ code: o.code, name: o.name, operationTypeCode: o.operationTypeCode, sequenceNo: o.sequenceNo, optional: o.optional, maxRuns: o.maxRuns })),
          edges: v.edges,
          inputs: v.inputs.map((i) => ({ ...i, alternateGroup: i.alternateGroup ?? '' })),
          outputs: v.outputs.map((o) => ({ operationCode: o.operationCode, productId: o.productId, quantityPerUnit: o.quantityPerUnit, role: o.role, intermediate: o.intermediate, allocationWeight: o.allocationWeight })),
        },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    }
  }

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  const payload = (b: Body) => ({
    name: b.name,
    note: b.note || null,
    operations: b.operations,
    edges: b.edges,
    inputs: b.inputs.map((i) => ({ ...i, alternateGroup: i.alternateGroup.trim() || null })),
    outputs: b.outputs,
  });

  async function save() {
    if (!edit) return;
    await act(async () => {
      if (edit.versionId) {
        await api.post(`/manufacturing/processes/${edit.versionId}/save`, payload(edit.body));
      } else {
        const v = await api.post<VersionView>(`/manufacturing/processes/products/${edit.productId}/versions`, payload(edit.body));
        setEdit((e) => (e ? { ...e, versionId: v.version.id, versionNo: v.version.versionNo } : e));
      }
    });
  }

  const pname = (id: string) => products.find((p) => p.id === id);
  const label = (id: string) => (pname(id) ? `${pname(id)!.sku} — ${pname(id)!.name}` : id.slice(0, 8));
  const isDraft = !!edit && edit.status === 'draft';
  const setBody = (fn: (b: Body) => Body) => setEdit((e) => (e ? { ...e, body: fn(e.body) } : e));
  const codes = edit?.body.operations.map((o) => o.code).filter(Boolean) ?? [];

  const cellInput = (value: string | number, onChange: (v: string) => void, props: Record<string, unknown> = {}) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} disabled={!isDraft} style={{ width: '100%' }} {...props} />
  );
  const opSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!isDraft}>
      <option value="">—</option>
      {codes.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
  const prodSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!isDraft} style={{ maxWidth: 220 }}>
      <option value="">—</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.sku} — {p.name}
        </option>
      ))}
    </select>
  );
  const delBtn = (onClick: () => void) =>
    isDraft ? (
      <button className="btn btn-secondary" type="button" onClick={onClick}>
        ×
      </button>
    ) : null;
  const addBtn = (text: string, onClick: () => void) =>
    isDraft ? (
      <button className="btn btn-secondary" type="button" onClick={onClick} style={{ marginTop: 6 }}>
        + {text}
      </button>
    ) : null;

  return (
    <div data-testid="processes-page">
      <h2>{tx('تعريفات العمليات (الإصدارات)', 'Process definitions (versions)')}</h2>
      {error && <div className="error-text">{error}</div>}

      {!edit && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <select value={newProductId} onChange={(e) => setNewProductId(e.target.value)} data-testid="proc-new-product">
              <option value="">{tx('اختر الصنف المنتَج', 'Select the product it makes')}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!newProductId}
              data-testid="proc-new"
              onClick={() => {
                setEdit({ versionId: null, productId: newProductId, status: 'draft', versionNo: null, body: { ...emptyBody(), name: `${pname(newProductId)?.name ?? ''}` } });
                setNewProductId('');
              }}
            >
              {tx('عملية جديدة', 'New process')}
            </button>
          </div>
          {rows === null ? (
            <div className="empty-state">{loadingLabel()}</div>
          ) : rows.length === 0 ? (
            <div className="empty-state">{tx('لا توجد تعريفات عمليات بعد.', 'No process definitions yet.')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tx('الصنف', 'Product')}</th>
                  <th>{tx('الإصدار', 'Version')}</th>
                  <th>{tx('الاسم', 'Name')}</th>
                  <th>{tx('العمليات', 'Operations')}</th>
                  <th>{tx('الحالة', 'Status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`proc-row-${r.status}`}>
                    <td>
                      {r.productSku} — {r.productName}
                    </td>
                    <td>v{r.versionNo}</td>
                    <td>{r.name}</td>
                    <td>{r.operationCount}</td>
                    <td>{ar ? STATUS_AR[r.status] : r.status}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-secondary" type="button" onClick={() => openVersion(r.id)}>
                        {r.status === 'draft' ? tx('تعديل', 'Edit') : tx('عرض', 'View')}
                      </button>
                      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act(() => api.post(`/manufacturing/processes/${r.id}/clone`, {}))}>
                        {tx('نسخ كإصدار جديد', 'Clone')}
                      </button>
                      {r.status === 'draft' && (
                        <>
                          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act(() => api.post(`/manufacturing/processes/${r.id}/activate`, {}))}>
                            {tx('تفعيل', 'Activate')}
                          </button>
                          <button className="btn btn-danger" type="button" disabled={busy} onClick={() => act(() => api.delete(`/manufacturing/processes/${r.id}`))}>
                            {tx('حذف', 'Delete')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {edit && (
        <div className="card" data-testid="proc-editor">
          <h3 style={{ marginTop: 0 }}>
            {label(edit.productId)} {edit.versionNo ? `— v${edit.versionNo}` : ''} <span className="muted">({ar ? STATUS_AR[edit.status] : edit.status})</span>
          </h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input value={edit.body.name} onChange={(e) => setBody((b) => ({ ...b, name: e.target.value }))} disabled={!isDraft} placeholder={tx('اسم العملية', 'Process name')} style={{ minWidth: 260 }} data-testid="proc-name" />
            <input value={edit.body.note} onChange={(e) => setBody((b) => ({ ...b, note: e.target.value }))} disabled={!isDraft} placeholder={tx('ملاحظة', 'Note')} style={{ minWidth: 260 }} />
          </div>

          <h4>{tx('العمليات (عقد المخطط)', 'Operations (graph nodes)')}</h4>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tx('الرمز', 'Code')}</th>
                <th>{tx('الاسم', 'Name')}</th>
                <th>{tx('النوع', 'Type')}</th>
                <th>{tx('ترتيب', 'Seq')}</th>
                <th>{tx('اختيارية', 'Optional')}</th>
                <th>{tx('أقصى مرات', 'Max runs')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {edit.body.operations.map((o, i) => (
                <tr key={i}>
                  <td>{cellInput(o.code, (v) => setBody((b) => ({ ...b, operations: b.operations.map((x, j) => (j === i ? { ...x, code: v } : x)) })), { 'data-testid': `op-code-${i}` })}</td>
                  <td>{cellInput(o.name, (v) => setBody((b) => ({ ...b, operations: b.operations.map((x, j) => (j === i ? { ...x, name: v } : x)) })))}</td>
                  <td>
                    <select value={o.operationTypeCode} disabled={!isDraft} onChange={(e) => setBody((b) => ({ ...b, operations: b.operations.map((x, j) => (j === i ? { ...x, operationTypeCode: e.target.value } : x)) }))}>
                      {types
                        .filter((t) => t.active || t.code === o.operationTypeCode)
                        .map((t) => (
                          <option key={t.code} value={t.code}>
                            {ar ? t.nameAr : t.nameEn}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td style={{ width: 70 }}>{cellInput(o.sequenceNo, (v) => setBody((b) => ({ ...b, operations: b.operations.map((x, j) => (j === i ? { ...x, sequenceNo: Number(v) || 0 } : x)) })), { type: 'number' })}</td>
                  <td>
                    <input type="checkbox" checked={o.optional} disabled={!isDraft} onChange={(e) => setBody((b) => ({ ...b, operations: b.operations.map((x, j) => (j === i ? { ...x, optional: e.target.checked } : x)) }))} />
                  </td>
                  <td style={{ width: 70 }}>{cellInput(o.maxRuns, (v) => setBody((b) => ({ ...b, operations: b.operations.map((x, j) => (j === i ? { ...x, maxRuns: Number(v) || 1 } : x)) })), { type: 'number', min: 1 })}</td>
                  <td>{delBtn(() => setBody((b) => ({ ...b, operations: b.operations.filter((_, j) => j !== i) })))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {addBtn(tx('عملية', 'Operation'), () => setBody((b) => ({ ...b, operations: [...b.operations, { code: '', name: '', operationTypeCode: types.find((t) => t.active)?.code ?? 'transform', sequenceNo: (b.operations.length + 1) * 10, optional: false, maxRuns: 1 }] })))}

          <h4>{tx('الترتيب (من ← إلى). فرعان متوازيان = عمليتان بنفس السابقة؛ الدمج = عملية لها أكثر من سابقة', 'Order (from → to). Parallel branches = two operations after the same one; a join = an operation with several predecessors')}</h4>
          <table className="data-table">
            <tbody>
              {edit.body.edges.map((e, i) => (
                <tr key={i}>
                  <td>{opSelect(e.from, (v) => setBody((b) => ({ ...b, edges: b.edges.map((x, j) => (j === i ? { ...x, from: v } : x)) })))}</td>
                  <td>→</td>
                  <td>{opSelect(e.to, (v) => setBody((b) => ({ ...b, edges: b.edges.map((x, j) => (j === i ? { ...x, to: v } : x)) })))}</td>
                  <td>{delBtn(() => setBody((b) => ({ ...b, edges: b.edges.filter((_, j) => j !== i) })))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {addBtn(tx('ربط', 'Link'), () => setBody((b) => ({ ...b, edges: [...b.edges, { from: '', to: '' }] })))}

          <h4>{tx('المواد المستهلكة لكل عملية (مجموعة البدائل: نفس الاسم = اختيار واحد منها)', 'Inputs per operation (same alternate group = pick one)')}</h4>
          <table className="data-table">
            <tbody>
              {edit.body.inputs.map((x, i) => (
                <tr key={i}>
                  <td>{opSelect(x.operationCode, (v) => setBody((b) => ({ ...b, inputs: b.inputs.map((y, j) => (j === i ? { ...y, operationCode: v } : y)) })))}</td>
                  <td>{prodSelect(x.componentProductId, (v) => setBody((b) => ({ ...b, inputs: b.inputs.map((y, j) => (j === i ? { ...y, componentProductId: v } : y)) })))}</td>
                  <td style={{ width: 90 }}>{cellInput(x.quantityPerUnit, (v) => setBody((b) => ({ ...b, inputs: b.inputs.map((y, j) => (j === i ? { ...y, quantityPerUnit: Number(v) || 0 } : y)) })), { type: 'number', min: 1 })}</td>
                  <td style={{ width: 120 }}>{cellInput(x.alternateGroup, (v) => setBody((b) => ({ ...b, inputs: b.inputs.map((y, j) => (j === i ? { ...y, alternateGroup: v } : y)) })), { placeholder: tx('مجموعة بدائل', 'alt. group') })}</td>
                  <td>{delBtn(() => setBody((b) => ({ ...b, inputs: b.inputs.filter((_, j) => j !== i) })))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {addBtn(tx('مادة', 'Input'), () => setBody((b) => ({ ...b, inputs: [...b.inputs, { operationCode: '', componentProductId: '', quantityPerUnit: 1, alternateGroup: '' }] })))}

          <h4>{tx('المخرجات لكل عملية (وسيط = يُستهلك في عملية لاحقة؛ الوزن = حصته من التكلفة المجمّعة)', 'Outputs per operation (intermediate = consumed by a later operation; weight = share of the pooled cost)')}</h4>
          <table className="data-table">
            <tbody>
              {edit.body.outputs.map((x, i) => (
                <tr key={i}>
                  <td>{opSelect(x.operationCode, (v) => setBody((b) => ({ ...b, outputs: b.outputs.map((y, j) => (j === i ? { ...y, operationCode: v } : y)) })))}</td>
                  <td>{prodSelect(x.productId, (v) => setBody((b) => ({ ...b, outputs: b.outputs.map((y, j) => (j === i ? { ...y, productId: v } : y)) })))}</td>
                  <td style={{ width: 90 }}>{cellInput(x.quantityPerUnit, (v) => setBody((b) => ({ ...b, outputs: b.outputs.map((y, j) => (j === i ? { ...y, quantityPerUnit: Number(v) || 0 } : y)) })), { type: 'number', min: 1 })}</td>
                  <td>
                    <select value={x.role} disabled={!isDraft} onChange={(e) => setBody((b) => ({ ...b, outputs: b.outputs.map((y, j) => (j === i ? { ...y, role: e.target.value as Out['role'] } : y)) }))}>
                      {(['good', 'co_product', 'by_product'] as const).map((r) => (
                        <option key={r} value={r}>
                          {ar ? ROLE_AR[r] : r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label>
                      <input type="checkbox" checked={x.intermediate} disabled={!isDraft} onChange={(e) => setBody((b) => ({ ...b, outputs: b.outputs.map((y, j) => (j === i ? { ...y, intermediate: e.target.checked } : y)) }))} /> {tx('وسيط', 'intermediate')}
                    </label>
                  </td>
                  <td style={{ width: 80 }}>{cellInput(x.allocationWeight, (v) => setBody((b) => ({ ...b, outputs: b.outputs.map((y, j) => (j === i ? { ...y, allocationWeight: Number(v) || 0 } : y)) })), { type: 'number', min: 0, title: tx('الوزن', 'weight') })}</td>
                  <td>{delBtn(() => setBody((b) => ({ ...b, outputs: b.outputs.filter((_, j) => j !== i) })))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {addBtn(tx('مخرج', 'Output'), () => setBody((b) => ({ ...b, outputs: [...b.outputs, { operationCode: '', productId: '', quantityPerUnit: 1, role: 'good', intermediate: false, allocationWeight: 1 }] })))}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            {isDraft && (
              <button className="btn btn-primary" type="button" disabled={busy} onClick={save} data-testid="proc-save">
                {tx('حفظ المسودة', 'Save draft')}
              </button>
            )}
            {isDraft && edit.versionId && (
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy}
                data-testid="proc-activate"
                onClick={() =>
                  act(async () => {
                    await api.post(`/manufacturing/processes/${edit.versionId}/save`, payload(edit.body));
                    await api.post(`/manufacturing/processes/${edit.versionId}/activate`, {});
                    setEdit(null);
                  })
                }
              >
                {tx('حفظ وتفعيل', 'Save & activate')}
              </button>
            )}
            <button className="btn btn-secondary" type="button" onClick={() => setEdit(null)}>
              {tx('إغلاق', 'Close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
