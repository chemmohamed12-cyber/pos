import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { ProductCombobox, type ProductOption } from '../../components/ProductCombobox';

interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Supplier {
  id: string;
  code: string;
  legalName: string;
}
interface PurchaseRequestRow {
  id: string;
  prNumber: string;
  warehouseId: string;
  state: string;
  createdAt: string;
}
interface PurchaseRequestLine {
  id: string;
  productId: string;
  quantity: string;
}
interface DraftLine {
  productId: string;
  productName: string;
  quantity: string;
}

const CANCELLABLE_STATES = new Set(['draft', 'submitted', 'approved']);

/** ADR-048 — Path B, step 1: Purchase Request (the internal requisition — no cost, cost comes later from RFQ/Quotations). */
export function PurchaseRequests() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const navigate = useNavigate();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [requests, setRequests] = useState<PurchaseRequestRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ purchaseRequest: PurchaseRequestRow; state: string; lines: PurchaseRequestLine[] } | null>(null);

  const [warehouseId, setWarehouseId] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [lineProductSearch, setLineProductSearch] = useState('');
  const [lineQty, setLineQty] = useState('');
  const [creating, setCreating] = useState(false);

  const [invitedSupplierIds, setInvitedSupplierIds] = useState<string[]>([]);
  const [creatingRfq, setCreatingRfq] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.purchase_requests',
    'field.pr_number',
    'field.warehouse',
    'field.product',
    'field.quantity',
    'field.notes',
    'field.status',
    'field.invited_suppliers',
    'action.create_purchase_request',
    'action.add_pr_line',
    'action.submit',
    'action.approve',
    'action.reject',
    'action.cancel',
    'action.create_rfq',
    'panel.no_purchase_requests_yet',
    'purchase_request_lifecycle.state.draft',
    'purchase_request_lifecycle.state.submitted',
    'purchase_request_lifecycle.state.approved',
    'purchase_request_lifecycle.state.rejected',
    'purchase_request_lifecycle.state.cancelled',
    'purchase_request_lifecycle.state.converted_to_rfq',
  ]);

  async function load() {
    try {
      const [pr, wh, sup, prod] = await Promise.all([
        api.get<PurchaseRequestRow[]>('/procurement/purchase-requests'),
        api.get<Warehouse[]>('/inventory/warehouses'),
        api.get<Supplier[]>('/procurement/suppliers/all'),
        api.get<ProductOption[]>('/products/all'),
      ]);
      setRequests(pr);
      setWarehouses(wh);
      setSuppliers(sup);
      setProducts(prod);
      if (wh[0]) setWarehouseId((w) => w || wh[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load purchase requests.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(id: string) {
    setSelectedId(id);
    const d = await api.get<{ purchaseRequest: PurchaseRequestRow; state: string; lines: PurchaseRequestLine[] }>(`/procurement/purchase-requests/${id}`);
    setDetail(d);
    setInvitedSupplierIds([]);
  }

  function addDraftLine() {
    const product = products.find((p) => p.name === lineProductSearch);
    if (!product || !lineQty) return;
    setDraftLines((prev) => [...prev, { productId: product.id, productName: product.name, quantity: lineQty }]);
    setLineProductSearch('');
    setLineQty('');
  }

  function removeDraftLine(i: number) {
    setDraftLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!warehouseId || draftLines.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/procurement/purchase-requests', {
        warehouseId,
        lines: draftLines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      });
      setDraftLines([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create purchase request.');
    } finally {
      setCreating(false);
    }
  }

  async function doTransition(action: 'submit' | 'approve' | 'reject' | 'cancel') {
    if (!selectedId) return;
    setBusyAction(action);
    setError(null);
    try {
      await api.post(`/procurement/purchase-requests/${selectedId}/${action}`);
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} purchase request.`);
    } finally {
      setBusyAction(null);
    }
  }

  function toggleInvite(id: string) {
    setInvitedSupplierIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  async function onCreateRfq() {
    if (!selectedId || invitedSupplierIds.length === 0) return;
    setCreatingRfq(true);
    setError(null);
    try {
      const rfq = await api.post<{ id: string }>(`/procurement/purchase-requests/${selectedId}/create-rfq`, { supplierIds: invitedSupplierIds });
      navigate(`/rfqs?id=${rfq.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create RFQ.');
    } finally {
      setCreatingRfq(false);
    }
  }

  const warehouseName = (id: string) => warehouses.find((w) => w.id === id)?.name ?? id;
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.purchase_requests')}</h1>
      </div>

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate}>
            <div style={{ marginBottom: 14 }}>
              <div className="form-field" style={{ marginBottom: 0, maxWidth: 300 }}>
                <label>{t('field.warehouse')}</label>
                <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ minWidth: 260 }}>
                <ProductCombobox products={products} value={lineProductSearch} onValueChange={setLineProductSearch} onSelect={(p) => setLineProductSearch(p.name)} placeholder={t('field.product')} />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.quantity')}</label>
                <input type="number" min={0} step="0.001" value={lineQty} onChange={(e) => setLineQty(e.target.value)} style={{ width: 100 }} />
              </div>
              <button type="button" className="btn btn-secondary" onClick={addDraftLine}>
                {t('action.add_pr_line')}
              </button>
            </div>

            {draftLines.length > 0 && (
              <table className="data-table" style={{ marginBottom: 14 }}>
                <thead>
                  <tr>
                    <th>{t('field.product')}</th>
                    <th>{t('field.quantity')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draftLines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.productName}</td>
                      <td>{l.quantity}</td>
                      <td>
                        <button type="button" className="btn btn-secondary" onClick={() => removeDraftLine(i)}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <button className="btn btn-primary" type="submit" disabled={creating || draftLines.length === 0}>
              {t('action.create_purchase_request')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {requests === null ? (
            <div className="empty-state">Loading…</div>
          ) : requests.length === 0 ? (
            <div className="empty-state">{t('panel.no_purchase_requests_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.pr_number')}</th>
                  <th>{t('field.warehouse')}</th>
                  <th>{t('field.status')}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => loadDetail(r.id)}>
                    <td>{r.prNumber}</td>
                    <td>{warehouseName(r.warehouseId)}</td>
                    <td>
                      <StatusBadge code={`purchase_request_lifecycle.state.${r.state}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div className="card" style={{ width: 420, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{detail.purchaseRequest.prNumber}</h3>
              <StatusBadge code={`purchase_request_lifecycle.state.${detail.state}`} />
            </div>

            {hasRole('admin') && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                {detail.state === 'draft' && (
                  <button className="btn btn-secondary" disabled={busyAction === 'submit'} onClick={() => doTransition('submit')}>
                    {t('action.submit')}
                  </button>
                )}
                {detail.state === 'submitted' && (
                  <>
                    <button className="btn btn-primary" disabled={busyAction === 'approve'} onClick={() => doTransition('approve')}>
                      {t('action.approve')}
                    </button>
                    <button className="btn btn-secondary" disabled={busyAction === 'reject'} onClick={() => doTransition('reject')}>
                      {t('action.reject')}
                    </button>
                  </>
                )}
                {CANCELLABLE_STATES.has(detail.state) && (
                  <button className="btn btn-danger" disabled={busyAction === 'cancel'} onClick={() => doTransition('cancel')}>
                    {t('action.cancel')}
                  </button>
                )}
              </div>
            )}

            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>{t('field.product')}</th>
                  <th>{t('field.quantity')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{productName(l.productId)}</td>
                    <td>{l.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {detail.state === 'approved' && hasRole('admin') && (
              <div>
                <h4>{t('field.invited_suppliers')}</h4>
                {suppliers.map((s) => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <input type="checkbox" checked={invitedSupplierIds.includes(s.id)} onChange={() => toggleInvite(s.id)} />
                    {s.code} — {s.legalName}
                  </label>
                ))}
                <button className="btn btn-primary" disabled={creatingRfq || invitedSupplierIds.length === 0} onClick={onCreateRfq} style={{ marginTop: 8 }}>
                  {t('action.create_rfq')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
