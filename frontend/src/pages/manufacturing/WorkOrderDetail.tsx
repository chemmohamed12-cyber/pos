import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';

interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface WorkOrderComponent {
  id: string;
  workOrderId: string;
  componentProductId: string;
  quantityRequired: number;
  quantityIssued: number;
  unitCostAtRelease: string | null;
}
interface FinancialTrailLine {
  accountCode: string;
  accountName: string;
  debitBase: string;
  creditBase: string;
}
interface FinancialTrailEvent {
  id: string;
  eventType: string;
  status: string;
  businessDate: string;
  rejectionReason: string | null;
  journalEntryId: string | null;
  lines: FinancialTrailLine[];
}
interface AuditTrailEntry {
  seq: number;
  timestamp: string;
  action: string;
  actorUserId: string | null;
  result: string;
}
interface WorkOrderOperationRow {
  id: string;
  sequence: number;
  name: string;
  workCenterCode: string;
  workCenterName: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt: string | null;
  completedAt: string | null;
}
interface WorkOrderDetail {
  id: string;
  workOrderNumber: string;
  finishedProductId: string;
  quantityPlanned: number;
  quantityProduced: number;
  warehouseId: string;
  wipWarehouseId: string | null;
  createdAt: string;
  state: string;
  components: WorkOrderComponent[];
  operations: WorkOrderOperationRow[];
  wipValue: string;
  financialTrail: FinancialTrailEvent[];
  auditTrail: AuditTrailEntry[];
}

/** ADR-061 §3 — bare (no-quantity) lifecycle actions available per state; material issue/return and finished-goods output have their own quantity pickers below. */
const STATE_ACTIONS: Record<string, string[]> = {
  draft: ['release', 'cancel'],
  released: ['cancel'],
  in_progress: ['hold', 'complete'],
  on_hold: ['resume'],
  completed: [],
  cancelled: [],
};

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** ADR-061 §18 — Work Order detail: BOM-snapshot components (issued/remaining), WIP balance, and every lifecycle action. */
export function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [issueQty, setIssueQty] = useState<Record<string, string>>({});
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [outputQty, setOutputQty] = useState('');

  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      const [detail, prod, wh] = await Promise.all([
        api.get<WorkOrderDetail>(`/manufacturing/work-orders/${id}`),
        api.get<Product[]>('/products/all'),
        api.get<Warehouse[]>('/inventory/warehouses'),
      ]);
      setWo(detail);
      setProducts(prod);
      setWarehouses(wh);
    } catch (err) {
      // Foundation fix: this load had no error handling — the page was
      // stuck on "Loading…" forever on failure.
      setLoadError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const availableActions = wo ? STATE_ACTIONS[wo.state] ?? [] : [];
  preload([
    'field.work_order_number',
    'field.finished_product',
    'field.warehouse',
    'field.quantity_planned',
    'field.quantity_produced',
    'field.status',
    'field.wip_value',
    'field.component',
    'field.quantity_required',
    'field.quantity_issued',
    'field.quantity_remaining',
    'field.actions',
    'mfg.field.operations',
    'mfg.field.sequence',
    'mfg.field.operation',
    'mfg.field.work_center',
    'mfg.field.started_at',
    'mfg.field.completed_at',
    'mfg.action.start_operation',
    'mfg.action.complete_operation',
    'mfg.op.state.pending',
    'mfg.op.state.in_progress',
    'mfg.op.state.completed',
    'action.back',
    'action.material_issue',
    'action.material_return',
    'action.finished_goods_output',
    'action.confirm',
    'field.financial_events',
    'field.audit_trail',
    'field.account',
    'field.debit',
    'field.credit',
    'field.rejection_reason',
    'field.business_date',
    'field.actor',
    'field.result',
    'panel.no_financial_events_yet',
    'panel.no_audit_trail_yet',
    ...availableActions.map((a) => `work_order_action.${a}`),
    ...(wo ? [`work_order_lifecycle.state.${wo.state}`] : []),
    ...(wo ? wo.financialTrail.map((e) => `value.financial_event_status.${e.status.toLowerCase()}`) : []),
  ]);

  async function runOperation(operationId: string, action: 'start' | 'complete') {
    if (!id) return;
    setBusy(`op:${operationId}`);
    setError(null);
    try {
      await api.post(`/manufacturing/work-orders/${id}/operations/${operationId}/${action}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} operation.`);
    } finally {
      setBusy(null);
    }
  }

  async function runAction(action: string) {
    if (!id) return;
    setBusy(action);
    setError(null);
    try {
      await api.post(`/manufacturing/work-orders/${id}/${action}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to run "${action}".`);
    } finally {
      setBusy(null);
    }
  }

  async function onIssue(componentProductId: string) {
    if (!id) return;
    const quantity = Number(issueQty[componentProductId] ?? 0);
    if (!quantity || quantity <= 0) return;
    setBusy(`issue:${componentProductId}`);
    setError(null);
    try {
      await api.post(`/manufacturing/work-orders/${id}/material-issue`, { componentProductId, quantity, requestId: newRequestId() });
      setIssueQty((prev) => ({ ...prev, [componentProductId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to issue material.');
    } finally {
      setBusy(null);
    }
  }

  async function onReturn(componentProductId: string) {
    if (!id) return;
    const quantity = Number(returnQty[componentProductId] ?? 0);
    if (!quantity || quantity <= 0) return;
    setBusy(`return:${componentProductId}`);
    setError(null);
    try {
      await api.post(`/manufacturing/work-orders/${id}/material-return`, { componentProductId, quantity, requestId: newRequestId() });
      setReturnQty((prev) => ({ ...prev, [componentProductId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to return material.');
    } finally {
      setBusy(null);
    }
  }

  async function onFinishedGoodsOutput() {
    if (!id) return;
    const quantity = Number(outputQty);
    if (!quantity || quantity <= 0) return;
    setBusy('finished-goods-output');
    setError(null);
    try {
      await api.post(`/manufacturing/work-orders/${id}/finished-goods-output`, { quantity, requestId: newRequestId() });
      setOutputQty('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record finished goods output.');
    } finally {
      setBusy(null);
    }
  }

  const productName = (pid: string) => products.find((p) => p.id === pid)?.name ?? pid.slice(0, 8);
  const warehouseName = (wid: string) => warehouses.find((w) => w.id === wid)?.name ?? wid.slice(0, 8);

  if (loadError) return <ErrorState error={loadError} onRetry={load} />;
  if (!wo) return <div className="empty-state">Loading…</div>;

  const canIssue = wo.state === 'released' || wo.state === 'in_progress';
  const canReturn = wo.state === 'in_progress' || wo.state === 'on_hold';
  const canOutput = wo.state === 'in_progress';
  const remainingPlanned = wo.quantityPlanned - wo.quantityProduced;

  return (
    <div>
      <div className="page-header">
        <h1>
          {t('field.work_order_number')}: {wo.workOrderNumber}
        </h1>
        <Link className="btn btn-secondary" to="/manufacturing/work-orders">
          {t('action.back')}
        </Link>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="detail-grid">
          <div>
            <label>{t('field.finished_product')}</label>
            <div>{productName(wo.finishedProductId)}</div>
          </div>
          <div>
            <label>{t('field.warehouse')}</label>
            <div>{warehouseName(wo.warehouseId)}</div>
          </div>
          <div>
            <label>{t('field.quantity_planned')}</label>
            <div>{wo.quantityPlanned}</div>
          </div>
          <div>
            <label>{t('field.quantity_produced')}</label>
            <div>{wo.quantityProduced}</div>
          </div>
          <div>
            <label>{t('field.status')}</label>
            <div>
              <StatusBadge code={`work_order_lifecycle.state.${wo.state}`} />
            </div>
          </div>
          <div>
            <label>{t('field.wip_value')}</label>
            <div>{wo.wipValue}</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {availableActions.map((a) => (
            <button
              key={a}
              className={a === 'cancel' ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={busy !== null}
              onClick={() => runAction(a)}
            >
              {busy === a ? '…' : t(`work_order_action.${a}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.component')}</th>
              <th>{t('field.quantity_required')}</th>
              <th>{t('field.quantity_issued')}</th>
              <th>{t('field.quantity_remaining')}</th>
              {canIssue && <th>{t('action.material_issue')}</th>}
              {canReturn && <th>{t('action.material_return')}</th>}
            </tr>
          </thead>
          <tbody>
            {wo.components.map((c) => {
              const remaining = c.quantityRequired - c.quantityIssued;
              return (
                <tr key={c.id}>
                  <td>{productName(c.componentProductId)}</td>
                  <td>{c.quantityRequired}</td>
                  <td>{c.quantityIssued}</td>
                  <td>{remaining}</td>
                  {canIssue && (
                    <td style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="number"
                        min={1}
                        max={remaining}
                        step={1}
                        style={{ width: 80 }}
                        value={issueQty[c.componentProductId] ?? ''}
                        onChange={(e) => setIssueQty((prev) => ({ ...prev, [c.componentProductId]: e.target.value }))}
                      />
                      <button className="btn btn-secondary" disabled={busy !== null || remaining <= 0} onClick={() => onIssue(c.componentProductId)}>
                        {busy === `issue:${c.componentProductId}` ? '…' : t('action.confirm')}
                      </button>
                    </td>
                  )}
                  {canReturn && (
                    <td style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="number"
                        min={1}
                        max={c.quantityIssued}
                        step={1}
                        style={{ width: 80 }}
                        value={returnQty[c.componentProductId] ?? ''}
                        onChange={(e) => setReturnQty((prev) => ({ ...prev, [c.componentProductId]: e.target.value }))}
                      />
                      <button className="btn btn-secondary" disabled={busy !== null || c.quantityIssued <= 0} onClick={() => onReturn(c.componentProductId)}>
                        {busy === `return:${c.componentProductId}` ? '…' : t('action.confirm')}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {wo.operations && wo.operations.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('mfg.field.operations')}</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('mfg.field.sequence')}</th>
                <th>{t('mfg.field.operation')}</th>
                <th>{t('mfg.field.work_center')}</th>
                <th>{t('field.status')}</th>
                <th>{t('mfg.field.started_at')}</th>
                <th>{t('mfg.field.completed_at')}</th>
                <th>{t('field.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {wo.operations.map((op) => (
                <tr key={op.id}>
                  <td>{op.sequence}</td>
                  <td>{op.name}</td>
                  <td>
                    {op.workCenterCode} — {op.workCenterName}
                  </td>
                  <td>
                    <StatusBadge code={`mfg.op.state.${op.status}`} />
                  </td>
                  <td>{op.startedAt ? new Date(op.startedAt).toLocaleString() : '—'}</td>
                  <td>{op.completedAt ? new Date(op.completedAt).toLocaleString() : '—'}</td>
                  <td>
                    {(wo.state === 'released' || wo.state === 'in_progress') && op.status === 'pending' && (
                      <button className="btn btn-secondary" disabled={busy !== null} onClick={() => runOperation(op.id, 'start')}>
                        {busy === `op:${op.id}` ? '…' : t('mfg.action.start_operation')}
                      </button>
                    )}
                    {(wo.state === 'released' || wo.state === 'in_progress') && op.status === 'in_progress' && (
                      <button className="btn btn-primary" disabled={busy !== null} onClick={() => runOperation(op.id, 'complete')}>
                        {busy === `op:${op.id}` ? '…' : t('mfg.action.complete_operation')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canOutput && (
        <div className="card">
          <label>
            {t('action.finished_goods_output')} ({t('field.quantity_remaining')}: {remainingPlanned})
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input type="number" min={1} max={remainingPlanned} step={1} style={{ width: 100 }} value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
            <button className="btn btn-primary" disabled={busy !== null || remainingPlanned <= 0} onClick={onFinishedGoodsOutput}>
              {busy === 'finished-goods-output' ? '…' : t('action.confirm')}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.financial_events')}</h3>
        {wo.financialTrail.length === 0 ? (
          <div className="empty-state">{t('panel.no_financial_events_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.business_date')}</th>
                <th>{t('field.status')}</th>
                <th>{t('field.account')}</th>
                <th>{t('field.debit')}</th>
                <th>{t('field.credit')}</th>
                <th>{t('field.rejection_reason')}</th>
              </tr>
            </thead>
            <tbody>
              {wo.financialTrail.map((ev) => (
                <Fragment key={ev.id}>
                  {ev.lines.length === 0 ? (
                    <tr key={ev.id}>
                      <td>{ev.businessDate}</td>
                      <td>
                        <StatusBadge code={`value.financial_event_status.${ev.status.toLowerCase()}`} />
                      </td>
                      <td colSpan={2}>—</td>
                      <td>—</td>
                      <td>{ev.rejectionReason ?? '—'}</td>
                    </tr>
                  ) : (
                    ev.lines.map((line, i) => (
                      <tr key={`${ev.id}:${i}`}>
                        {i === 0 && (
                          <>
                            <td rowSpan={ev.lines.length}>{ev.businessDate}</td>
                            <td rowSpan={ev.lines.length}>
                              <StatusBadge code={`value.financial_event_status.${ev.status.toLowerCase()}`} />
                            </td>
                          </>
                        )}
                        <td>
                          {line.accountCode} — {line.accountName}
                        </td>
                        <td>{Number(line.debitBase) > 0 ? line.debitBase : '—'}</td>
                        <td>{Number(line.creditBase) > 0 ? line.creditBase : '—'}</td>
                        {i === 0 && <td rowSpan={ev.lines.length}>{ev.rejectionReason ?? '—'}</td>}
                      </tr>
                    ))
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>{t('field.audit_trail')}</h3>
        {wo.auditTrail.length === 0 ? (
          <div className="empty-state">{t('panel.no_audit_trail_yet')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('field.business_date')}</th>
                <th>{t('field.actions')}</th>
                <th>{t('field.actor')}</th>
                <th>{t('field.result')}</th>
              </tr>
            </thead>
            <tbody>
              {wo.auditTrail.map((entry) => (
                <tr key={entry.seq}>
                  <td>{new Date(entry.timestamp).toLocaleString()}</td>
                  <td>{entry.action}</td>
                  <td>{entry.actorUserId ?? '—'}</td>
                  <td>{entry.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
