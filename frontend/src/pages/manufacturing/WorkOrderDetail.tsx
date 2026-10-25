import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState } from '../../components/ErrorState';
import { BlockedReason, DataTable, EmptyState, FormField, StatusChip } from '../../components/mfg';
import { EVENT_AND_ACTION_NAMES, STATUS_NAMES, currentLang, nameOf } from '../../lib/displayNames';
import { fmtDateTime } from '../../lib/formatDateTime';
import { ProcessExecutionPanel, type Execution } from './ProcessExecutionPanel';
import { WorkOrderOutcomes, type WorkOrderResultRow } from './WorkOrderOutcomes';
import { nextStep } from './workOrderNext';

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
  processVersionId?: string | null;
  quantityScrapped: number;
  results: WorkOrderResultRow[];
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

/** Lifecycle actions per state, each with the permission node the server checks for it. */
const STATE_ACTIONS: Record<string, string[]> = {
  draft: ['release', 'cancel'],
  released: ['cancel'],
  in_progress: ['hold', 'complete'],
  on_hold: ['resume'],
  completed: [],
  cancelled: [],
};
const ACTION_NODE: Record<string, string> = { release: 'release', cancel: 'cancel', hold: 'hold', resume: 'hold', complete: 'complete' };

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** Work Order detail (UX redesign stage 4): state, the next step and what blocks it, quantities that add up, only the controls the state and the user's permissions allow, and ONE receipt path per order kind. */
export function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const { can } = useAuth();
  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [ex, setEx] = useState<Execution | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issueQty, setIssueQty] = useState<Record<string, string>>({});
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [outputQty, setOutputQty] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    void preload(['mfg2.wo.confirm_cancel']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      const [detail, prod, wh] = await Promise.all([api.get<WorkOrderDetail>(`/manufacturing/work-orders/${id}`), api.get<Product[]>('/products/all'), api.get<Warehouse[]>('/inventory/warehouses')]);
      setWo(detail);
      setProducts(prod);
      setWarehouses(wh);
      if (detail.processVersionId) {
        try {
          setEx(await api.get<Execution>(`/manufacturing/process-orders/${id}`));
        } catch {
          setEx(null);
        }
      } else {
        setEx(null);
      }
    } catch (err) {
      setLoadError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(key: string, path: string, body: object | undefined, fallback: string, after?: () => void) {
    if (!id) return;
    setBusy(key);
    setError(null);
    try {
      await api.post(`/manufacturing/work-orders/${id}/${path}`, body);
      after?.();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(null);
    }
  }

  const productName = (pid: string) => products.find((p) => p.id === pid)?.name ?? pid.slice(0, 8);
  const warehouseName = (wid: string) => warehouses.find((w) => w.id === wid)?.name ?? wid.slice(0, 8);

  if (loadError) return <ErrorState error={loadError} onRetry={load} />;
  if (!wo) return <div className="mfg-note">{t('mfg2.common.loading')}</div>;

  const processBound = !!wo.processVersionId;
  const scrapped = wo.quantityScrapped ?? 0;
  const remaining = wo.quantityPlanned - wo.quantityProduced - scrapped;
  const openTracked = (wo.results ?? []).filter((r) => ['rework', 'rejected', 'held'].includes(r.outcomeClass) && !r.resolvedAt).reduce((s, r) => s + r.quantity, 0);
  const actions = (STATE_ACTIONS[wo.state] ?? []).filter((a) => can(`manufacturing.work_order.${ACTION_NODE[a]}`, 'editable'));
  const canIssue = (wo.state === 'released' || wo.state === 'in_progress') && can('manufacturing.work_order.material_issue', 'editable');
  const canReturn = (wo.state === 'in_progress' || wo.state === 'on_hold') && can('manufacturing.work_order.material_return', 'editable');
  // D1: ONE receipt path per order kind - a basic order records a single finished-goods output here; a process order receives its outputs through the multi-output receipt in the process panel.
  const canBasicOutput = !processBound && wo.state === 'in_progress' && can('manufacturing.work_order.finished_goods_receive', 'editable');
  const canOperate = can('manufacturing.work_order.operation_execute', 'editable');
  const legacyOpen = (wo.operations ?? []).filter((o) => o.status !== 'completed').length;
  const next = nextStep({
    state: wo.state,
    processBound,
    remaining,
    wipValue: Number(wo.wipValue),
    openTracked,
    components: wo.components,
    legacyOperationsOpen: legacyOpen,
    process: ex ? { ready: ex.operations.filter((o) => o.status === 'ready').map((o) => o.code), running: ex.operations.filter((o) => o.status === 'running').map((o) => o.code), mandatoryNotDone: ex.operations.filter((o) => !o.optional && o.status !== 'completed').map((o) => o.code) } : null,
  });
  const rejectedEvents = wo.financialTrail.filter((e) => e.status.toUpperCase() === 'REJECTED').length;
  const pendingEvents = wo.financialTrail.filter((e) => ['PENDING', 'FAILED'].includes(e.status.toUpperCase())).length;
  const fill = (text: string, params: string[]) => params.reduce((s, p, i) => s.split(`{${i}}`).join(p), text);
  const outputNum = Number(outputQty);
  const outputError = outputQty.trim() !== '' && (!Number.isInteger(outputNum) || outputNum < 1 || outputNum > remaining) ? fill(t('mfg2.px.units_invalid'), [String(remaining)]) : null;

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

      {error && <BlockedReason danger>{error}</BlockedReason>}
      {rejectedEvents > 0 && (
        <div style={{ marginBlockEnd: 12 }} data-testid="events-rejected">
          <BlockedReason danger to="/accounting/financial-events" linkText={can('accounting.financial_event.view', 'read-only') ? t('mfg2.qa.open_events') : undefined}>
            {fill(t('mfg2.wo.events.rejected'), [String(rejectedEvents)])}
          </BlockedReason>
        </div>
      )}
      {pendingEvents > 0 && (
        <div style={{ marginBlockEnd: 12 }} data-testid="events-pending">
          <BlockedReason>{fill(t('mfg2.wo.events.pending'), [String(pendingEvents)])}</BlockedReason>
        </div>
      )}

      <section className="card" style={{ marginBlockEnd: 20 }} aria-label={t('mfg2.wo.summary')}>
        <dl className="mfg-dl detail">
          <dt>{t('field.finished_product')}</dt>
          <dd>{productName(wo.finishedProductId)}</dd>
          <dt>{t('mfg2.col.path')}</dt>
          <dd>
            <StatusChip tone={processBound ? 'info' : 'neutral'}>{processBound ? t('mfg2.path.process') : t('mfg2.path.basic')}</StatusChip>
          </dd>
          <dt>{t('field.warehouse')}</dt>
          <dd>{warehouseName(wo.warehouseId)}</dd>
          <dt>{t('field.status')}</dt>
          <dd>
            <StatusBadge code={`work_order_lifecycle.state.${wo.state}`} />
          </dd>
          <dt>{t('field.quantity_planned')}</dt>
          <dd>{wo.quantityPlanned}</dd>
          <dt>{t('field.quantity_produced')}</dt>
          <dd>{wo.quantityProduced}</dd>
          <dt>{t('mfg2.col.scrapped')}</dt>
          <dd>{scrapped}</dd>
          <dt>{t('field.quantity_remaining')}</dt>
          <dd data-testid="wo-remaining">
            {remaining} <small className="mfg-note">({wo.quantityPlanned} − {wo.quantityProduced} − {scrapped})</small>
          </dd>
          <dt>{t('field.wip_value')}</dt>
          <dd>{wo.wipValue}</dd>
        </dl>
      </section>

      <section className="card" style={{ marginBlockEnd: 20 }} aria-labelledby="wo-next-title" data-testid="wo-next">
        <h2 id="wo-next-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
          {t('mfg2.wo.next.title')}
        </h2>
        <p style={{ marginBlockStart: 0 }}>
          <strong>{fill(t(`mfg2.wo.next.${next.key}`), next.params)}</strong>
        </p>
        {next.completeBlockers.length > 0 && (wo.state === 'in_progress' || next.key === 'complete') && (
          <div style={{ marginBlockEnd: 12 }} data-testid="wo-blockers">
            <BlockedReason>
              <strong>{t('mfg2.wo.block.title')}</strong>
              <ul className="mfg-findings">
                {next.completeBlockers.map((b) => (
                  <li key={b.code}>{fill(t(b.code), b.params)}</li>
                ))}
              </ul>
            </BlockedReason>
          </div>
        )}
        {actions.length > 0 ? (
          <div className="mfg-row-actions">
            {actions.map((a) => {
              const blocked = a === 'complete' && next.completeBlockers.length > 0;
              return (
                <button
                  key={a}
                  className={a === 'cancel' ? 'btn btn-danger' : 'btn btn-primary'}
                  disabled={busy !== null || blocked}
                  aria-disabled={blocked}
                  title={blocked ? t('mfg2.wo.block.title') : undefined}
                  onClick={() => {
                    if (a === 'cancel' && !window.confirm(t('mfg2.wo.confirm_cancel'))) return;
                    void post(a, a, undefined, t('mfg2.common.action_failed'));
                  }}
                  data-testid={`wo-action-${a}`}
                >
                  {busy === a ? t('mfg2.common.working') : t(`work_order_action.${a}`)}
                </button>
              );
            })}
          </div>
        ) : (
          (STATE_ACTIONS[wo.state] ?? []).length > 0 && <span className="mfg-note">{t('mfg2.wo.no_permission')}</span>
        )}
      </section>

      <section className="card" style={{ marginBlockEnd: 20 }} aria-labelledby="wo-mat-title">
        <h2 id="wo-mat-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
          {t('mfg2.wo.materials')}
        </h2>
        <DataTable
          caption={t('mfg2.wo.materials')}
          rows={wo.components}
          rowKey={(c) => c.id}
          empty={<EmptyState title={t('mfg2.wo.materials_empty')} />}
          columns={[
            { key: 'c', header: t('field.component'), render: (c) => productName(c.componentProductId) },
            { key: 'r', header: t('field.quantity_required'), align: 'end', render: (c) => c.quantityRequired },
            { key: 'i', header: t('field.quantity_issued'), align: 'end', render: (c) => c.quantityIssued },
            { key: 'm', header: t('field.quantity_remaining'), align: 'end', render: (c) => c.quantityRequired - c.quantityIssued },
            ...(canIssue
              ? [
                  {
                    key: 'is',
                    header: t('action.material_issue'),
                    render: (c: WorkOrderComponent) => {
                      const left = c.quantityRequired - c.quantityIssued;
                      return (
                        <span className="mfg-row-actions">
                          <input aria-label={`${t('action.material_issue')} ${productName(c.componentProductId)}`} type="number" min={1} max={left} step={1} style={{ width: 90 }} value={issueQty[c.componentProductId] ?? ''} onChange={(e) => setIssueQty((prev) => ({ ...prev, [c.componentProductId]: e.target.value }))} />
                          <button className="btn btn-secondary" disabled={busy !== null || left <= 0 || !Number(issueQty[c.componentProductId])} onClick={() => post(`issue:${c.componentProductId}`, 'material-issue', { componentProductId: c.componentProductId, quantity: Number(issueQty[c.componentProductId]), requestId: newRequestId() }, t('mfg2.common.action_failed'), () => setIssueQty((prev) => ({ ...prev, [c.componentProductId]: '' })))}>
                            {busy === `issue:${c.componentProductId}` ? t('mfg2.common.working') : t('action.confirm')}
                          </button>
                        </span>
                      );
                    },
                  },
                ]
              : []),
            ...(canReturn
              ? [
                  {
                    key: 'rt',
                    header: t('action.material_return'),
                    render: (c: WorkOrderComponent) => (
                      <span className="mfg-row-actions">
                        <input aria-label={`${t('action.material_return')} ${productName(c.componentProductId)}`} type="number" min={1} max={c.quantityIssued} step={1} style={{ width: 90 }} value={returnQty[c.componentProductId] ?? ''} onChange={(e) => setReturnQty((prev) => ({ ...prev, [c.componentProductId]: e.target.value }))} />
                        <button className="btn btn-secondary" disabled={busy !== null || c.quantityIssued <= 0 || !Number(returnQty[c.componentProductId])} onClick={() => post(`return:${c.componentProductId}`, 'material-return', { componentProductId: c.componentProductId, quantity: Number(returnQty[c.componentProductId]), requestId: newRequestId() }, t('mfg2.common.action_failed'), () => setReturnQty((prev) => ({ ...prev, [c.componentProductId]: '' })))}>
                          {busy === `return:${c.componentProductId}` ? t('mfg2.common.working') : t('action.confirm')}
                        </button>
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </section>

      {wo.operations && wo.operations.length > 0 && (
        <section className="card" style={{ marginBlockEnd: 20 }} aria-labelledby="wo-ops-title">
          <h2 id="wo-ops-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
            {t('mfg.field.operations')}
          </h2>
          <DataTable
            caption={t('mfg.field.operations')}
            rows={wo.operations}
            rowKey={(o) => o.id}
            columns={[
              { key: 's', header: t('mfg.field.sequence'), render: (o) => o.sequence },
              { key: 'n', header: t('mfg.field.operation'), render: (o) => o.name },
              { key: 'w', header: t('mfg.field.work_center'), render: (o) => `${o.workCenterCode} — ${o.workCenterName}` },
              { key: 'st', header: t('field.status'), render: (o) => <StatusBadge code={`mfg.op.state.${o.status}`} /> },
              { key: 'a', header: t('mfg.field.started_at'), render: (o) => (o.startedAt ? fmtDateTime(o.startedAt) : '—') },
              { key: 'c', header: t('mfg.field.completed_at'), render: (o) => (o.completedAt ? fmtDateTime(o.completedAt) : '—') },
              {
                key: 'x',
                header: t('field.actions'),
                render: (o) =>
                  canOperate && (wo.state === 'released' || wo.state === 'in_progress') ? (
                    o.status === 'pending' ? (
                      <button className="btn btn-secondary" disabled={busy !== null} onClick={() => post(`op:${o.id}`, `operations/${o.id}/start`, undefined, t('mfg2.common.action_failed'))}>
                        {busy === `op:${o.id}` ? t('mfg2.common.working') : t('mfg.action.start_operation')}
                      </button>
                    ) : o.status === 'in_progress' ? (
                      <button className="btn btn-primary" disabled={busy !== null} onClick={() => post(`op:${o.id}`, `operations/${o.id}/complete`, undefined, t('mfg2.common.action_failed'))}>
                        {busy === `op:${o.id}` ? t('mfg2.common.working') : t('mfg.action.complete_operation')}
                      </button>
                    ) : null
                  ) : null,
              },
            ]}
          />
        </section>
      )}

      {canBasicOutput && (
        <section className="card" aria-labelledby="wo-out-title" data-testid="basic-output">
          <h2 id="wo-out-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
            {t('action.finished_goods_output')}
          </h2>
          <p className="mfg-note">{t('mfg2.wo.output.basic_help')}</p>
          <div style={{ maxInlineSize: 280 }}>
            <FormField label={t('mfg2.col.quantity')} hint={`${t('field.quantity_remaining')}: ${remaining}`} error={outputError}>
              {(p) => <input {...p} type="number" min={1} max={remaining} step={1} value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />}
            </FormField>
          </div>
          <button className="btn btn-primary" disabled={busy !== null || remaining <= 0 || !outputNum || !!outputError} onClick={() => post('finished-goods-output', 'finished-goods-output', { quantity: outputNum, requestId: newRequestId() }, t('mfg2.common.action_failed'), () => setOutputQty(''))}>
            {busy === 'finished-goods-output' ? t('mfg2.common.working') : t('action.confirm')}
          </button>
        </section>
      )}

      {processBound && ex && <ProcessExecutionPanel workOrderId={wo.id} state={wo.state} planned={wo.quantityPlanned} remainingPlanned={remaining} ex={ex} onChanged={load} />}
      {processBound && !ex && <BlockedReason>{t('mfg2.wo.process_unavailable')}</BlockedReason>}

      <WorkOrderOutcomes workOrderId={wo.id} state={wo.state} remainingPlanned={remaining} results={wo.results ?? []} products={products} onChanged={load} />

      <section className="card" style={{ marginBlockStart: 20 }} aria-labelledby="wo-events-title">
        <h2 id="wo-events-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
          {t('field.financial_events')}
        </h2>
        <p className="mfg-note">{t('mfg2.wo.events.help')}</p>
        {wo.financialTrail.length === 0 ? (
          <EmptyState title={t('panel.no_financial_events_yet')} />
        ) : (
          <div className="mfg-table-wrap" role="region" aria-label={t('field.financial_events')} tabIndex={0}>
            <table className="mfg-table">
              <caption>{t('field.financial_events')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('field.business_date')}</th>
                  <th scope="col">{t('field.status')}</th>
                  <th scope="col">{t('field.account')}</th>
                  <th scope="col" className="mfg-end">{t('field.debit')}</th>
                  <th scope="col" className="mfg-end">{t('field.credit')}</th>
                  <th scope="col">{t('field.rejection_reason')}</th>
                </tr>
              </thead>
              <tbody>
                {wo.financialTrail.map((ev) => (
                  <Fragment key={ev.id}>
                    {ev.lines.length === 0 ? (
                      <tr className={ev.status.toUpperCase() === 'REJECTED' ? 'mfg-row-warn' : undefined}>
                        <td>{ev.businessDate}</td>
                        <td>
                          <StatusBadge code={`value.financial_event_status.${ev.status.toLowerCase()}`} />
                        </td>
                        <td colSpan={3}>{t('mfg2.wo.events.no_lines')}</td>
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
                          <td className="mfg-end">{Number(line.debitBase) > 0 ? line.debitBase : '—'}</td>
                          <td className="mfg-end">{Number(line.creditBase) > 0 ? line.creditBase : '—'}</td>
                          {i === 0 && <td rowSpan={ev.lines.length}>{ev.rejectionReason ?? '—'}</td>}
                        </tr>
                      ))
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginBlockStart: 20 }} aria-labelledby="wo-audit-title">
        <h2 id="wo-audit-title" style={{ marginBlockStart: 0, fontSize: '1.15rem' }}>
          {t('field.audit_trail')}
        </h2>
        <DataTable
          caption={t('field.audit_trail')}
          rows={wo.auditTrail}
          rowKey={(e) => String(e.seq)}
          empty={<EmptyState title={t('panel.no_audit_trail_yet')} />}
          columns={[
            { key: 't', header: t('field.business_date'), render: (e) => fmtDateTime(e.timestamp) },
            { key: 'a', header: t('field.actions'), render: (e) => nameOf(EVENT_AND_ACTION_NAMES, e.action, currentLang()) },
            { key: 'u', header: t('field.actor'), render: (e) => e.actorUserId ?? '—' },
            { key: 'r', header: t('field.result'), render: (e) => nameOf(STATUS_NAMES, e.result, currentLang()) },
          ]}
        />
      </section>
    </div>
  );
}
