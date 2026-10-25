import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, FormField, StatusChip, type Tone } from '../../components/mfg';

export interface Flow {
  productId: string;
  sku: string | null;
  quantity: number;
  valueBase: string;
}
export interface OpRow {
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
export interface Run {
  id: string;
  operationCode: string;
  runNo: number;
  status: string;
}
export interface Execution {
  version: { versionNo: number };
  operations: OpRow[];
  runs: Run[];
  intermediateOnHand: Flow[];
  totals: { rawConsumedValueBase: string; operationWipValueBase: string; intermediateOnHandValueBase: string };
}

const TONE: Record<string, Tone> = { pending: 'neutral', ready: 'info', running: 'warning', completed: 'success', skipped: 'neutral' };
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * The process view of a process-bound Work Order (UX redesign stage 4): graph-gated operations with a status that says what each one is waiting for, controls shown ONLY when the order and the
 * operation permit them, SEPARATE material and output selectors for a run, outcomes, the derived per-operation ledger and the ONE receipt path for this kind of order - the multi-output receipt.
 * The execution data is owned by the order screen (it also feeds the "next step" card); every change reloads it through `onChanged`.
 */
export function ProcessExecutionPanel({ workOrderId, state, planned, remainingPlanned, ex, onChanged }: { workOrderId: string; state: string; planned: number; remainingPlanned: number; ex: Execution; onChanged: () => void }) {
  const { t } = useLanguage();
  const { can } = useAuth();
  const canRun = can('manufacturing.work_order.operation_execute', 'editable');
  const canReceive = can('manufacturing.work_order.finished_goods_receive', 'editable');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // run id whose forms are open
  const [material, setMaterial] = useState({ productId: '', quantity: '' });
  const [out, setOut] = useState({ productId: '', quantity: '' });
  const [loss, setLoss] = useState({ quantity: '', reason: '' });
  const [units, setUnits] = useState('');

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setBusy(false);
    }
  }
  const base = `/manufacturing/process-orders/${workOrderId}`;
  const live = state === 'in_progress';
  const runningRun = (code: string) => ex.runs.find((r) => r.operationCode === code && r.status === 'running');
  const fmt = (f: Flow[]) => f.map((x) => `${x.sku ?? x.productId.slice(0, 6)} ×${x.quantity} (${Number(x.valueBase).toFixed(2)})`).join(' · ') || '—';
  const reset = () => {
    setMaterial({ productId: '', quantity: '' });
    setOut({ productId: '', quantity: '' });
    setLoss({ quantity: '', reason: '' });
  };
  const finals = ex.operations.flatMap((o) => o.plan.outputs.filter((x) => !x.intermediate));
  const unitsNum = Number(units);
  const unitsError = units.trim() !== '' && (!Number.isInteger(unitsNum) || unitsNum < 1 || unitsNum > remainingPlanned) ? fillRemaining(t('mfg2.px.units_invalid'), remainingPlanned) : null;

  return (
    <section className="card" style={{ marginBlockStart: 20 }} data-testid="process-panel" aria-labelledby="px-title">
      <h2 id="px-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
        {t('mfg2.px.title')} <span className="mfg-note">(v{ex.version.versionNo})</span>
      </h2>
      <p className="mfg-note">{live ? t('mfg2.px.help_live') : t('mfg2.px.help_idle')}</p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      <DataTable
        caption={t('mfg2.px.table')}
        rows={ex.operations}
        rowKey={(o) => o.code}
        columns={[
          {
            key: 'op',
            header: t('mfg.field.operation'),
            render: (o) => (
              <span data-testid={`op-${o.code}`}>
                <strong>{o.code}</strong> {o.name} {o.optional && <StatusChip>{t('mfg2.pe.flag.optional')}</StatusChip>} {o.maxRuns > 1 && <small>({o.runs}/{o.maxRuns})</small>}
                {o.status === 'pending' && o.blockedBy.length > 0 && (
                  <div className="mfg-note">
                    {t('mfg2.px.waits_for')}: {o.blockedBy.join(', ')}
                  </div>
                )}
              </span>
            ),
          },
          { key: 's', header: t('field.status'), render: (o) => <span data-testid={`op-status-${o.code}`}><StatusChip tone={TONE[o.status]}>{t(`mfg2.px.status.${o.status}`)}</StatusChip></span> },
          { key: 'c', header: t('mfg2.px.consumed'), render: (o) => fmt(o.consumed) },
          { key: 'y', header: t('mfg2.px.yielded'), render: (o) => fmt(o.yielded) },
          { key: 'w', header: t('mfg2.px.wip_inside'), align: 'end', render: (o) => Number(o.wipValueBase).toFixed(2) },
          { key: 'oc', header: t('mfg2.px.outcomes'), render: (o) => o.outcomes.map((x) => `${t(`mfg2.oc.${x.outcomeClass}`)}: ${x.quantity}`).join(' · ') || '—' },
          {
            key: 'a',
            header: t('field.actions'),
            render: (o) => {
              const run = runningRun(o.code);
              if (!canRun) return null;
              return (
                <span className="mfg-row-actions">
                  {live && !run && (o.status === 'ready' || (o.status === 'completed' && o.runs < o.maxRuns)) && (
                    <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act(() => api.post(`${base}/operations/${o.code}/start`, { requestId: newId() }))} data-testid={`op-start-${o.code}`}>
                      {t('mfg2.px.start')}
                    </button>
                  )}
                  {live && o.optional && o.status === 'ready' && o.runs === 0 && (
                    <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => act(() => api.post(`${base}/operations/${o.code}/skip`, { requestId: newId() }))}>
                      {t('mfg2.px.skip')}
                    </button>
                  )}
                  {run && (
                    <>
                      <button className="btn btn-secondary" type="button" aria-expanded={open === run.id} onClick={() => { setOpen(open === run.id ? null : run.id); reset(); }} data-testid={`op-open-${o.code}`}>
                        {t('mfg2.px.record')}
                      </button>
                      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => act(() => api.post(`${base}/runs/${run.id}/complete`, {}))} data-testid={`op-complete-${o.code}`}>
                        {t('mfg2.px.complete_run')}
                      </button>
                    </>
                  )}
                </span>
              );
            },
          },
        ]}
      />

      {ex.operations.map((o) => {
        const run = runningRun(o.code);
        if (!run || open !== run.id) return null;
        const post = (path: string, body: object) =>
          act(async () => {
            await api.post(`${base}/runs/${run.id}/${path}`, { ...body, requestId: newId() });
            reset();
          });
        const lossOk = Number(loss.quantity) > 0 && loss.reason.trim().length >= 3;
        return (
          <div key={run.id} className="mfg-run" data-testid={`run-forms-${o.code}`} role="group" aria-label={`${o.code} — ${t('mfg2.px.run')} ${run.runNo}`}>
            <strong>
              {o.code} — {t('mfg2.px.run')} {run.runNo}
            </strong>
            <div className="mfg-grid cols-3" style={{ marginBlockStart: 10 }}>
              <fieldset className="mfg-fieldset">
                <legend>{t('mfg2.px.materials')}</legend>
                <FormField label={t('mfg2.px.material')} hint={t('mfg2.px.material_hint')}>
                  {(p) => (
                    <select {...p} value={material.productId} onChange={(e) => setMaterial({ ...material, productId: e.target.value })} data-testid="run-product">
                      <option value="">{t('mfg2.common.choose')}</option>
                      {o.plan.inputs.map((i) => (
                        <option key={i.productId} value={i.productId}>
                          {i.sku} ({i.quantity})
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <FormField label={t('mfg2.col.quantity')}>{(p) => <input {...p} type="number" min={1} step={1} value={material.quantity} onChange={(e) => setMaterial({ ...material, quantity: e.target.value })} data-testid="run-qty" />}</FormField>
                <button className="btn btn-secondary" type="button" disabled={busy || !material.productId || !Number(material.quantity)} onClick={() => post('consume', { productId: material.productId, quantity: Number(material.quantity) })} data-testid="run-consume">
                  {t('mfg2.px.consume')}
                </button>
              </fieldset>
              <fieldset className="mfg-fieldset">
                <legend>{t('mfg2.px.outputs')}</legend>
                <FormField label={t('mfg2.px.output')} hint={t('mfg2.px.output_hint')}>
                  {(p) => (
                    <select {...p} value={out.productId} onChange={(e) => setOut({ ...out, productId: e.target.value })} data-testid="run-out-product">
                      <option value="">{t('mfg2.common.choose')}</option>
                      {o.plan.outputs.map((x) => (
                        <option key={x.productId} value={x.productId}>
                          {x.sku} ({x.quantity}) — {x.intermediate ? t('mfg2.pe.out.intermediate') : t('mfg2.pe.out.final')}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <FormField label={t('mfg2.col.quantity')}>{(p) => <input {...p} type="number" min={1} step={1} value={out.quantity} onChange={(e) => setOut({ ...out, quantity: e.target.value })} data-testid="run-out-qty" />}</FormField>
                <button className="btn btn-secondary" type="button" disabled={busy || !out.productId || !Number(out.quantity)} onClick={() => post('yield', { productId: out.productId, quantity: Number(out.quantity) })} data-testid="run-yield">
                  {t('mfg2.px.yield')}
                </button>
              </fieldset>
              <fieldset className="mfg-fieldset">
                <legend>{t('mfg2.px.losses')}</legend>
                <FormField label={t('mfg2.col.quantity')}>{(p) => <input {...p} type="number" min={1} step={1} value={loss.quantity} onChange={(e) => setLoss({ ...loss, quantity: e.target.value })} data-testid="run-loss-qty" />}</FormField>
                <FormField label={t('mfg2.px.reason')} hint={t('mfg2.px.reason_hint')}>{(p) => <input {...p} value={loss.reason} onChange={(e) => setLoss({ ...loss, reason: e.target.value })} data-testid="run-reason" />}</FormField>
                <div className="mfg-row-actions">
                  <button className="btn btn-danger" type="button" disabled={busy || !lossOk} onClick={() => post('scrap', { quantity: Number(loss.quantity), reason: loss.reason.trim() })} data-testid="run-scrap">
                    {t('mfg2.px.scrap_here')}
                  </button>
                  {(['held', 'rework', 'rejected'] as const).map((c) => (
                    <button key={c} className="btn btn-secondary" type="button" disabled={busy || !lossOk} onClick={() => post('outcome', { outcomeClass: c, quantity: Number(loss.quantity), reason: loss.reason.trim() })} data-testid={`run-outcome-${c}`}>
                      {t(`mfg2.oc.${c}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
        );
      })}

      <p className="mfg-note" data-testid="process-totals">
        {t('mfg2.px.totals.raw')}: <strong>{Number(ex.totals.rawConsumedValueBase).toFixed(2)}</strong> · {t('mfg2.px.totals.inside')}: <strong>{Number(ex.totals.operationWipValueBase).toFixed(2)}</strong> · {t('mfg2.px.totals.intermediate')}: <strong>{Number(ex.totals.intermediateOnHandValueBase).toFixed(2)}</strong>
        {ex.intermediateOnHand.length > 0 && <> — {fmt(ex.intermediateOnHand)}</>}
      </p>

      {live && canReceive && (
        <div className="mfg-run" data-testid="process-receipt">
          <strong>{t('mfg2.px.receive.title')}</strong>
          <p className="mfg-note" style={{ marginBlockStart: 4 }}>
            {t('mfg2.px.receive.help')}
          </p>
          {remainingPlanned > 0 ? (
            <>
              <div style={{ maxInlineSize: 280 }}>
                <FormField label={t('mfg2.px.receive.units')} hint={fillRemaining(t('mfg2.px.receive.units_hint'), remainingPlanned)} error={unitsError}>
                  {(p) => <input {...p} type="number" min={1} max={remainingPlanned} step={1} value={units} onChange={(e) => setUnits(e.target.value)} data-testid="po-units" />}
                </FormField>
              </div>
              {unitsNum > 0 && !unitsError && finals.length > 0 && (
                <p className="mfg-note" aria-live="polite">
                  {t('mfg2.px.receive.will')}: {finals.map((x) => `${x.sku} ×${Math.round((x.quantity / Math.max(1, planned)) * unitsNum)}`).join(' · ')}
                </p>
              )}
              <button className="btn btn-primary" type="button" disabled={busy || !unitsNum || !!unitsError} onClick={() => act(async () => { await api.post(`${base}/output`, { units: unitsNum, requestId: newId() }); setUnits(''); })} data-testid="po-receive">
                {t('mfg2.px.receive.cta')}
              </button>
            </>
          ) : (
            <span className="mfg-note">{t('mfg2.px.receive.none_left')}</span>
          )}
        </div>
      )}
    </section>
  );
}

const fillRemaining = (text: string, n: number) => text.split('{0}').join(String(n));
