import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { ReturnsTabs } from '../components/ReturnsTabs';
import { StatusBadge } from '../components/StatusBadge';

/**
 * Sales/Shipment/Returns workflow review (CTO directive, 2026-09-16).
 * A Shipment Return always starts from an existing Shipment (never
 * standalone) and supports Full or Partial mode, per shipment line —
 * mirrors `pages/Returns.tsx`'s list+create shape, adapted for the new
 * `/shipment-returns` API (separate namespace, separate document, never
 * conflated with `ReturnRequest`'s custody-reversal flow on that page).
 */
interface ShipmentSummary {
  id: string;
  waybillNumber: string;
  rshNumber: string | null;
  salesOrderNumber: string | null;
  customerName: string | null;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}
interface ShipmentReturnRow {
  id: string;
  returnNumber: string;
  shipmentId: string;
  returnMode: 'full' | 'partial';
  state: string;
  totalAmount: string;
  customerName: string | null;
  createdAt: string;
}
interface ShipmentReturnDetail {
  header: { id: string; returnNumber: string; shipmentId: string; returnMode: 'full' | 'partial' };
  state: string;
  totalAmount: string;
  customerName: string | null;
  lines: Array<{ productId: string; returnQuantity: number; returnPrice: string; lineTotal: string; shipmentLineId: string }>;
}
interface ReturnableLine {
  shipmentLineId: string;
  productId: string;
  shippedQuantity: number;
  unitPrice: string;
  previouslyReturned: number;
  remaining: number;
}
interface DraftLine {
  shipmentLineId: string;
  productId: string;
  shippedQuantity: number;
  previouslyReturned: number;
  remaining: number;
  returnQuantity: number;
  returnPrice: string;
}

export function ShipmentReturns() {
  const { can } = useAuth();
  const { t, preload } = useLanguage();
  preload([
    'panel.no_shipment_returns_yet',
    'field.shipment',
    'field.return_number',
    'field.return_mode',
    'field.customer',
    'field.return_amount',
    'field.status',
    'field.actions',
    'field.product',
    'field.shipped_quantity',
    'field.previously_returned_quantity',
    'field.available_quantity',
    'field.return_quantity',
    'field.return_price',
    'field.item_total',
    'field.total_return_amount',
    'return_mode.full',
    'return_mode.partial',
    'action.create',
    'action.complete',
    'action.add_item',
    'action.view_details',
  ]);

  const [searchParams] = useSearchParams();

  const [rows, setRows] = useState<ShipmentReturnRow[]>([]);
  const [shipments, setShipments] = useState<ShipmentSummary[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<ShipmentReturnDetail | null>(null);

  // Deep-linked from the Shipments detail screen's "Create Shipment Return" action.
  const [shipmentId, setShipmentId] = useState(() => searchParams.get('shipmentId') ?? '');
  const [returnMode, setReturnMode] = useState<'full' | 'partial'>('full');
  const [reason, setReason] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);

  async function loadAll() {
    try {
      const [rowsData, shipmentsData, productsData] = await Promise.all([
        api.get<ShipmentReturnRow[]>('/shipment-returns'),
        api.get<ShipmentSummary[]>('/shipments'),
        api.get<Product[]>('/products/all'),
      ]);
      setRows(rowsData);
      setShipments(shipmentsData);
      setProducts(productsData);
    } catch (err) {
      // Foundation fix: mount-time load had no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load shipment returns.');
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const productLabel = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  useEffect(() => {
    setDraftLines([]);
    if (!shipmentId) return;
    (async () => {
      const returnable = await api.get<ReturnableLine[]>(`/shipment-returns/returnable-lines/${shipmentId}`);
      setDraftLines(
        returnable.map((l) => ({
          shipmentLineId: l.shipmentLineId,
          productId: l.productId,
          shippedQuantity: l.shippedQuantity,
          previouslyReturned: l.previouslyReturned,
          remaining: l.remaining,
          returnQuantity: returnMode === 'full' ? l.remaining : 0,
          returnPrice: l.unitPrice,
        })),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentId]);

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setDraftLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const totalReturnAmount = draftLines.reduce((sum, l) => sum + Number(l.returnPrice || 0) * Number(l.returnQuantity || 0), 0);

  async function createShipmentReturn() {
    setBusy('create');
    setError(null);
    try {
      const lines = draftLines
        .filter((l) => l.returnQuantity > 0)
        .map((l) => ({ shipmentLineId: l.shipmentLineId, returnQuantity: l.returnQuantity, returnPrice: l.returnPrice }));
      await api.post('/shipment-returns', { shipmentId, returnMode, lines, reason: reason || undefined });
      setShipmentId('');
      setReturnMode('full');
      setReason('');
      setDraftLines([]);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create shipment return.');
    } finally {
      setBusy(null);
    }
  }

  async function complete(id: string) {
    setBusy(id + 'complete');
    setError(null);
    try {
      await api.post(`/shipment-returns/${id}/complete`, {});
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to complete shipment return.');
    } finally {
      setBusy(null);
    }
  }

  async function viewDetail(id: string) {
    const detail = await api.get<ShipmentReturnDetail>(`/shipment-returns/${id}`);
    setDetailFor(detail);
  }

  // SHR-01: the picker names the customer too, so the operator can tell which customer's shipment they are returning.
  const shipmentLabel = (s: ShipmentSummary) => `${s.rshNumber ?? s.waybillNumber}${s.salesOrderNumber ? ` — ${s.salesOrderNumber}` : ''}${s.customerName ? ` — ${s.customerName}` : ''}`;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.shipment_returns')}</h1>
      </div>
      <ReturnsTabs />

      {error && <div className="error-text">{error}</div>}

      {can('wf.logistics.return.request', 'editable') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>{t('action.create')}</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
              <label>{t('field.shipment')}</label>
              <select value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
                <option value="">—</option>
                {shipments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {shipmentLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>{t('field.return_mode')}</label>
              <select
                value={returnMode}
                onChange={(e) => {
                  const mode = e.target.value as 'full' | 'partial';
                  setReturnMode(mode);
                  setDraftLines((prev) =>
                    prev.map((l) => ({ ...l, returnQuantity: mode === 'full' ? l.remaining : 0 })),
                  );
                }}
              >
                <option value="full">{t('return_mode.full')}</option>
                <option value="partial">{t('return_mode.partial')}</option>
              </select>
            </div>
            <div className="form-field" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
              <label>{t('field.reason')}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>

          {draftLines.length > 0 && (
            <table className="data-table" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>{t('field.product')}</th>
                  <th>{t('field.shipped_quantity')}</th>
                  <th>{t('field.previously_returned_quantity')}</th>
                  <th>{t('field.available_quantity')}</th>
                  <th>{t('field.return_quantity')}</th>
                  <th>{t('field.return_price')}</th>
                  <th>{t('field.item_total')}</th>
                </tr>
              </thead>
              <tbody>
                {draftLines.map((l, i) => (
                  <tr key={l.shipmentLineId}>
                    <td>{productLabel(l.productId)}</td>
                    <td>{l.shippedQuantity}</td>
                    <td>{l.previouslyReturned}</td>
                    <td>{l.remaining}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={l.remaining}
                        disabled={returnMode === 'full'}
                        value={l.returnQuantity}
                        onChange={(e) => updateLine(i, { returnQuantity: Number(e.target.value) })}
                        style={{ width: 80 }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={l.returnPrice}
                        onChange={(e) => updateLine(i, { returnPrice: e.target.value })}
                        style={{ width: 100 }}
                      />
                    </td>
                    <td>{(Number(l.returnPrice || 0) * Number(l.returnQuantity || 0)).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>
              {t('field.total_return_amount')}: {totalReturnAmount.toFixed(2)}
            </strong>
            <button
              className="btn btn-primary"
              disabled={busy === 'create' || !shipmentId || draftLines.every((l) => l.returnQuantity <= 0)}
              onClick={createShipmentReturn}
            >
              {t('action.create')}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty-state">{t('panel.no_shipment_returns_yet')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('field.return_number')}</th>
              <th>{t('field.customer')}</th>
              <th>{t('field.return_mode')}</th>
              <th>{t('field.return_amount')}</th>
              <th>{t('field.status')}</th>
              <th>{t('field.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }}>
                <td onClick={() => viewDetail(r.id)}>{r.returnNumber}</td>
                <td onClick={() => viewDetail(r.id)}>{r.customerName ?? '—'}</td>
                <td onClick={() => viewDetail(r.id)}>{t(`return_mode.${r.returnMode}`)}</td>
                <td onClick={() => viewDetail(r.id)}>{r.totalAmount}</td>
                <td onClick={() => viewDetail(r.id)}>
                  <StatusBadge code={`shipment_return.state.${r.state}`} />
                </td>
                <td>
                  <button className="btn btn-secondary" style={{ marginInlineEnd: 6 }} onClick={() => viewDetail(r.id)}>
                    {t('action.view_details')}
                  </button>
                  {r.state === 'requested' && can('wf.logistics.return.receive', 'editable') && (
                    <button className="btn btn-primary" disabled={busy === r.id + 'complete'} onClick={() => complete(r.id)}>
                      {t('action.complete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detailFor && (
        <div className="card" style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={{ marginTop: 0 }}>
              {t('field.return_number')}: {detailFor.header.returnNumber}
            </h3>
            <button className="btn btn-secondary" onClick={() => setDetailFor(null)}>
              ×
            </button>
          </div>
          <div>
            {t('field.customer')}: <strong>{detailFor.customerName ?? '—'}</strong>
          </div>
          <div>
            {t('field.status')}: <StatusBadge code={`shipment_return.state.${detailFor.state}`} />
          </div>
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>{t('field.product')}</th>
                <th>{t('field.return_quantity')}</th>
                <th>{t('field.return_price')}</th>
                <th>{t('field.item_total')}</th>
              </tr>
            </thead>
            <tbody>
              {detailFor.lines.map((l) => (
                <tr key={l.shipmentLineId}>
                  <td>{productLabel(l.productId)}</td>
                  <td>{l.returnQuantity}</td>
                  <td>{l.returnPrice}</td>
                  <td>{l.lineTotal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
