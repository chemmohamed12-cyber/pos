import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { BlockedReason, DataTable, EmptyState, FormField } from '../../components/mfg';
import { fmtDateTime } from '../../lib/formatDateTime';

export interface WorkOrderResultRow {
  id: string;
  outcomeClass: string;
  productId: string;
  quantity: number;
  valueBase: string;
  reason: string | null;
  sourceResultId: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
}

const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Production results by outcome class on a Work Order (UX redesign stage 4 - presentation): scrap (components consumed at the pooled cost, value to the loss account, no stock), recovery of
 * salvaged material (capped by its scrap), and tracked rework / rejected / held units that must be resolved before the order closes. The forms appear only when the order state allows them.
 */
export function WorkOrderOutcomes({
  workOrderId,
  state,
  remainingPlanned,
  results,
  products,
  scrap,
  onChanged,
}: {
  workOrderId: string;
  state: string;
  remainingPlanned: number;
  results: WorkOrderResultRow[];
  products: Array<{ id: string; name: string }>;
  /** D6: the accounting pre-flight result - while it fails, scrap and recovery are blocked with its reason (and a link to fix it when the user may). */
  scrap: { ready: boolean; reason: string | null };
  onChanged: () => void;
}) {
  const { t } = useLanguage();
  const { can } = useAuth();
  const canRecord = can('manufacturing.work_order.outcome_record', 'editable');
  const canFixPolicy = can('accounting.account.edit', 'editable');
  const scrapBlocked = !scrap.ready;
  const [scrapQty, setScrapQty] = useState('');
  const [scrapReason, setScrapReason] = useState('');
  const [rec, setRec] = useState({ sourceResultId: '', productId: '', quantity: '', value: '' });
  const [trk, setTrk] = useState({ outcomeClass: 'held', quantity: '', reason: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const label = (c: string) => t(`mfg2.oc.${c}`);
  const scraps = results.filter((r) => r.outcomeClass === 'scrap');
  const canScrap = state === 'in_progress';
  const canTrack = state === 'in_progress' || state === 'on_hold';
  const canRecover = !['draft', 'cancelled'].includes(state) && scraps.length > 0;
  const scrapNum = Number(scrapQty);
  const scrapQtyError = scrapQty.trim() !== '' && (!Number.isInteger(scrapNum) || scrapNum < 1 || scrapNum > remainingPlanned) ? t('mfg2.oo.scrap_qty_invalid').split('{0}').join(String(remainingPlanned)) : null;

  async function run(key: string, fn: () => Promise<unknown>, done: () => void) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      done();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('mfg2.common.action_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" style={{ marginBlockStart: 20 }} data-testid="wo-outcomes" aria-labelledby="oo-title">
      <h2 id="oo-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
        {t('mfg2.oo.title')}
      </h2>
      <p className="mfg-note">{t('mfg2.oo.help')}</p>
      {error && <BlockedReason danger>{error}</BlockedReason>}
      <DataTable
        caption={t('mfg2.oo.table')}
        rows={results}
        rowKey={(r) => r.id}
        empty={<EmptyState title={t('mfg2.oo.empty')} />}
        columns={[
          { key: 'c', header: t('mfg2.oo.col.class'), render: (r) => <span data-testid={`wo-result-${r.outcomeClass}`}>{label(r.outcomeClass)}</span> },
          { key: 'i', header: t('mfg2.oo.col.item'), render: (r) => name(r.productId) },
          { key: 'q', header: t('mfg2.col.quantity'), align: 'end', render: (r) => r.quantity },
          { key: 'v', header: t('mfg2.oo.col.value'), align: 'end', render: (r) => Number(r.valueBase).toFixed(2) },
          { key: 'r', header: t('mfg2.px.reason'), render: (r) => r.reason ?? (r.sourceResultId ? t('mfg2.oo.from_scrap') : '—') },
          {
            key: 's',
            header: t('field.status'),
            render: (r) => {
              const tracked = ['rework', 'rejected', 'held'].includes(r.outcomeClass);
              if (!tracked) return '—';
              if (r.resolvedAt) return `${t('mfg2.oo.resolved')}: ${r.resolution ? label(r.resolution) : ''}`;
              return (
                <span className="mfg-row-actions">
                  <span className="mfg-note">{t('mfg2.oo.resolve_as')}</span>
                  {(['good', 'scrap', 'rework'] as const).map((res) => (
                    <button key={res} type="button" className="btn btn-secondary" disabled={busy !== null || !canRecord} onClick={() => run(`res-${r.id}`, () => api.post(`/manufacturing/work-orders/${workOrderId}/outcomes/${r.id}/resolve`, { resolution: res }), () => undefined)}>
                      {label(res)}
                    </button>
                  ))}
                </span>
              );
            },
          },
          { key: 'd', header: t('field.created_at'), render: (r) => fmtDateTime(r.createdAt) },
        ]}
      />

      {canScrap && canRecord && (
        <fieldset className="mfg-fieldset" style={{ marginBlockStart: 16 }}>
          <legend>{t('mfg2.oo.scrap.title')}</legend>
          <p className="mfg-note" style={{ marginBlockStart: 0 }}>
            {t('mfg2.oo.scrap.help')}
          </p>
          {scrapBlocked && (
            <div style={{ marginBlockEnd: 10 }} data-testid="scrap-blocked">
              <BlockedReason danger to="/accounting/policy" linkText={canFixPolicy ? t('mfg2.oo.scrap.fix_link') : undefined}>
                {scrap.reason}
              </BlockedReason>
            </div>
          )}
          <div className="mfg-grid cols-3">
            <FormField label={t('mfg2.col.quantity')} hint={t('mfg2.oo.scrap.remaining').split('{0}').join(String(remainingPlanned))} error={scrapQtyError}>
              {(p) => <input {...p} type="number" min={1} max={remainingPlanned} step={1} value={scrapQty} onChange={(e) => setScrapQty(e.target.value)} />}
            </FormField>
            <FormField label={t('mfg2.px.reason')} hint={t('mfg2.px.reason_hint')} required>
              {(p) => <input {...p} value={scrapReason} onChange={(e) => setScrapReason(e.target.value)} />}
            </FormField>
          </div>
          <button
            className="btn btn-danger"
            type="button"
            data-testid="wo-scrap-submit"
            disabled={busy !== null || scrapBlocked || !scrapNum || !!scrapQtyError || scrapReason.trim().length < 3}
            onClick={() =>
              run(
                'scrap',
                () => api.post(`/manufacturing/work-orders/${workOrderId}/scrap`, { quantity: scrapNum, reason: scrapReason.trim(), requestId: newRequestId() }),
                () => {
                  setScrapQty('');
                  setScrapReason('');
                },
              )
            }
          >
            {busy === 'scrap' ? t('mfg2.common.working') : t('mfg2.oo.scrap.cta')}
          </button>
        </fieldset>
      )}

      {canRecover && canRecord && (
        <fieldset className="mfg-fieldset" style={{ marginBlockStart: 16 }}>
          <legend>{t('mfg2.oo.recover.title')}</legend>
          <p className="mfg-note" style={{ marginBlockStart: 0 }}>
            {t('mfg2.oo.recover.help')}
          </p>
          <div className="mfg-grid cols-2">
            <FormField label={t('mfg2.oo.recover.source')} required>
              {(p) => (
                <select {...p} value={rec.sourceResultId} onChange={(e) => setRec({ ...rec, sourceResultId: e.target.value })}>
                  <option value="">{t('mfg2.common.choose')}</option>
                  {scraps.map((s) => (
                    <option key={s.id} value={s.id}>{`${s.quantity} — ${Number(s.valueBase).toFixed(2)}`}</option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label={t('mfg2.oo.recover.item')} required>
              {(p) => (
                <select {...p} value={rec.productId} onChange={(e) => setRec({ ...rec, productId: e.target.value })}>
                  <option value="">{t('mfg2.common.choose')}</option>
                  {products.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label={t('mfg2.col.quantity')} required>
              {(p) => <input {...p} type="number" min={1} step={1} value={rec.quantity} onChange={(e) => setRec({ ...rec, quantity: e.target.value })} />}
            </FormField>
            <FormField label={t('mfg2.oo.recover.value')} hint={t('mfg2.oo.recover.value_hint')} required>
              {(p) => <input {...p} type="number" min={0} step="0.0001" value={rec.value} onChange={(e) => setRec({ ...rec, value: e.target.value })} />}
            </FormField>
          </div>
          <button
            className="btn btn-primary"
            type="button"
            data-testid="wo-recovery-submit"
            disabled={busy !== null || scrapBlocked || !rec.sourceResultId || !rec.productId || !Number(rec.quantity) || !Number(rec.value)}
            onClick={() =>
              run(
                'recovery',
                () => api.post(`/manufacturing/work-orders/${workOrderId}/recovery`, { sourceResultId: rec.sourceResultId, productId: rec.productId, quantity: Number(rec.quantity), valueBase: rec.value, requestId: newRequestId() }),
                () => setRec({ sourceResultId: '', productId: '', quantity: '', value: '' }),
              )
            }
          >
            {busy === 'recovery' ? t('mfg2.common.working') : t('mfg2.oo.recover.cta')}
          </button>
        </fieldset>
      )}

      {canTrack && canRecord && (
        <fieldset className="mfg-fieldset" style={{ marginBlockStart: 16 }}>
          <legend>{t('mfg2.oo.track.title')}</legend>
          <p className="mfg-note" style={{ marginBlockStart: 0 }}>
            {t('mfg2.oo.track.help')}
          </p>
          <div className="mfg-grid cols-3">
            <FormField label={t('mfg2.oo.col.class')}>
              {(p) => (
                <select {...p} value={trk.outcomeClass} onChange={(e) => setTrk({ ...trk, outcomeClass: e.target.value })}>
                  {['held', 'rework', 'rejected'].map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label={t('mfg2.col.quantity')}>{(p) => <input {...p} type="number" min={1} step={1} value={trk.quantity} onChange={(e) => setTrk({ ...trk, quantity: e.target.value })} />}</FormField>
            <FormField label={t('mfg2.px.reason')} hint={t('mfg2.px.reason_hint')} required>
              {(p) => <input {...p} value={trk.reason} onChange={(e) => setTrk({ ...trk, reason: e.target.value })} />}
            </FormField>
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            data-testid="wo-track-submit"
            disabled={busy !== null || !Number(trk.quantity) || trk.reason.trim().length < 3}
            onClick={() =>
              run(
                'track',
                () => api.post(`/manufacturing/work-orders/${workOrderId}/outcomes`, { outcomeClass: trk.outcomeClass, quantity: Number(trk.quantity), reason: trk.reason.trim(), requestId: newRequestId() }),
                () => setTrk({ outcomeClass: trk.outcomeClass, quantity: '', reason: '' }),
              )
            }
          >
            {busy === 'track' ? t('mfg2.common.working') : t('mfg2.oo.track.cta')}
          </button>
        </fieldset>
      )}
    </section>
  );
}
