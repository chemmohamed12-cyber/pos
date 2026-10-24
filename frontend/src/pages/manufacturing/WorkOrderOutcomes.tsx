import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
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

const CLASS_NAMES: Record<string, { ar: string; en: string }> = {
  good: { ar: 'مقبول', en: 'Good' },
  scrap: { ar: 'هالك', en: 'Scrap' },
  recovered: { ar: 'مسترد', en: 'Recovered' },
  rework: { ar: 'إعادة تشغيل', en: 'Rework' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  held: { ar: 'معلّق للجودة', en: 'Held' },
  co_product: { ar: 'ناتج مشترك', en: 'Co-product' },
  by_product: { ar: 'ناتج ثانوي', en: 'By-product' },
};
const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Manufacturing Engine S1 — production results by outcome class on a Work Order: scrap (components consumed at the pooled cost, value to the loss account, no stock),
 * recovery of salvaged material (capped by its scrap), and tracked rework / rejected / held units that must be resolved before the order closes.
 */
export function WorkOrderOutcomes({
  workOrderId,
  state,
  remainingPlanned,
  results,
  products,
  onChanged,
}: {
  workOrderId: string;
  state: string;
  remainingPlanned: number;
  results: WorkOrderResultRow[];
  products: Array<{ id: string; name: string }>;
  onChanged: () => void;
}) {
  const { lang } = useLanguage();
  const ar = lang === 'ar';
  const [scrapQty, setScrapQty] = useState('');
  const [scrapReason, setScrapReason] = useState('');
  const [rec, setRec] = useState({ sourceResultId: '', productId: '', quantity: '', value: '' });
  const [trk, setTrk] = useState({ outcomeClass: 'held', quantity: '', reason: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const label = (c: string) => CLASS_NAMES[c]?.[lang] ?? c;
  const scraps = results.filter((r) => r.outcomeClass === 'scrap');
  const canScrap = state === 'in_progress';
  const canTrack = state === 'in_progress' || state === 'on_hold';
  const canRecover = !['draft', 'cancelled'].includes(state) && scraps.length > 0;

  async function run(key: string, fn: () => Promise<unknown>, done: () => void) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      done();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: 20 }} data-testid="wo-outcomes">
      <h3 style={{ marginTop: 0 }}>{ar ? 'نتائج الإنتاج (هالك / استرداد / إعادة تشغيل / معلّق)' : 'Production results (scrap / recovery / rework / held)'}</h3>
      {error && <div className="error-text">{error}</div>}
      {results.length === 0 ? (
        <div className="empty-state" style={{ padding: 10 }}>{ar ? 'لا توجد نتائج مسجلة بعد.' : 'No results recorded yet.'}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{ar ? 'الفئة' : 'Class'}</th>
              <th>{ar ? 'الصنف' : 'Item'}</th>
              <th>{ar ? 'الكمية' : 'Qty'}</th>
              <th>{ar ? 'القيمة' : 'Value'}</th>
              <th>{ar ? 'السبب' : 'Reason'}</th>
              <th>{ar ? 'الحالة' : 'Status'}</th>
              <th>{ar ? 'التاريخ' : 'Date'}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const tracked = ['rework', 'rejected', 'held'].includes(r.outcomeClass);
              return (
                <tr key={r.id} data-testid={`wo-result-${r.outcomeClass}`}>
                  <td>{label(r.outcomeClass)}</td>
                  <td>{name(r.productId)}</td>
                  <td>{r.quantity}</td>
                  <td>{Number(r.valueBase).toFixed(2)}</td>
                  <td>{r.reason ?? (r.sourceResultId ? (ar ? 'من هالك' : 'from scrap') : '—')}</td>
                  <td>
                    {tracked ? (
                      r.resolvedAt ? (
                        `${ar ? 'حُسم' : 'resolved'}: ${r.resolution}`
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          {(['good', 'scrap', 'rework'] as const).map((res) => (
                            <button
                              key={res}
                              className="btn btn-secondary"
                              disabled={busy !== null}
                              onClick={() => run(`res-${r.id}`, () => api.post(`/manufacturing/work-orders/${workOrderId}/outcomes/${r.id}/resolve`, { resolution: res }), () => undefined)}
                            >
                              {label(res)}
                            </button>
                          ))}
                        </span>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{fmtDateTime(r.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {canScrap && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 14 }}>
          <strong>
            {ar ? 'تسجيل هالك' : 'Record scrap'} ({ar ? 'المتبقي من الخطة' : 'plan remaining'}: {remainingPlanned})
          </strong>
          <input type="number" min={1} max={remainingPlanned} style={{ width: 90 }} placeholder={ar ? 'الكمية' : 'Qty'} value={scrapQty} onChange={(e) => setScrapQty(e.target.value)} />
          <input style={{ minWidth: 220 }} placeholder={ar ? 'السبب (مطلوب)' : 'Reason (required)'} value={scrapReason} onChange={(e) => setScrapReason(e.target.value)} />
          <button
            className="btn btn-danger"
            data-testid="wo-scrap-submit"
            disabled={busy !== null || !Number(scrapQty) || scrapReason.trim().length < 3}
            onClick={() =>
              run(
                'scrap',
                () => api.post(`/manufacturing/work-orders/${workOrderId}/scrap`, { quantity: Number(scrapQty), reason: scrapReason.trim(), requestId: newRequestId() }),
                () => {
                  setScrapQty('');
                  setScrapReason('');
                },
              )
            }
          >
            {busy === 'scrap' ? '…' : ar ? 'تسجيل الهالك' : 'Record scrap'}
          </button>
        </div>
      )}

      {canRecover && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 14 }}>
          <strong>{ar ? 'استرداد خامة من هالك' : 'Recover material from scrap'}</strong>
          <select value={rec.sourceResultId} onChange={(e) => setRec({ ...rec, sourceResultId: e.target.value })}>
            <option value="">{ar ? 'اختر الهالك' : 'Select scrap'}</option>
            {scraps.map((s) => (
              <option key={s.id} value={s.id}>{`${s.quantity} — ${Number(s.valueBase).toFixed(2)}`}</option>
            ))}
          </select>
          <select value={rec.productId} onChange={(e) => setRec({ ...rec, productId: e.target.value })}>
            <option value="">{ar ? 'الصنف المسترد' : 'Recovered item'}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input type="number" min={1} style={{ width: 90 }} placeholder={ar ? 'الكمية' : 'Qty'} value={rec.quantity} onChange={(e) => setRec({ ...rec, quantity: e.target.value })} />
          <input type="number" min={0} step="0.0001" style={{ width: 110 }} placeholder={ar ? 'القيمة' : 'Value'} value={rec.value} onChange={(e) => setRec({ ...rec, value: e.target.value })} />
          <button
            className="btn btn-primary"
            data-testid="wo-recovery-submit"
            disabled={busy !== null || !rec.sourceResultId || !rec.productId || !Number(rec.quantity) || !Number(rec.value)}
            onClick={() =>
              run(
                'recovery',
                () => api.post(`/manufacturing/work-orders/${workOrderId}/recovery`, { sourceResultId: rec.sourceResultId, productId: rec.productId, quantity: Number(rec.quantity), valueBase: rec.value, requestId: newRequestId() }),
                () => setRec({ sourceResultId: '', productId: '', quantity: '', value: '' }),
              )
            }
          >
            {busy === 'recovery' ? '…' : ar ? 'تسجيل الاسترداد' : 'Record recovery'}
          </button>
        </div>
      )}

      {canTrack && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 14 }}>
          <strong>{ar ? 'تتبع وحدات (بلا أثر مخزني)' : 'Track units (no stock effect)'}</strong>
          <select value={trk.outcomeClass} onChange={(e) => setTrk({ ...trk, outcomeClass: e.target.value })}>
            {['held', 'rework', 'rejected'].map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
          <input type="number" min={1} style={{ width: 90 }} placeholder={ar ? 'الكمية' : 'Qty'} value={trk.quantity} onChange={(e) => setTrk({ ...trk, quantity: e.target.value })} />
          <input style={{ minWidth: 220 }} placeholder={ar ? 'السبب (مطلوب)' : 'Reason (required)'} value={trk.reason} onChange={(e) => setTrk({ ...trk, reason: e.target.value })} />
          <button
            className="btn btn-secondary"
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
            {busy === 'track' ? '…' : ar ? 'تسجيل' : 'Record'}
          </button>
        </div>
      )}
    </div>
  );
}
