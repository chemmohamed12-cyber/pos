import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';

interface Flow {
  productId: string;
  sku: string | null;
  quantity: number;
  valueBase: string;
}
interface OpRow {
  code: string;
  name: string;
  kind: string | null;
  optional: boolean;
  maxRuns: number;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'skipped';
  blockedBy: string[];
  runs: number;
  consumed: Flow[];
  yielded: Flow[];
  wipValueBase: string;
  outcomes: Array<{ outcomeClass: string; quantity: number }>;
  plan: { inputs: Array<{ productId: string; sku: string | null; quantity: number }>; outputs: Array<{ productId: string; sku: string | null; quantity: number; intermediate: boolean }> };
}
interface Run {
  id: string;
  operationCode: string;
  runNo: number;
  status: string;
}
interface Execution {
  version: { versionNo: number };
  operations: OpRow[];
  runs: Run[];
  intermediateOnHand: Flow[];
  totals: { rawConsumedValueBase: string; operationWipValueBase: string; intermediateOnHandValueBase: string };
}

const STATUS_AR: Record<string, string> = { pending: 'بانتظار السابق', ready: 'جاهزة', running: 'قيد التنفيذ', completed: 'مكتملة', skipped: 'متخطاة' };
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Manufacturing Engine S4/S5 - the process view of a process-bound Work Order: graph-gated operations (start / skip), per-run material consumption, yields, scrap and quality
 * outcomes, the derived per-operation ledger (quantity + material value) and the multi-output receipt. Physical issue / scrap / close stay on the order's own actions.
 */
export function ProcessExecutionPanel({ workOrderId, state, remainingPlanned, onChanged }: { workOrderId: string; state: string; remainingPlanned: number; onChanged: () => void }) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const tx = (a: string, e: string) => (ar ? a : e);
  const [ex, setEx] = useState<Execution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // run id whose forms are open
  const [form, setForm] = useState({ productId: '', quantity: '', reason: '' });
  const [units, setUnits] = useState('');

  const load = useCallback(async () => {
    try {
      setEx(await api.get<Execution>(`/manufacturing/process-orders/${workOrderId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    }
  }, [workOrderId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }
  const base = `/manufacturing/process-orders/${workOrderId}`;
  const live = state === 'in_progress';
  const runningRun = (code: string) => ex?.runs.find((r) => r.operationCode === code && r.status === 'running');
  const fmt = (f: Flow[]) => f.map((x) => `${x.sku ?? x.productId.slice(0, 6)} ×${x.quantity} (${Number(x.valueBase).toFixed(2)})`).join(' · ') || '—';

  if (!ex) return error ? <div className="error-text">{error}</div> : null;
  return (
    <div className="card" style={{ marginTop: 20 }} data-testid="process-panel">
      <h3 style={{ marginTop: 0 }}>
        {tx('تنفيذ العملية', 'Process execution')} <span className="muted">(v{ex.version.versionNo})</span>
      </h3>
      {error && <div className="error-text">{error}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>{tx('العملية', 'Operation')}</th>
            <th>{tx('الحالة', 'Status')}</th>
            <th>{tx('المستهلك', 'Consumed')}</th>
            <th>{tx('المنتَج', 'Yielded')}</th>
            <th>{tx('قيمة داخل العملية', 'WIP inside')}</th>
            <th>{tx('نتائج', 'Outcomes')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ex.operations.map((o) => {
            const run = runningRun(o.code);
            return (
              <tr key={o.code} data-testid={`op-${o.code}`}>
                <td>
                  <strong>{o.code}</strong> {o.name} {o.optional && <span className="muted">({tx('اختيارية', 'optional')})</span>}
                  {o.blockedBy.length > 0 && o.status === 'pending' && <div className="muted">{tx('ينتظر', 'waits for')}: {o.blockedBy.join(', ')}</div>}
                </td>
                <td data-testid={`op-status-${o.code}`}>{ar ? STATUS_AR[o.status] : o.status} {o.maxRuns > 1 ? `(${o.runs}/${o.maxRuns})` : ''}</td>
                <td>{fmt(o.consumed)}</td>
                <td>{fmt(o.yielded)}</td>
                <td>{Number(o.wipValueBase).toFixed(2)}</td>
                <td>{o.outcomes.map((x) => `${x.outcomeClass}:${x.quantity}`).join(' ') || '—'}</td>
                <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {live && !run && (o.status === 'ready' || (o.status === 'completed' && o.runs < o.maxRuns)) && (
                    <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act(() => api.post(`${base}/operations/${o.code}/start`, { requestId: newId() }))} data-testid={`op-start-${o.code}`}>
                      {tx('بدء', 'Start')}
                    </button>
                  )}
                  {live && o.optional && o.status === 'ready' && o.runs === 0 && (
                    <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act(() => api.post(`${base}/operations/${o.code}/skip`, { requestId: newId() }))}>
                      {tx('تخطي', 'Skip')}
                    </button>
                  )}
                  {run && (
                    <>
                      <button className="btn btn-secondary" type="button" onClick={() => setOpen(open === run.id ? null : run.id)} data-testid={`op-open-${o.code}`}>
                        {tx('تسجيل', 'Record')}
                      </button>
                      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act(() => api.post(`${base}/runs/${run.id}/complete`, {}))} data-testid={`op-complete-${o.code}`}>
                        {tx('إنهاء', 'Complete')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ex.operations.map((o) => {
        const run = runningRun(o.code);
        if (!run || open !== run.id) return null;
        const post = (path: string, body: object) => act(async () => {
          await api.post(`${base}/runs/${run.id}/${path}`, { ...body, requestId: newId() });
          setForm({ productId: '', quantity: '', reason: '' });
        });
        return (
          <div key={run.id} style={{ marginTop: 12, padding: 10, border: '1px solid var(--border, #ddd)', borderRadius: 6 }} data-testid={`run-forms-${o.code}`}>
            <strong>{o.code} — {tx('تشغيلة', 'run')} {run.runNo}</strong>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
              <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} data-testid="run-product">
                <option value="">{tx('اختر الصنف', 'Select item')}</option>
                {o.plan.inputs.map((i) => (
                  <option key={`in-${i.productId}`} value={i.productId}>
                    {tx('مادة', 'in')}: {i.sku} ({i.quantity})
                  </option>
                ))}
                {o.plan.outputs.map((x) => (
                  <option key={`out-${x.productId}`} value={x.productId}>
                    {tx('ناتج', 'out')}: {x.sku} ({x.quantity})
                  </option>
                ))}
              </select>
              <input type="number" min={1} placeholder={tx('الكمية', 'Qty')} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} style={{ width: 90 }} data-testid="run-qty" />
              <button className="btn btn-secondary" type="button" disabled={busy || !form.productId || !Number(form.quantity)} onClick={() => post('consume', { productId: form.productId, quantity: Number(form.quantity) })} data-testid="run-consume">
                {tx('استهلاك مادة', 'Consume')}
              </button>
              <button className="btn btn-secondary" type="button" disabled={busy || !form.productId || !Number(form.quantity)} onClick={() => post('yield', { productId: form.productId, quantity: Number(form.quantity) })} data-testid="run-yield">
                {tx('تسجيل ناتج', 'Yield')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
              <input placeholder={tx('السبب', 'Reason')} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} style={{ minWidth: 220 }} data-testid="run-reason" />
              <button className="btn btn-danger" type="button" disabled={busy || !Number(form.quantity) || form.reason.trim().length < 3} onClick={() => post('scrap', { quantity: Number(form.quantity), reason: form.reason.trim() })} data-testid="run-scrap">
                {tx('هالك في العملية', 'Scrap here')}
              </button>
              {(['held', 'rework', 'rejected'] as const).map((c) => (
                <button key={c} className="btn btn-secondary" type="button" disabled={busy || !Number(form.quantity) || form.reason.trim().length < 3} onClick={() => post('outcome', { outcomeClass: c, quantity: Number(form.quantity), reason: form.reason.trim() })} data-testid={`run-outcome-${c}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 12 }} className="muted" data-testid="process-totals">
        {tx('مواد مستهلكة', 'Raw consumed')}: {Number(ex.totals.rawConsumedValueBase).toFixed(2)} · {tx('داخل العمليات', 'inside operations')}: {Number(ex.totals.operationWipValueBase).toFixed(2)} · {tx('وسيط جاهز', 'intermediate on hand')}: {Number(ex.totals.intermediateOnHandValueBase).toFixed(2)}
        {ex.intermediateOnHand.length > 0 && <> — {fmt(ex.intermediateOnHand)}</>}
      </div>
      {live && remainingPlanned > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
          <strong>{tx('استلام المخرجات النهائية (توزيع التكلفة بالأوزان)', 'Receive final outputs (cost shared by weight)')}</strong>
          <input type="number" min={1} max={remainingPlanned} placeholder={tx('عدد الوحدات المخططة', 'Plan units')} value={units} onChange={(e) => setUnits(e.target.value)} style={{ width: 150 }} data-testid="po-units" />
          <button className="btn btn-primary" type="button" disabled={busy || !Number(units)} onClick={() => act(async () => { await api.post(`${base}/output`, { units: Number(units), requestId: newId() }); setUnits(''); })} data-testid="po-receive">
            {tx('استلام', 'Receive')}
          </button>
        </div>
      )}
    </div>
  );
}
