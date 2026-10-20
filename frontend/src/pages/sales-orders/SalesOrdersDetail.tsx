import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { DepositPanel } from '../../components/DepositPanel';
import { ReserveStockPanel } from '../../components/ReserveStockPanel';
import { fmtDateTime } from '../../lib/formatDateTime';

interface OrderLine {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  listPrice: string;
  priceListId: string | null;
  priceListPrice: string | null;
  repPrice: string | null;
  managerPrice: string | null;
  discountAmount: string;
  lineTotal: string;
}
interface PriceListRef {
  id: string;
  code: string;
  name: string;
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  repSequenceNumber: number;
  customerId: string;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  customerGovernorate: string | null;
  salesRepUserId: string;
  salesRepName: string | null;
  createdByName: string | null;
  warehouseName: string | null;
  shippingMethod: 'company_vehicles' | 'shipping_company' | null;
  totalAmount: string;
  status: string;
  createdAt: string;
  lines: OrderLine[];
}

interface Deposit {
  status: string;
}

/** RSH Shipping Orders (CTO directive §3) — visible from the SO side too, not just the Shipments screen. */
interface ShipmentSummary {
  id: string;
  rshNumber: string | null;
}

/** Order Edit History (CTO directive §1) — one row per audited field change. */
interface EditHistoryEntry {
  seq: number;
  timestamp: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  field: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  editedDuringStatus: string | null;
}

/** Mirrors ORDER_ACTION_REQUIRED_ROLES (backend, order-action-roles.ts) — kept in sync deliberately, same discipline as Terminology codes: this is UI-only gating, the server re-checks every action regardless. */
const STATE_ACTIONS: Record<string, Array<{ action: string; node: string }>> = {
  draft: [{ action: 'submit', node: 'wf.sales.order.submit' }],
  supervisor_review: [
    { action: 'supervisor_approve', node: 'wf.sales.order.supervisor_approve' },
    { action: 'supervisor_reject', node: 'wf.sales.order.supervisor_reject' },
  ],
  manager_approval: [
    { action: 'manager_approve', node: 'wf.sales.order.manager_approve' },
    { action: 'manager_reject', node: 'wf.sales.order.manager_reject' },
  ],
  pending_resubmission: [{ action: 'resubmit', node: 'wf.sales.order.resubmit' }],
};

export function SalesOrdersDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const { t, preload } = useLanguage();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [priceLists, setPriceLists] = useState<PriceListRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<
    Record<string, { quantity: string; discountAmount: string; repPrice: string; managerPrice: string }>
  >({});
  const [savingEdit, setSavingEdit] = useState(false);
  // Post-Deposit-Approval Edit Control (CTO directive §1) — required only when editing a `released` order.
  const [editReason, setEditReason] = useState('');
  const [editHistory, setEditHistory] = useState<EditHistoryEntry[]>([]);
  // Redesigned SO header (CTO directive §2) — reuses the same read DepositPanel already makes, not a new one.
  const [deposit, setDeposit] = useState<Deposit | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<OrderDetail>(`/sales-orders/${id}`);
      setOrder(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load order.');
    }
  }, [id]);

  const loadEditHistory = useCallback(async () => {
    if (!id) return;
    try {
      const history = await api.get<EditHistoryEntry[]>(`/sales-orders/${id}/edit-history`);
      setEditHistory(history);
    } catch {
      // Non-critical panel — a failure here should never block the rest of the order screen.
    }
  }, [id]);

  const loadDeposit = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<Deposit | null>(`/deposits?salesOrderId=${id}`);
      setDeposit(data);
    } catch {
      // Non-critical header cell — a failure here should never block the rest of the order screen.
    }
  }, [id]);

  // RSH Shipping Orders (CTO directive §3) — visible from the SO side too,
  // not just the Shipments screen. Non-critical: most orders won't have
  // one yet, and a failure here should never block the rest of the page.
  const [shipment, setShipment] = useState<ShipmentSummary | null>(null);
  const loadShipment = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<ShipmentSummary | null>(`/shipments/by-sales-order/${id}`);
      setShipment(data);
    } catch {
      // Non-critical — no RSH yet is the normal case for most orders.
    }
  }, [id]);

  // ERP UI Integration (CTO directive §8) — Sales Order -> Invoice cross-link. Reads the SAME Invoice domain the Customer Account/Invoices screens use; non-critical (most draft orders won't have one yet).
  const [invoice, setInvoice] = useState<{ id: string; invoiceNumber: string; state: string; remaining: string } | null>(null);
  const loadInvoice = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<{ id: string; invoiceNumber: string; state: string; remaining: string } | null>(`/invoices/by-sales-order/${id}`);
      setInvoice(data);
    } catch {
      // Non-critical — no invoice yet is the normal case before delivery.
    }
  }, [id]);

  useEffect(() => {
    load();
    loadEditHistory();
    loadDeposit();
    loadShipment();
    loadInvoice();
  }, [load, loadEditHistory, loadDeposit, loadShipment, loadInvoice]);

  useEffect(() => {
    (async () => {
      const products = await api.get<Array<{ id: string; name: string }>>('/products');
      setProductNames(Object.fromEntries(products.map((p) => [p.id, p.name])));
      // A gap the peer review caught: GET /sales-orders/:id already returns
      // each line's priceListId, but this screen used to drop it silently —
      // fetching the price-list list here so we can resolve id -> code/name.
      const lists = await api.get<PriceListRef[]>('/price-lists');
      setPriceLists(lists);
    })();
  }, []);

  const availableActions = order ? STATE_ACTIONS[order.status] ?? [] : [];
  // Order Edit During Review (CTO directive §1): mirrors STAGE_EDIT_ROLES
  // (backend, sales-orders.service.ts) — UI-only gating, the server
  // re-checks the role/stage regardless, same discipline as STATE_ACTIONS
  // above. `released` is Post-Deposit-Approval Edit Control (same
  // directive): admin/finance only, and a reason is required — enforced
  // below in the edit form and, authoritatively, server-side.
  const canEditInline =
    !!order &&
    ((order.status === 'supervisor_review' && can('wf.sales.order.edit_supervisor_review', 'editable')) ||
      (order.status === 'manager_approval' && can('wf.sales.order.edit_manager_approval', 'editable')) ||
      (order.status === 'released' && can('wf.sales.order.edit_released', 'editable')));
  const editReasonRequired = order?.status === 'released';
  // Order Edit at Draft (CTO directive) — ownership-gated, not role-gated:
  // mirrors editDraftOrder's own check (the order's own rep, or admin).
  // Opens the full add/remove-item screen instead of the narrower inline
  // quantity/price edit the two review stages above use.
  const canEditDraft = !!order && order.status === 'draft' && (can('wf.sales.order.edit_any_draft', 'editable') || order.salesRepUserId === user?.id);

  preload([
    'action.edit',
    'action.view_customer_account',
    'field.invoice',
    'panel.editing_order',
    'field.order_number',
    'field.rep_sequence_number',
    'field.customer',
    'field.customer_phone',
    'field.sales_rep',
    'field.created_by',
    'field.warehouse',
    'field.price_list_price',
    'field.total_amount',
    'field.status',
    'field.lines',
    'field.product',
    'field.quantity',
    'field.unit_price',
    'field.list_price',
    'field.rep_price',
    'field.manager_price',
    'field.price_variance',
    'field.discount_amount',
    'field.line_total',
    'panel.released_for_fulfillment',
    'panel.released_for_fulfillment_body',
    'panel.no_action_for_role',
    'field.shipping_order',
    'field.rsh_number',
    'nav.shipments',
    'panel.edit_history',
    'panel.no_edit_history',
    'field.reason',
    'field.reason_required_released',
    'field.old_value',
    'field.new_value',
    'field.edited_by',
    'field.edited_at',
    'field.edited_field',
    'action.post_release_edit',
    'field.governorate',
    'field.address',
    'field.shipping_method',
    'shipping_method.company_vehicles',
    'shipping_method.shipping_company',
    'field.deposit_status',
    'action.delete',
    'panel.confirm_delete_draft',
    'deposit.status.submitted',
    'deposit.status.approved',
    'deposit.status.rejected',
    ...availableActions.map((a) => `sales_order_approval.action.${a.action}`),
    ...(order ? [`sales_order_approval.state.${order.status}`] : []),
  ]);

  // Draft Order Deletion (CTO directive §2) — ownership/status gating is
  // authoritative server-side; this mirrors canEditDraft exactly since
  // it's the identical audience (own rep, or admin, while draft).
  const canDeleteDraft = canEditDraft;

  async function deleteDraft() {
    if (!id || !order) return;
    if (!window.confirm(t('panel.confirm_delete_draft'))) return;
    setDeleting(true);
    setError(null);
    try {
      await api.post(`/sales-orders/${id}/delete`);
      navigate('/sales-orders');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete order.');
      setDeleting(false);
    }
  }

  async function runAction(action: string) {
    if (!id) return;
    setBusyAction(action);
    setError(null);
    try {
      await api.post(`/sales-orders/${id}/transition`, { action });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to run action "${action}".`);
    } finally {
      setBusyAction(null);
    }
  }

  function startEditing() {
    if (!order) return;
    setEditValues(
      Object.fromEntries(
        order.lines.map((l) => [
          l.id,
          { quantity: String(l.quantity), discountAmount: l.discountAmount, repPrice: l.repPrice ?? '', managerPrice: l.managerPrice ?? '' },
        ]),
      ),
    );
    setEditing(true);
    setEditReason('');
    setError(null);
  }

  function cancelEditing() {
    setEditing(false);
    setEditValues({});
    setEditReason('');
  }

  async function saveEdit() {
    if (!id || !order) return;
    if (editReasonRequired && !editReason.trim()) {
      setError(t('field.reason_required_released'));
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      const lines = order.lines.map((l) => {
        const v = editValues[l.id];
        return {
          lineId: l.id,
          quantity: Number(v.quantity),
          discountAmount: v.discountAmount || '0',
          ...(v.repPrice ? { repPrice: v.repPrice } : {}),
          ...(can('wf.sales.order.set_manager_price', 'editable') && v.managerPrice ? { managerPrice: v.managerPrice } : {}),
        };
      });
      await api.post(`/sales-orders/${id}/lines`, { lines, ...(editReasonRequired ? { reason: editReason.trim() } : {}) });
      setEditing(false);
      setEditValues({});
      setEditReason('');
      await load();
      await loadEditHistory();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save changes.');
    } finally {
      setSavingEdit(false);
    }
  }

  if (error && !order) return <div className="error-text">{error}</div>;
  if (!order) return <div className="empty-state">Loading…</div>;

  return (
    <div>
      <div className="page-header">
        <h1>
          {order.orderNumber}{' '}
          <span style={{ fontSize: '0.6em', color: '#6b7280', fontWeight: 'normal' }}>
            ({t('field.rep_sequence_number')} {order.repSequenceNumber})
          </span>
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => window.open(`/print/sales-order/${order.id}`, '_blank')}>
            {t('action.print')}
          </button>
          <button className="btn btn-secondary" onClick={() => navigate(`/customers/${order.customerId}/account`)}>
            {t('action.view_customer_account')}
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/sales-orders')}>
            {t('action.back')}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="detail-grid">
          <div className="detail-field">
            <div className="label">{t('field.customer')}</div>
            <div className="value">{order.customerName ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.customer_phone')}</div>
            <div className="value">{order.customerPhone ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.governorate')}</div>
            <div className="value">{order.customerGovernorate ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.address')}</div>
            <div className="value">{order.customerAddress ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.sales_rep')}</div>
            <div className="value">{order.salesRepName ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.created_by')}</div>
            <div className="value">{order.createdByName ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.warehouse')}</div>
            <div className="value">{order.warehouseName ?? '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.shipping_method')}</div>
            <div className="value">{order.shippingMethod ? t(`shipping_method.${order.shippingMethod}`) : '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.status')}</div>
            <div className="value">
              <StatusBadge code={`sales_order_approval.state.${order.status}`} />
            </div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.deposit_status')}</div>
            <div className="value">
              {deposit ? <StatusBadge code={`deposit.status.${deposit.status}`} /> : '—'}
            </div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.total_amount')}</div>
            <div className="value">{order.totalAmount}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.created_at')}</div>
            <div className="value">{fmtDateTime(order.createdAt)}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.invoice')}</div>
            <div className="value">
              {invoice ? (
                <a onClick={() => navigate(`/invoices/${invoice.id}`)} style={{ cursor: 'pointer' }}>
                  {invoice.invoiceNumber} — <StatusBadge code={`sales_invoice_lifecycle.state.${invoice.state}`} />
                </a>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>

        {error && <div className="error-text">{error}</div>}

        <div className="action-row">
          {canEditDraft && (
            <button className="btn btn-secondary" onClick={() => navigate(`/sales-orders/${order.id}/edit`)}>
              {t('action.edit')}
            </button>
          )}
          {canDeleteDraft && (
            <button className="btn btn-danger" disabled={deleting} onClick={deleteDraft}>
              {deleting ? '...' : t('action.delete')}
            </button>
          )}
          {canEditInline && !editing && (
            <button className="btn btn-secondary" onClick={startEditing}>
              {t('action.edit')}
            </button>
          )}
          {editing && editReasonRequired && (
            <input
              type="text"
              placeholder={t('field.reason')}
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              style={{ minWidth: 260 }}
            />
          )}
          {editing && (
            <>
              <button
                className="btn btn-primary"
                disabled={savingEdit || (editReasonRequired && !editReason.trim())}
                onClick={saveEdit}
              >
                {savingEdit ? '...' : t('action.save')}
              </button>
              <button className="btn btn-secondary" disabled={savingEdit} onClick={cancelEditing}>
                {t('action.cancel')}
              </button>
            </>
          )}
          {!editing &&
            availableActions
              .filter((a) => can(a.node, 'editable'))
              .map((a) => (
                <button
                  key={a.action}
                  className={a.action.includes('reject') ? 'btn btn-danger' : 'btn btn-primary'}
                  disabled={busyAction !== null}
                  onClick={() => runAction(a.action)}
                >
                  {busyAction === a.action ? '...' : t(`sales_order_approval.action.${a.action}`)}
                </button>
              ))}
          {!editing && availableActions.length === 0 && order.status !== 'deposit_verification' && order.status !== 'released' && (
            <span style={{ color: '#6b7280', fontSize: '0.9rem' }}>{t('panel.no_action_for_role')}</span>
          )}
        </div>
        {editing && (
          <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 8 }}>
            {editReasonRequired ? t('field.reason_required_released') : t('panel.editing_order')}
          </p>
        )}
      </div>

      <ReserveStockPanel salesOrderId={order.id} orderStatus={order.status} lines={order.lines} />
      <DepositPanel salesOrderId={order.id} orderStatus={order.status} onChanged={load} />

      {order.status === 'released' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('panel.released_for_fulfillment')}</h3>
          <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>
            {t('panel.released_for_fulfillment_body')}{' '}
            <button className="btn btn-secondary" onClick={() => navigate('/fulfillment')} style={{ padding: '2px 10px' }}>
              {t('nav.fulfillment')}
            </button>
          </p>
        </div>
      )}

      {shipment && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('field.shipping_order')}</h3>
          <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>
            {t('field.rsh_number')}: <strong>{shipment.rshNumber ?? '—'}</strong>{' '}
            <button className="btn btn-secondary" onClick={() => navigate('/shipments')} style={{ padding: '2px 10px' }}>
              {t('nav.shipments')}
            </button>
          </p>
        </div>
      )}

      <h3>{t('field.lines')}</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.product')}</th>
            <th>{t('field.quantity')}</th>
            <th>{t('field.list_price')}</th>
            <th>{t('field.price_list_applied')}</th>
            <th>{t('field.price_list_price')}</th>
            <th>{t('field.rep_price')}</th>
            <th>{t('field.manager_price')}</th>
            <th>{t('field.unit_price')}</th>
            <th>{t('field.price_variance')}</th>
            <th>{t('field.discount_amount')}</th>
            <th>{t('field.line_total')}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => {
            const variance = (Number(l.unitPrice) - Number(l.listPrice)).toFixed(2);
            const v = editValues[l.id];
            return (
              <tr key={l.id}>
                <td>{productNames[l.productId] ?? l.productId}</td>
                <td>
                  {editing && v ? (
                    <input
                      type="number"
                      min="1"
                      value={v.quantity}
                      style={{ width: 70 }}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [l.id]: { ...prev[l.id], quantity: e.target.value } }))}
                    />
                  ) : (
                    l.quantity
                  )}
                </td>
                <td>{l.listPrice}</td>
                <td>{l.priceListId ? priceLists.find((pl) => pl.id === l.priceListId)?.code ?? l.priceListId : '—'}</td>
                <td>{l.priceListPrice ?? '—'}</td>
                <td>
                  {editing && v ? (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={v.repPrice}
                      style={{ width: 90 }}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [l.id]: { ...prev[l.id], repPrice: e.target.value } }))}
                    />
                  ) : (
                    l.repPrice ?? '—'
                  )}
                </td>
                <td>
                  {editing && v && can('wf.sales.order.set_manager_price', 'editable') ? (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={v.managerPrice}
                      style={{ width: 90 }}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [l.id]: { ...prev[l.id], managerPrice: e.target.value } }))}
                    />
                  ) : (
                    l.managerPrice ?? '—'
                  )}
                </td>
                <td>{l.unitPrice}</td>
                <td style={{ color: Number(variance) < 0 ? '#a3262d' : Number(variance) > 0 ? '#1c7a3e' : undefined }}>
                  {Number(variance) !== 0 ? variance : '—'}
                </td>
                <td>
                  {editing && v ? (
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={v.discountAmount}
                      style={{ width: 90 }}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [l.id]: { ...prev[l.id], discountAmount: e.target.value } }))}
                    />
                  ) : Number(l.discountAmount) > 0 ? (
                    l.discountAmount
                  ) : (
                    '—'
                  )}
                </td>
                <td>{l.lineTotal}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>{t('panel.edit_history')}</h3>
      {editHistory.length === 0 ? (
        <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>{t('panel.no_edit_history')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.edited_at')}</th>
              <th>{t('field.edited_by')}</th>
              <th>{t('field.edited_field')}</th>
              <th>{t('field.old_value')}</th>
              <th>{t('field.new_value')}</th>
              <th>{t('field.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {editHistory.map((h) => (
              <tr key={h.seq}>
                <td>{fmtDateTime(h.timestamp)}</td>
                <td>{h.actorName ?? h.actorUserId ?? '—'}</td>
                <td>{h.field ?? '—'}</td>
                <td>{String(h.before ?? '—')}</td>
                <td>{String(h.after ?? '—')}</td>
                <td>{h.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
