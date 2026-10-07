import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';

interface SalesOrder {
  id: string;
  orderNumber: string;
  status: string;
}
interface FulfillmentOrderRow {
  id: string;
  salesOrderId: string;
  warehouseId: string;
  orderNumber: string | null;
}
interface Task {
  id: string;
  fulfillmentOrderId: string;
  assignedToUserId: string | null;
  state: string;
}
interface ShipmentRow {
  id: string;
  fulfillmentOrderId: string;
}
interface OrderDetail {
  id: string;
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  customerGovernorate: string | null;
  salesRepName: string | null;
  lines: Array<{ id: string; productId: string; quantity: number }>;
}
interface PickTaskLineRow {
  id: string;
  pickTaskId: string;
  productId: string;
  requestedQuantity: number;
  preparedQuantity: number;
  status: 'pending' | 'prepared';
}
interface ProductLite {
  id: string;
  sku: string;
  name: string;
}

// CTO directive ("PRIORITY: ITEM PREPARATION") — `in_progress` no longer
// has a manual "complete" bypass: `markPickTaskLineDone` auto-advances
// the task via the Process Engine once every line is fully prepared (see
// the dedicated in_progress render branch below), so there is no action
// here that would let a task complete without any item ever being
// physically moved through Inventory. `pending_verification` is also
// handled by its own dedicated branch ("تم التغليف وجاهز للشحن", one
// click through Preparation Review + the whole Pack Task cycle) — not
// listed here any more.
const PICK_ACTIONS: Record<string, string[]> = {
  assigned: ['accept', 'cancel'],
  accepted: ['start', 'cancel'],
};

type Bucket = 'new' | 'preparation' | 'ready';
type View = { kind: 'dashboard' } | { kind: 'list'; bucket: Bucket } | { kind: 'detail'; salesOrderId: string };

/**
 * CTO directive — "التجهيز" screen rework: a dashboard (New / Under
 * Preparation / Ready for Shipping, clickable, counts), the "New Order"
 * screen replacing plain "Create" with a real customer/rep/address query
 * (shipping prep needs the address up front, not discovered later) plus
 * a single "استلام وبدء التجهيز" action, and "انتهاء التغليف ونقل إلى
 * الشحن" as the final packing step's label. The underlying Process
 * Engine state machine is UNCHANGED (already correct, already tested) —
 * this only reorganizes how it's presented and adds one convenience
 * action (`receiveAndStartPickTask`, accept+start run together).
 */
export function Fulfillment() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'nav.fulfillment',
    'dashboard.new_orders',
    'dashboard.under_preparation',
    'dashboard.ready_for_shipping',
    'action.receive_and_start',
    'action.finish_packing',
    'action.back_to_dashboard',
    'field.new_order_detail',
    'field.order_number',
    'field.customer',
    'field.customer_phone',
    'field.sales_rep',
    'field.address',
    'field.governorate',
    'panel.no_released_orders',
    'panel.no_orders_in_bucket',
    'field.fulfillment_order',
    'field.status',
    'field.actions',
    'action.print',
    'panel.preparation_items',
    'field.requested_quantity',
    'field.prepared_quantity',
    'field.remaining_quantity',
    'action.mark_done',
    'action.mark_all_done',
    'prep_item_status.pending',
    'prep_item_status.prepared',
    'field.sku',
    'field.name',
    'field.fulfillment_order_number',
    'action.finish_packing_ready_for_shipping',
    'panel.order_items_preview',
    'field.quantity',
  ]);

  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>([]);
  const [fulfillmentOrders, setFulfillmentOrders] = useState<FulfillmentOrderRow[]>([]);
  const [pickTasks, setPickTasks] = useState<Task[]>([]);
  const [packTasks, setPackTasks] = useState<Task[]>([]);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [pickTaskLines, setPickTaskLines] = useState<PickTaskLineRow[]>([]);
  const [prepQuantities, setPrepQuantities] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [orders, fos, picks, packs, ships, prods] = await Promise.all([
        api.get<SalesOrder[]>('/sales-orders'),
        api.get<FulfillmentOrderRow[]>('/fulfillment/orders'),
        api.get<Task[]>('/fulfillment/pick-tasks'),
        api.get<Task[]>('/fulfillment/pack-tasks'),
        api.get<ShipmentRow[]>('/shipments'),
        api.get<ProductLite[]>('/products'),
      ]);
      setSalesOrders(orders.filter((o) => o.status === 'released'));
      setFulfillmentOrders(fos);
      setPickTasks(picks);
      setPackTasks(packs);
      setShipments(ships);
      setProducts(prods);
    } catch (err) {
      // Foundation fix: this mount-time load had no error handling — a
      // failure left every list on this screen silently empty.
      setError(err instanceof ApiError ? err.message : 'Failed to load fulfillment data.');
    }
  }

  /** CTO directive ("PRIORITY: ITEM PREPARATION") — loads the per-item breakdown for the Preparation screen, called whenever a pick task in `in_progress` is opened. */
  async function loadPickTaskLines(pickTaskId: string) {
    const lines = await api.get<PickTaskLineRow[]>(`/fulfillment/pick-tasks/${pickTaskId}/lines`);
    setPickTaskLines(lines);
    setPrepQuantities(Object.fromEntries(lines.map((l) => [l.id, String(Math.max(l.requestedQuantity - l.preparedQuantity, 0))])));
  }

  async function prepareLine(pickTaskId: string, lineId: string, salesOrderId: string) {
    const raw = prepQuantities[lineId];
    const quantity = Number(raw);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    setBusy(lineId);
    setError(null);
    try {
      await api.post(`/fulfillment/pick-tasks/${pickTaskId}/lines/${lineId}/prepare`, { quantity });
      await loadAll();
      await openOrder(salesOrderId);
      await loadPickTaskLines(pickTaskId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to prepare item.');
    } finally {
      setBusy(null);
    }
  }

  async function prepareAllLines(pickTaskId: string, salesOrderId: string) {
    setBusy(pickTaskId + 'all');
    setError(null);
    try {
      await api.post(`/fulfillment/pick-tasks/${pickTaskId}/prepare-all`, {});
      await loadAll();
      await openOrder(salesOrderId);
      await loadPickTaskLines(pickTaskId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to mark all items done.');
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const foBySalesOrderId = new Map(fulfillmentOrders.map((fo) => [fo.salesOrderId, fo]));
  const pickByFoId = new Map(pickTasks.map((p) => [p.fulfillmentOrderId, p]));
  const packByFoId = new Map(packTasks.map((p) => [p.fulfillmentOrderId, p]));
  const shippedFoIds = new Set(shipments.map((s) => s.fulfillmentOrderId));

  // CTO directive ("PRIORITY: ITEM PREPARATION") — whenever the detail
  // view lands on a pick task that's actively `in_progress`, load its
  // per-item breakdown for the Preparation screen; otherwise there is
  // nothing to show, so clear it (avoids a stale list leaking into a
  // different order's view for a moment on navigation).
  useEffect(() => {
    if (view.kind !== 'detail') return;
    const fo = foBySalesOrderId.get(view.salesOrderId);
    const pick = fo ? pickByFoId.get(fo.id) : undefined;
    if (pick && pick.state === 'in_progress') {
      loadPickTaskLines(pick.id);
    } else {
      setPickTaskLines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, fulfillmentOrders, pickTasks]);

  // CTO directive — the dashboard's 3 buckets, derived entirely from
  // data already loaded above (no separate "status" concept invented —
  // this is a read-side classification over the same Fulfillment Order /
  // Pick Task / Pack Task / Shipment records everything else already
  // uses). An order that already has a Shipment leaves this dashboard's
  // concern entirely (it belongs to the Shipments screen from there).
  const buckets: Record<Bucket, SalesOrder[]> = { new: [], preparation: [], ready: [] };
  for (const order of salesOrders) {
    const fo = foBySalesOrderId.get(order.id);
    if (!fo) {
      buckets.new.push(order);
      continue;
    }
    if (shippedFoIds.has(fo.id)) continue;
    const pack = packByFoId.get(fo.id);
    if (pack && pack.state === 'closed') buckets.ready.push(order);
    else buckets.preparation.push(order);
  }

  async function openOrder(salesOrderId: string) {
    setError(null);
    try {
      const full = await api.get<OrderDetail>(`/sales-orders/${salesOrderId}`);
      setDetail(full);
      setView({ kind: 'detail', salesOrderId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load order.');
    }
  }

  /**
   * A truly new order: create its Fulfillment Order, then receive+start
   * its Pick Task, in one click. Loads the per-item breakdown directly
   * here (not left to the `view`-keyed effect alone) — `loadAll`/
   * `openOrder` both update state asynchronously, and the item table
   * must be there the instant this screen re-renders, not a tick later.
   */
  async function receiveNewOrder(salesOrderId: string) {
    setBusy(salesOrderId);
    setError(null);
    try {
      const created = await api.post<{ fulfillmentOrder: FulfillmentOrderRow; pickTask: Task }>('/fulfillment/orders', {
        salesOrderId,
      });
      await api.post(`/fulfillment/pick-tasks/${created.pickTask.id}/receive-and-start`);
      await Promise.all([loadAll(), openOrder(salesOrderId), loadPickTaskLines(created.pickTask.id)]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to receive order.');
    } finally {
      setBusy(null);
    }
  }

  /** Same combined action, for a Pick Task whose Fulfillment Order already exists (e.g. the user navigated away and came back). */
  async function receiveAndStartExisting(pickTaskId: string, salesOrderId: string) {
    setBusy(pickTaskId);
    setError(null);
    try {
      await api.post(`/fulfillment/pick-tasks/${pickTaskId}/receive-and-start`);
      await Promise.all([loadAll(), openOrder(salesOrderId), loadPickTaskLines(pickTaskId)]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to receive order.');
    } finally {
      setBusy(null);
    }
  }

  /** "تم التغليف وجاهز للشحن" — Preparation Review + the whole Pack Task cycle, in one click. */
  async function finishAndReadyForShipping(pickTaskId: string, salesOrderId: string) {
    setBusy(pickTaskId + 'finish');
    setError(null);
    try {
      await api.post(`/fulfillment/pick-tasks/${pickTaskId}/finish-and-ready-for-shipping`, {});
      await loadAll();
      await openOrder(salesOrderId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to finish packing.');
    } finally {
      setBusy(null);
    }
  }

  async function transitionPick(id: string, action: string, salesOrderId: string) {
    setBusy(id + action);
    setError(null);
    try {
      await api.post(`/fulfillment/pick-tasks/${id}/transition`, { action });
      await loadAll();
      await openOrder(salesOrderId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update pick task.');
    } finally {
      setBusy(null);
    }
  }

  async function transitionPack(id: string, action: string, salesOrderId: string) {
    setBusy(id + action);
    setError(null);
    try {
      await api.post(`/fulfillment/pack-tasks/${id}/transition`, { action });
      await loadAll();
      await openOrder(salesOrderId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update pack task.');
    } finally {
      setBusy(null);
    }
  }

  const canAct = can('wf.inventory.fulfillment.worker', 'editable');

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.fulfillment')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      {view.kind !== 'dashboard' && (
        <button className="btn btn-secondary" style={{ marginBottom: 16 }} onClick={() => setView({ kind: 'dashboard' })}>
          {t('action.back_to_dashboard')}
        </button>
      )}

      {view.kind === 'dashboard' && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          {(
            [
              ['new', 'dashboard.new_orders'],
              ['preparation', 'dashboard.under_preparation'],
              ['ready', 'dashboard.ready_for_shipping'],
            ] as const
          ).map(([bucket, labelKey]) => (
            <button
              key={bucket}
              className="card"
              style={{ minWidth: 180, textAlign: 'center', cursor: 'pointer', border: 'none' }}
              onClick={() => setView({ kind: 'list', bucket })}
            >
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{buckets[bucket].length}</div>
              <div style={{ color: '#6b7280' }}>{t(labelKey)}</div>
            </button>
          ))}
        </div>
      )}

      {view.kind === 'list' && (
        <div>
          <h3>
            {t(
              view.bucket === 'new'
                ? 'dashboard.new_orders'
                : view.bucket === 'preparation'
                  ? 'dashboard.under_preparation'
                  : 'dashboard.ready_for_shipping',
            )}
          </h3>
          {buckets[view.bucket].length === 0 ? (
            <div className="empty-state">{t('panel.no_orders_in_bucket')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.order_number')}</th>
                  <th>{t('field.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {buckets[view.bucket].map((order) => (
                  <tr key={order.id} style={{ cursor: 'pointer' }} onClick={() => openOrder(order.id)}>
                    <td>{order.orderNumber}</td>
                    <td>
                      <button className="btn btn-secondary" onClick={() => openOrder(order.id)}>
                        {t('field.new_order_detail')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view.kind === 'detail' && detail && (
        <div>
          <div className="card" style={{ marginBottom: 20, maxWidth: 640 }}>
            <h3 style={{ marginTop: 0 }}>
              {t('field.new_order_detail')} — {detail.orderNumber}
            </h3>
            <div className="detail-grid">
              <div className="detail-field">
                <div className="label">{t('field.customer')}</div>
                <div className="value">{detail.customerName ?? '—'}</div>
              </div>
              <div className="detail-field">
                <div className="label">{t('field.sales_rep')}</div>
                <div className="value">{detail.salesRepName ?? '—'}</div>
              </div>
              <div className="detail-field">
                <div className="label">{t('field.customer_phone')}</div>
                <div className="value">{detail.customerPhone ?? '—'}</div>
              </div>
              <div className="detail-field">
                <div className="label">{t('field.governorate')}</div>
                <div className="value">{detail.customerGovernorate ?? '—'}</div>
              </div>
              <div className="detail-field" style={{ gridColumn: '1 / -1' }}>
                <div className="label">{t('field.address')}</div>
                <div className="value">{detail.customerAddress ?? '—'}</div>
              </div>
            </div>
          </div>

          {(() => {
            // CTO directive — the order's own items shown as a read-only
            // preview BEFORE the responsible person decides to receive,
            // so that decision follows reviewing the customer data AND
            // the order's internal items/quantities, not before it.
            const itemsPreview = (
              <div className="card" style={{ maxWidth: 760, marginBottom: 16 }}>
                <h3 style={{ marginTop: 0 }}>{t('panel.order_items_preview')}</h3>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('field.sku')}</th>
                      <th>{t('field.name')}</th>
                      <th>{t('field.quantity')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => {
                      const product = products.find((p) => p.id === line.productId);
                      return (
                        <tr key={line.id}>
                          <td>{product?.sku ?? '—'}</td>
                          <td>{product?.name ?? line.productId}</td>
                          <td>{line.quantity}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );

            const fo = foBySalesOrderId.get(detail.id);

            if (!fo) {
              return (
                <div>
                  {itemsPreview}
                  {canAct && (
                    <button className="btn btn-primary" disabled={busy === detail.id} onClick={() => receiveNewOrder(detail.id)}>
                      {t('action.receive_and_start')}
                    </button>
                  )}
                </div>
              );
            }

            const pick = pickByFoId.get(fo.id);
            const pack = packByFoId.get(fo.id);

            if (pick && pick.state !== 'closed' && pick.state !== 'cancelled') {
              // A freshly-created Pick Task sits at "assigned" — same combined action as a brand-new order.
              if (pick.state === 'assigned' && canAct) {
                return (
                  <div>
                    {itemsPreview}
                    <button
                      className="btn btn-primary"
                      style={{ marginInlineEnd: 8 }}
                      disabled={busy === pick.id}
                      onClick={() => receiveAndStartExisting(pick.id, detail.id)}
                    >
                      {t('action.receive_and_start')}
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={busy === pick.id + 'cancel'}
                      onClick={() => transitionPick(pick.id, 'cancel', detail.id)}
                    >
                      {t('fulfillment_task.action.cancel')}
                    </button>
                  </div>
                );
              }
              // CTO directive ("PRIORITY: ITEM PREPARATION") — while a pick
              // task is actively being worked, show the per-item breakdown
              // instead of the generic single "complete" button. Completion
              // is no longer a manual click here: `markPickTaskLineDone`
              // auto-advances the task through the Process Engine once
              // every line is fully prepared (see `loadPickTaskLines`'s
              // effect above, which then re-renders this block as
              // `pending_verification` — the existing review UI, unchanged).
              if (pick.state === 'in_progress') {
                const remainingCount = pickTaskLines.filter((l) => l.status !== 'prepared').length;
                return (
                  <div className="card" style={{ maxWidth: 760 }}>
                    <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3 style={{ margin: 0 }}>
                        {t('panel.preparation_items')}
                        {fo.orderNumber && (
                          <span style={{ color: '#6b7280', fontWeight: 400 }}>
                            {' '}
                            — {t('field.fulfillment_order_number')}: {fo.orderNumber}
                          </span>
                        )}
                      </h3>
                      {canAct && remainingCount > 0 && (
                        <button
                          className="btn btn-primary"
                          disabled={busy === pick.id + 'all'}
                          onClick={() => prepareAllLines(pick.id, detail.id)}
                        >
                          {t('action.mark_all_done')}
                        </button>
                      )}
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>{t('field.sku')}</th>
                          <th>{t('field.name')}</th>
                          <th>{t('field.requested_quantity')}</th>
                          <th>{t('field.prepared_quantity')}</th>
                          <th>{t('field.remaining_quantity')}</th>
                          <th>{t('field.status')}</th>
                          {canAct && <th>{t('field.actions')}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {pickTaskLines.map((line) => {
                          const product = products.find((p) => p.id === line.productId);
                          const remaining = line.requestedQuantity - line.preparedQuantity;
                          const isDone = line.status === 'prepared';
                          return (
                            <tr key={line.id} style={isDone ? { backgroundColor: '#d1fae5' } : undefined}>
                              <td>{product?.sku ?? '—'}</td>
                              <td>{product?.name ?? line.productId}</td>
                              <td>{line.requestedQuantity}</td>
                              <td>{line.preparedQuantity}</td>
                              <td>{remaining}</td>
                              <td>
                                <StatusBadge code={`prep_item_status.${line.status}`} />
                              </td>
                              {canAct && (
                                <td>
                                  {line.status !== 'prepared' && (
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                      <input
                                        type="number"
                                        min={1}
                                        max={remaining}
                                        value={prepQuantities[line.id] ?? String(remaining)}
                                        onChange={(e) =>
                                          setPrepQuantities((prev) => ({ ...prev, [line.id]: e.target.value }))
                                        }
                                        style={{ width: 70 }}
                                      />
                                      <button
                                        className="btn btn-secondary"
                                        disabled={busy === line.id}
                                        onClick={() => prepareLine(pick.id, line.id, detail.id)}
                                      >
                                        {t('action.mark_done')}
                                      </button>
                                    </div>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <button
                      className="btn btn-secondary"
                      style={{ marginTop: 10 }}
                      onClick={() => window.open(`/print/pick/${pick.id}`, '_blank')}
                    >
                      {t('action.print')}
                    </button>
                  </div>
                );
              }

              // CTO directive — every item just turned green; one click
              // ("تم التغليف وجاهز للشحن") runs Preparation Review + the
              // whole Pack Task cycle back-to-back, landing straight on
              // Ready for Shipping. `reject_verification` stays available
              // as the safety valve back to Preparation, same generic
              // action as before.
              if (pick.state === 'pending_verification') {
                return (
                  <div className="card" style={{ maxWidth: 480 }}>
                    {fo.orderNumber && (
                      <div style={{ marginBottom: 6, color: '#6b7280' }}>
                        {t('field.fulfillment_order_number')}: {fo.orderNumber}
                      </div>
                    )}
                    <div style={{ marginBottom: 10 }}>
                      <StatusBadge code={`fulfillment_task.state.${pick.state}`} />
                    </div>
                    {canAct && (
                      <>
                        <button
                          className="btn btn-primary"
                          style={{ marginInlineEnd: 6 }}
                          disabled={busy === pick.id + 'finish'}
                          onClick={() => finishAndReadyForShipping(pick.id, detail.id)}
                        >
                          {t('action.finish_packing_ready_for_shipping')}
                        </button>
                        <button
                          className="btn btn-secondary"
                          disabled={busy === pick.id + 'reject_verification'}
                          onClick={() => transitionPick(pick.id, 'reject_verification', detail.id)}
                        >
                          {t('fulfillment_task.action.reject_verification')}
                        </button>
                      </>
                    )}
                    <button className="btn btn-secondary" style={{ marginInlineStart: 6 }} onClick={() => window.open(`/print/pick/${pick.id}`, '_blank')}>
                      {t('action.print')}
                    </button>
                  </div>
                );
              }

              return (
                <div className="card" style={{ maxWidth: 480 }}>
                  <div style={{ marginBottom: 10 }}>
                    <StatusBadge code={`fulfillment_task.state.${pick.state}`} />
                  </div>
                  {canAct &&
                    (PICK_ACTIONS[pick.state] ?? []).map((action) => (
                      <button
                        key={action}
                        className="btn btn-secondary"
                        style={{ marginInlineEnd: 6 }}
                        disabled={busy === pick.id + action}
                        onClick={() => transitionPick(pick.id, action, detail.id)}
                      >
                        {t(`fulfillment_task.action.${action}`)}
                      </button>
                    ))}
                  <button className="btn btn-secondary" onClick={() => window.open(`/print/pick/${pick.id}`, '_blank')}>
                    {t('action.print')}
                  </button>
                </div>
              );
            }

            if (pack && pack.state !== 'closed' && pack.state !== 'cancelled') {
              return (
                <div className="card" style={{ maxWidth: 480 }}>
                  <div style={{ marginBottom: 10 }}>
                    <StatusBadge code={`fulfillment_task.state.${pack.state}`} />
                  </div>
                  {canAct &&
                    (PICK_ACTIONS[pack.state] ?? []).map((action) => (
                      <button
                        key={action}
                        className="btn btn-secondary"
                        style={{ marginInlineEnd: 6 }}
                        disabled={busy === pack.id + action}
                        onClick={() => transitionPack(pack.id, action, detail.id)}
                      >
                        {/* CTO directive — the final packing step reads "انتهاء التغليف ونقل إلى الشحن", not the generic "verify" label used elsewhere. */}
                        {action === 'verify' ? t('action.finish_packing') : t(`fulfillment_task.action.${action}`)}
                      </button>
                    ))}
                  <button className="btn btn-secondary" onClick={() => window.open(`/print/pack/${pack.id}`, '_blank')}>
                    {t('action.print')}
                  </button>
                </div>
              );
            }

            // Pack closed, no shipment yet — ready for shipping.
            return <StatusBadge code="dashboard.ready_for_shipping" />;
          })()}
        </div>
      )}
    </div>
  );
}
