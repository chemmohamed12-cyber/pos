import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { fmtDateTime } from '../../lib/formatDateTime';
import { money, useTr } from '../treasury/treasuryUi';
import {
  canRecordCollection,
  collectionDecisionOptions,
  expenseNeedsApproval,
  expenseReadyToPost,
  newClientKey,
  type WsCollection,
  type WsCollectionTotals,
  type WsExpense,
  type WsHandover,
  type WsLineProgress,
  type WsReconciliation,
  type WsShipment,
} from './workspaceModel';

/**
 * Vehicle Driver Workspace, Stage C / C5 - the screens for the custody workflow. Every figure shown here was computed by the server (collection totals, line progress, the
 * reconciliation); the browser only displays them and sends the user's actions. Each submit carries a client idempotency key generated when the form opens, so a retry after a
 * dropped connection cannot record the same cash, claim or handover twice. The server re-validates permission, ownership and the maker != checker rule on every call.
 */

function useAction() {
  const tr = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void) => {
      if (lock.current) return; // a second tap while the first request is in flight is ignored
      lock.current = true;
      setBusy(true);
      setError(null);
      try {
        await fn();
        after?.();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : tr('تعذّر تنفيذ الإجراء. حاول مرة أخرى.', 'The action failed. Please try again.'));
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [tr],
  );
  return { busy, error, run };
}

const VERIFY_LABEL: Record<string, [string, string, string]> = {
  recorded: ['مسجل من السائق', 'Recorded by the driver', 'warn'],
  confirmed: ['مؤكد', 'Confirmed', 'ok'],
  rejected: ['مرفوض', 'Rejected', 'bad'],
};

export function CollectionsPanel(props: {
  shipment: WsShipment;
  /** undefined = not visible to this user. */
  collections: WsCollection[] | null | undefined;
  totals: WsCollectionTotals | null | undefined;
  canRecord: boolean;
  canDecide: boolean;
  userId: string | undefined;
  onChanged: () => void;
}) {
  const tr = useTr();
  const { busy, error, run } = useAction();
  const [amount, setAmount] = useState('');
  const keyRef = useRef(newClientKey());
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const s = props.shipment;

  if (props.collections === undefined) return <div className="vw-na">{tr('سجل التحصيل غير متاح لصلاحياتك', 'The collection record is not available for your role')}</div>;
  const list = props.collections ?? [];
  const cod = s.codAmount;
  const may = props.canRecord && canRecordCollection(cod, props.totals) && s.state === 'out_for_delivery';

  return (
    <div>
      {props.totals && props.totals.expected !== null && (
        <dl className="vw-kv">
          <div>
            <dt>{tr('المطلوب تحصيله', 'Expected')}</dt>
            <dd dir="ltr">{money(props.totals.expected)}</dd>
          </div>
          <div>
            <dt>{tr('المحتسب (مسجل + مؤكد)', 'Counted (recorded + confirmed)')}</dt>
            <dd dir="ltr">{money(props.totals.counted)}</dd>
          </div>
          <div>
            <dt>{tr('المتبقي', 'Remaining')}</dt>
            <dd dir="ltr">{props.totals.remaining === null ? '—' : money(props.totals.remaining)}</dd>
          </div>
        </dl>
      )}
      {list.length === 0 ? (
        <div className="vw-empty">{cod ? tr('لم يُسجل تحصيل لهذه الشحنة بعد.', 'No collection has been recorded for this shipment yet.') : tr('لا يوجد تحصيل عند التسليم لهذه الشحنة.', 'This shipment has no cash on delivery.')}</div>
      ) : (
        <ul className="vw-lines">
          {list.map((c) => {
            const v = VERIFY_LABEL[c.verificationStatus ?? 'recorded'];
            const options = collectionDecisionOptions(c, props.canDecide, c.collectorUserId === props.userId);
            return (
              <li key={c.id} className="vw-line">
                <div className="vw-line-name" dir="ltr">
                  {money(c.amount)} · {c.method}
                </div>
                <span className={`vw-chip ${v[2]}`}>{tr(v[0], v[1])}</span>{' '}
                <span className={`vw-chip ${c.remittanceStatus === 'remitted' ? 'ok' : 'muted'}`}>{c.remittanceStatus === 'remitted' ? tr('تم التوريد', 'Remitted') : tr('بانتظار التوريد', 'Awaiting remittance')}</span>
                <div className="vw-note">{fmtDateTime(c.occurredAt)}</div>
                {c.rejectionReason && <div className="vw-note">{tr('سبب الرفض: ', 'Rejection reason: ')}{c.rejectionReason}</div>}
                {options.length > 0 && rejectFor !== c.id && (
                  <div className="vw-confirm-buttons">
                    <button type="button" className="vw-btn vw-btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/delivery/collections/${c.id}/confirm`, {}), props.onChanged)}>
                      {tr('تأكيد استلام المبلغ', 'Confirm receipt')}
                    </button>
                    <button type="button" className="vw-btn vw-btn-danger" disabled={busy} onClick={() => setRejectFor(c.id)}>
                      {tr('رفض', 'Reject')}
                    </button>
                  </div>
                )}
                {rejectFor === c.id && (
                  <div className="vw-confirm">
                    <input className="vw-input" value={why} maxLength={255} onChange={(e) => setWhy(e.target.value)} placeholder={tr('سبب الرفض (إلزامي)', 'Rejection reason (required)')} aria-label={tr('سبب الرفض', 'Rejection reason')} />
                    <div className="vw-confirm-buttons">
                      <button
                        type="button"
                        className="vw-btn vw-btn-danger"
                        disabled={busy || why.trim().length < 3}
                        onClick={() => void run(() => api.post(`/delivery/collections/${c.id}/reject`, { reason: why.trim() }), () => { setRejectFor(null); setWhy(''); props.onChanged(); })}
                      >
                        {tr('تأكيد الرفض', 'Confirm rejection')}
                      </button>
                      <button type="button" className="vw-btn vw-btn-ghost" onClick={() => setRejectFor(null)}>
                        {tr('إلغاء', 'Cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {may && (
        <div className="vw-panel">
          <div className="vw-panel-title">{tr('تسجيل دفعة تحصيل', 'Record a collection')}</div>
          <input
            className="vw-input"
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={props.totals?.remaining ? tr(`حتى ${props.totals.remaining}`, `up to ${props.totals.remaining}`) : tr('المبلغ', 'Amount')}
            aria-label={tr('المبلغ المحصّل', 'Collected amount')}
          />
          <button
            type="button"
            className="vw-btn vw-btn-primary"
            disabled={busy || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0}
            onClick={() =>
              void run(
                () => api.post('/delivery/collections', { shipmentId: s.id, amount, method: 'cash', clientKey: keyRef.current }),
                () => {
                  setAmount('');
                  keyRef.current = newClientKey(); // the next instalment is a new submit
                  props.onChanged();
                },
              )
            }
          >
            {busy ? '…' : tr('تسجيل التحصيل', 'Record collection')}
          </button>
          <div className="vw-note">{tr('الخادم يرفض أي دفعة تجعل الإجمالي أكبر من المطلوب.', 'The server refuses any amount that would take the total above the expected amount.')}</div>
        </div>
      )}
      {error && (
        <div className="vw-banner bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function LineProgressPanel(props: {
  shipment: WsShipment;
  progress: WsLineProgress | null | undefined;
  nameOf: (productId: string) => string;
  canAct: boolean;
  onChanged: () => void;
}) {
  const tr = useTr();
  const { busy, error, run } = useAction();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reasonFor, setReasonFor] = useState<Record<string, string>>({});
  const keys = useRef<Record<string, string>>({});
  const p = props.progress;
  if (!p || p.lines.length === 0) return null;
  const statusText: Record<string, [string, string]> = {
    none: ['لم يُسجل تسليم بالبنود بعد', 'No per-item delivery recorded yet'],
    in_progress: ['جارٍ تسجيل التسليم بالبنود', 'Per-item delivery in progress'],
    complete: ['كل البنود سُلّمت', 'Every item delivered'],
    partial: ['تسليم جزئي — بعض الكميات عادت', 'Partially delivered — some quantities came back'],
  };
  const may = props.canAct && props.shipment.state === 'out_for_delivery';
  const send = (lineId: string, kind: 'delivered' | 'returned') => {
    const k = `${lineId}:${kind}`;
    keys.current[k] = keys.current[k] ?? newClientKey();
    void run(
      () => api.post('/delivery/line-events', { shipmentId: props.shipment.id, shipmentLineId: lineId, kind, quantity: Number(qty[k]), reason: kind === 'returned' ? (reasonFor[k] ?? '').trim() : undefined, clientKey: keys.current[k] }),
      () => {
        delete keys.current[k];
        setQty((m) => ({ ...m, [k]: '' }));
        props.onChanged();
      },
    );
  };
  return (
    <div>
      <div className="vw-note">{tr(statusText[p.status][0], statusText[p.status][1])}</div>
      <ul className="vw-lines">
        {p.lines.map((l) => (
          <li key={l.shipmentLineId} className="vw-line">
            <div className="vw-line-name">{props.nameOf(l.productId)}</div>
            <dl className="vw-kv">
              <div>
                <dt>{tr('مشحون', 'Shipped')}</dt>
                <dd dir="ltr">{l.shipped}</dd>
              </div>
              <div>
                <dt>{tr('سُلّم', 'Delivered')}</dt>
                <dd dir="ltr">{l.delivered}</dd>
              </div>
              <div>
                <dt>{tr('عاد', 'Returned')}</dt>
                <dd dir="ltr">{l.returned}</dd>
              </div>
              <div>
                <dt>{tr('متبقي', 'Outstanding')}</dt>
                <dd dir="ltr">{l.outstanding}</dd>
              </div>
            </dl>
            {may && l.outstanding > 0 && (
              <div className="vw-confirm">
                <input className="vw-input" inputMode="numeric" dir="ltr" value={qty[`${l.shipmentLineId}:delivered`] ?? ''} onChange={(e) => setQty((m) => ({ ...m, [`${l.shipmentLineId}:delivered`]: e.target.value.replace(/\D/g, '') }))} placeholder={tr('الكمية المسلّمة', 'Quantity delivered')} aria-label={tr('الكمية المسلّمة', 'Quantity delivered')} />
                <button type="button" className="vw-btn vw-btn-primary" disabled={busy || !Number(qty[`${l.shipmentLineId}:delivered`])} onClick={() => send(l.shipmentLineId, 'delivered')}>
                  {tr('تسجيل تسليم', 'Record delivered')}
                </button>
                <input className="vw-input" inputMode="numeric" dir="ltr" value={qty[`${l.shipmentLineId}:returned`] ?? ''} onChange={(e) => setQty((m) => ({ ...m, [`${l.shipmentLineId}:returned`]: e.target.value.replace(/\D/g, '') }))} placeholder={tr('الكمية المرتجعة', 'Quantity brought back')} aria-label={tr('الكمية المرتجعة', 'Quantity brought back')} />
                <input className="vw-input" value={reasonFor[`${l.shipmentLineId}:returned`] ?? ''} maxLength={255} onChange={(e) => setReasonFor((m) => ({ ...m, [`${l.shipmentLineId}:returned`]: e.target.value }))} placeholder={tr('سبب الإرجاع (إلزامي)', 'Reason (required)')} aria-label={tr('سبب الإرجاع', 'Return reason')} />
                <button type="button" className="vw-btn vw-btn-danger" disabled={busy || !Number(qty[`${l.shipmentLineId}:returned`]) || (reasonFor[`${l.shipmentLineId}:returned`] ?? '').trim().length < 3} onClick={() => send(l.shipmentLineId, 'returned')}>
                  {tr('تسجيل مرتجع', 'Record returned')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div className="vw-banner bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

const EXPENSE_LABEL: Record<string, [string, string, string]> = {
  pending_approval: ['بانتظار الاعتماد', 'Awaiting approval', 'warn'],
  approved: ['معتمد — لم يُرحَّل', 'Approved — not posted', 'go'],
  rejected: ['مرفوض', 'Rejected', 'bad'],
  posted: ['تم الصرف', 'Posted', 'ok'],
  cancelled: ['ملغى', 'Cancelled', 'muted'],
};

export function ExpensesPanel(props: {
  expenses: Array<WsExpense & { shipmentLabel: string }> | null;
  openShipments: Array<{ id: string; label: string }>;
  canApprove: boolean;
  canPost: boolean;
  userId: string | undefined;
  onChanged: () => void;
}) {
  const tr = useTr();
  const { busy, error, run } = useAction();
  const [categories, setCategories] = useState<string[] | null>(null);
  const [shipmentId, setShipmentId] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const keyRef = useRef(newClientKey());

  useEffect(() => {
    api.get<{ categories: string[] }>('/delivery/custody-expense-categories').then((r) => setCategories(r.categories)).catch(() => setCategories([]));
  }, []);

  if (props.expenses === null) return <div className="vw-na">{tr('سجل المصروفات غير متاح لصلاحياتك', 'The expense record is not available for your role')}</div>;
  const canClaim = props.openShipments.length > 0;
  return (
    <section>
      <div className="vw-panel">
        <div className="vw-panel-title">{tr('مصروف جديد من عهدة السيارة', 'New expense from the vehicle custody')}</div>
        {categories !== null && categories.length === 0 ? (
          <div className="vw-banner warn" role="status">
            {tr('لم تعتمد المالية تصنيفات مصروفات للعهدة بعد، لذلك لا يمكن تسجيل مصروف. اطلب من المحاسبة ربط تصنيفات custody_* بحساباتها.', 'Finance has not mapped any custody expense categories yet, so no expense can be claimed. Ask Accounting to map the custody_* categories to their accounts.')}
          </div>
        ) : !canClaim ? (
          <div className="vw-empty">{tr('لا توجد شحنة مفتوحة لربط المصروف بها.', 'There is no open shipment to attach an expense to.')}</div>
        ) : (
          <div className="vw-confirm">
            <select className="vw-input" value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} aria-label={tr('الشحنة', 'Shipment')}>
              <option value="">{tr('اختر الشحنة', 'Choose the shipment')}</option>
              {props.openShipments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <select className="vw-input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('التصنيف', 'Category')}>
              <option value="">{tr('اختر التصنيف', 'Choose the category')}</option>
              {(categories ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input className="vw-input" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={tr('المبلغ', 'Amount')} aria-label={tr('المبلغ', 'Amount')} />
            <input className="vw-input" value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder={tr('السبب (إلزامي)', 'Reason (required)')} aria-label={tr('السبب', 'Reason')} />
            <button
              type="button"
              className="vw-btn vw-btn-primary"
              disabled={busy || !shipmentId || !category || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || reason.trim().length < 3}
              onClick={() =>
                void run(
                  () => api.post('/delivery/custody-expenses', { shipmentId, category, amount, reason: reason.trim(), clientKey: keyRef.current }),
                  () => {
                    setAmount('');
                    setReason('');
                    keyRef.current = newClientKey();
                    props.onChanged();
                  },
                )
              }
            >
              {busy ? '…' : tr('إرسال للاعتماد', 'Submit for approval')}
            </button>
            <div className="vw-note">{tr('كل مصروف يحتاج اعتماد شخص آخر ثم صرفًا صريحًا من المالية. لا يُحتسب شيء قبل ذلك.', 'Every expense needs another person to approve it and finance to post it explicitly. Nothing counts before that.')}</div>
          </div>
        )}
      </div>
      {props.expenses.length === 0 ? (
        <div className="vw-empty">{tr('لا توجد مصروفات مسجلة.', 'No expenses recorded.')}</div>
      ) : (
        <ul className="vw-lines">
          {props.expenses.map((e) => {
            const l = EXPENSE_LABEL[e.status] ?? [e.status, e.status, 'muted'];
            const mine = e.claimedByUserId === props.userId;
            return (
              <li key={e.id} className="vw-line">
                <div className="vw-line-name" dir="ltr">
                  {e.expenseNumber} · {money(e.amount)}
                </div>
                <span className={`vw-chip ${l[2]}`}>{tr(l[0], l[1])}</span>
                <div className="vw-note">
                  {e.category} — {e.reason} ({e.incurredOn}) · {e.shipmentLabel}
                </div>
                {e.decisionNote && <div className="vw-note">{e.decisionNote}</div>}
                {expenseNeedsApproval(e) && props.canApprove && !mine && (
                  <div className="vw-confirm">
                    <input className="vw-input" value={note[e.id] ?? ''} maxLength={255} onChange={(ev) => setNote((m) => ({ ...m, [e.id]: ev.target.value }))} placeholder={tr('ملاحظة (اختياري)', 'Note (optional)')} aria-label={tr('ملاحظة القرار', 'Decision note')} />
                    <div className="vw-confirm-buttons">
                      <button type="button" className="vw-btn vw-btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/delivery/custody-expenses/${e.id}/decide`, { decision: 'approved', note: note[e.id]?.trim() || undefined }), props.onChanged)}>
                        {tr('اعتماد', 'Approve')}
                      </button>
                      <button type="button" className="vw-btn vw-btn-danger" disabled={busy} onClick={() => void run(() => api.post(`/delivery/custody-expenses/${e.id}/decide`, { decision: 'rejected', note: note[e.id]?.trim() || undefined }), props.onChanged)}>
                        {tr('رفض', 'Reject')}
                      </button>
                    </div>
                  </div>
                )}
                {expenseNeedsApproval(e) && mine && <div className="vw-note">{tr('لا يمكنك اعتماد مصروفك — يعتمده شخص آخر.', 'You cannot approve your own expense — another person approves it.')}</div>}
                {expenseReadyToPost(e) && props.canPost && (
                  <button type="button" className="vw-btn vw-btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/delivery/custody-expenses/${e.id}/post`, {}), props.onChanged)}>
                    {tr('صرف المبلغ من العهدة', 'Pay out of the custody')}
                  </button>
                )}
                {mine && (e.status === 'pending_approval' || e.status === 'approved') && (
                  <button type="button" className="vw-btn vw-btn-ghost" disabled={busy} onClick={() => void run(() => api.post(`/delivery/custody-expenses/${e.id}/cancel`, { reason: 'cancelled by the claimant' }), props.onChanged)}>
                    {tr('إلغاء المطالبة', 'Cancel the claim')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="vw-banner bad" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

export function ReconciliationPanel(props: {
  vehicleId: string;
  reconciliation: WsReconciliation | null;
  handovers: WsHandover[] | null;
  canDeclare: boolean;
  canDecide: boolean;
  onChanged: () => void;
}) {
  const tr = useTr();
  const { busy, error, run } = useAction();
  const [amount, setAmount] = useState('');
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const keyRef = useRef(newClientKey());
  const r = props.reconciliation;
  if (!r) return <div className="vw-na">{tr('تسوية العهدة غير متاحة لصلاحياتك', 'The custody reconciliation is not available for your role')}</div>;
  const row = (ar: string, en: string, v: string, tone = '') => (
    <div className={tone}>
      <dt>{tr(ar, en)}</dt>
      <dd dir="ltr">{money(v)}</dd>
    </div>
  );
  return (
    <section>
      <h2 className="vw-h2">{tr('تسوية العهدة', 'Custody reconciliation')}</h2>
      <div className="vw-panel">
        <div className="vw-panel-title">{tr('التحصيلات', 'Collections')}</div>
        <dl className="vw-kv">
          {row('مسجل من السائق', 'Recorded by the driver', r.collections.recorded)}
          {row('مؤكد', 'Confirmed', r.collections.confirmed)}
          {row('مرفوض (لا يُحتسب)', 'Rejected (not counted)', r.collections.rejected)}
          {row('المحتسب', 'Counted', r.collections.counted)}
          {row('تم توريده (المالية)', 'Remitted (finance)', r.collections.remitted)}
          {row('بانتظار التوريد', 'Not yet remitted', r.collections.notYetRemitted)}
        </dl>
        <div className="vw-panel-title">{tr('المصروفات', 'Expenses')}</div>
        <dl className="vw-kv">
          {row('بانتظار الاعتماد', 'Awaiting approval', r.expenses.pendingApproval)}
          {row('معتمد ولم يُصرف', 'Approved, not posted', r.expenses.approvedNotPosted)}
          {row('تم صرفه', 'Posted', r.expenses.posted)}
        </dl>
        <div className="vw-panel-title">{tr('التسليم للخزينة (إقرار السائق)', 'Handed to the cashier (driver declaration)')}</div>
        <dl className="vw-kv">
          {row('مُقَرّ به', 'Declared', r.handovers.declared)}
          {row('مؤكد من الكاشير', 'Confirmed by the cashier', r.handovers.confirmed)}
        </dl>
      </div>
      <div className="vw-panel">
        <div className="vw-panel-title">{tr('النقد المتوقع مع السائق', 'Cash the driver is expected to carry')}</div>
        <div className="vw-amount" dir="ltr">
          {money(r.derived.cashInDriverHand)}
        </div>
        {Number(r.derived.cashInDriverHand) < 0 && <div className="vw-banner bad">{tr('الرصيد سالب: يجب التحقق من الفرق.', 'The figure is negative: the difference must be investigated.')}</div>}
        <div className="vw-note" dir="ltr">
          {r.derived.cashInDriverHandFormula}
        </div>
        <div className="vw-panel-title">{tr('الرصيد المتوقع لحساب العهدة', 'Expected custody account balance')}</div>
        <div className="vw-amount" dir="ltr">
          {money(r.derived.expectedCustodyAccountBalance)}
        </div>
        <div className="vw-note" dir="ltr">
          {r.derived.expectedCustodyAccountFormula}
        </div>
        {r.derived.ledgerDifference !== null && Number(r.derived.ledgerDifference) !== 0 && (
          <div className="vw-banner warn" role="status">
            {tr('رصيد الخزينة الفعلي يختلف عن المتوقع بمقدار ', 'The actual Treasury balance differs from the expected one by ')}
            <span dir="ltr">{money(r.derived.ledgerDifference)}</span>
            {tr(' — قد يحتوي الحساب على نقد آخر؛ راجع قبل أي إجراء.', ' — the account may hold other cash; review before acting.')}
          </div>
        )}
      </div>
      <div className="vw-panel">
        <div className="vw-panel-title">{tr('تسليم نقدية للكاشير', 'Hand cash to the cashier')}</div>
        {props.canDeclare ? (
          <div className="vw-confirm">
            <input className="vw-input" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={tr('المبلغ المسلّم', 'Amount handed over')} aria-label={tr('المبلغ المسلّم', 'Amount handed over')} />
            <button
              type="button"
              className="vw-btn vw-btn-primary"
              disabled={busy || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0}
              onClick={() =>
                void run(
                  () => api.post('/delivery/custody-handovers', { vehicleId: props.vehicleId, amount, clientKey: keyRef.current }),
                  () => {
                    setAmount('');
                    keyRef.current = newClientKey();
                    props.onChanged();
                  },
                )
              }
            >
              {busy ? '…' : tr('إقرار بالتسليم', 'Declare handover')}
            </button>
            <div className="vw-note">{tr('لا يتحرك أي مال بهذا الإقرار: يؤكده الكاشير، والتوريد المالي يتم بشاشة التوريد.', 'Declaring moves no money: the cashier confirms it, and the financial remittance stays in the remittance screen.')}</div>
          </div>
        ) : (
          <div className="vw-note">{tr('الإقرار بالتسليم للسائق المعيّن أو المسؤول.', 'Declaring a handover is for the assigned driver or an admin.')}</div>
        )}
        {props.handovers && props.handovers.length > 0 && (
          <ul className="vw-lines">
            {props.handovers.map((h) => (
              <li key={h.id} className="vw-line">
                <div className="vw-line-name" dir="ltr">
                  {h.handoverNumber} · {money(h.amount)}
                </div>
                <span className={`vw-chip ${h.status === 'confirmed' ? 'ok' : h.status === 'rejected' ? 'bad' : 'warn'}`}>{h.status === 'confirmed' ? tr('مؤكد', 'Confirmed') : h.status === 'rejected' ? tr('مرفوض', 'Rejected') : tr('بانتظار تأكيد الكاشير', 'Awaiting cashier')}</span>
                <div className="vw-note">{fmtDateTime(h.createdAt)}</div>
                {h.status === 'declared' && props.canDecide && rejectFor !== h.id && (
                  <div className="vw-confirm-buttons">
                    <button type="button" className="vw-btn vw-btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/delivery/custody-handovers/${h.id}/decide`, { decision: 'confirmed' }), props.onChanged)}>
                      {tr('تأكيد الاستلام', 'Confirm receipt')}
                    </button>
                    <button type="button" className="vw-btn vw-btn-danger" disabled={busy} onClick={() => setRejectFor(h.id)}>
                      {tr('رفض', 'Reject')}
                    </button>
                  </div>
                )}
                {rejectFor === h.id && (
                  <div className="vw-confirm">
                    <input className="vw-input" value={why} maxLength={255} onChange={(e) => setWhy(e.target.value)} placeholder={tr('سبب الرفض (إلزامي)', 'Rejection reason (required)')} aria-label={tr('سبب الرفض', 'Rejection reason')} />
                    <div className="vw-confirm-buttons">
                      <button type="button" className="vw-btn vw-btn-danger" disabled={busy || why.trim().length < 3} onClick={() => void run(() => api.post(`/delivery/custody-handovers/${h.id}/decide`, { decision: 'rejected', reason: why.trim() }), () => { setRejectFor(null); setWhy(''); props.onChanged(); })}>
                        {tr('تأكيد الرفض', 'Confirm rejection')}
                      </button>
                      <button type="button" className="vw-btn vw-btn-ghost" onClick={() => setRejectFor(null)}>
                        {tr('إلغاء', 'Cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <div className="vw-banner bad" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
