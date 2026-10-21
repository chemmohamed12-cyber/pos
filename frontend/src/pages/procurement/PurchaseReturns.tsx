import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { FinancialTrace } from '../../components/FinancialTrace';
import { currentLang, loadingLabel } from '../../lib/displayNames';

interface Supplier {
  id: string;
  code: string;
  legalName: string;
}
interface ProductOption {
  id: string;
  sku: string;
  name: string;
}
interface ReturnRow {
  id: string;
  returnNumber: string;
  supplierId: string;
  reason: string;
  state: string;
  createdByUserId: string;
  rejectedReason?: string | null;
  createdAt: string;
}
interface ReturnLine {
  id: string;
  goodsReceiptLineId: string;
  productId: string;
  quantity: string;
  receiptUnitCostBase: string;
  exitValueBase: string | null;
  differenceBase: string | null;
  supplierInvoiceLineId?: string | null;
  creditNetBase?: string | null;
  creditTaxBase?: string | null;
}
interface Returnable {
  goodsReceiptLineId: string;
  grNumber: string;
  productId: string;
  unitCostBase: string;
  returnable: string;
}
/** phase D-3: goods that were already invoiced - returned against their invoice line (the supplier's credit is recorded with the return) */
interface ReturnableInvoiced extends Returnable {
  supplierInvoiceLineId: string;
  invoiceNumber: string;
}

/**
 * Phase D-1 (D7) - Purchase Returns: goods received but not yet invoiced going back to the supplier. Create from the returnable receipt lines of one supplier, submit, approve (a different person),
 * post. A posted return shows the cost that left the stock, the receipt cost and the difference (E3). Invoiced goods are returned through a credit note, not here. Rules live on the server.
 */
export function PurchaseReturns() {
  const { authz, can } = useAuth();
  const { t, preload } = useLanguage();
  const ar = currentLang() === 'ar';
  const L = (a: string, e: string) => (ar ? a : e);
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<(ReturnRow & { lines: ReturnLine[] }) | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [returnable, setReturnable] = useState<Returnable[]>([]);
  const [returnableInvoiced, setReturnableInvoiced] = useState<ReturnableInvoiced[]>([]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [actionReason, setActionReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload(['nav.purchase_returns', 'panel.no_purchase_returns_yet', 'field.supplier', 'field.status', 'field.quantity', 'field.product', 'purchase_return_lifecycle.state.draft']);
  const canCreate = authz ? can('procurement.purchase_return.create', 'editable') : false;
  const canSubmit = authz ? can('procurement.purchase_return.submit', 'editable') : false;
  const canApprove = authz ? can('procurement.purchase_return.approve', 'editable') : false;
  const canPost = authz ? can('procurement.purchase_return.post', 'editable') : false;

  async function load() {
    try {
      const [list, sup, prod] = await Promise.all([api.get<ReturnRow[]>('/procurement/purchase-returns'), api.get<Supplier[]>('/procurement/suppliers/all'), api.get<ProductOption[]>('/products/all')]);
      setRows(list);
      setSuppliers(sup);
      setProducts(prod);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load purchase returns.');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setQty({});
    if (!supplierId) {
      setReturnable([]);
      setReturnableInvoiced([]);
      return;
    }
    api
      .get<ReturnableInvoiced[]>(`/procurement/purchase-returns/returnable-invoiced?supplierId=${supplierId}`)
      .then(setReturnableInvoiced)
      .catch(() => setReturnableInvoiced([]));
    api
      .get<Returnable[]>(`/procurement/purchase-returns/returnable?supplierId=${supplierId}`)
      .then(setReturnable)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load returnable goods.'));
  }, [supplierId]);

  async function loadDetail(id: string) {
    setSelectedId(id);
    try {
      setDetail(await api.get<ReturnRow & { lines: ReturnLine[] }>(`/procurement/purchase-returns/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the return.');
    }
  }

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.legalName ?? id;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const lines = [
      ...returnable.filter((r) => Number(qty[r.goodsReceiptLineId] ?? 0) > 0).map((r) => ({ goodsReceiptLineId: r.goodsReceiptLineId, quantity: qty[r.goodsReceiptLineId] })),
      ...returnableInvoiced
        .filter((r) => Number(qty[`inv:${r.supplierInvoiceLineId}:${r.goodsReceiptLineId}`] ?? 0) > 0)
        .map((r) => ({ goodsReceiptLineId: r.goodsReceiptLineId, supplierInvoiceLineId: r.supplierInvoiceLineId, quantity: qty[`inv:${r.supplierInvoiceLineId}:${r.goodsReceiptLineId}`] })),
    ];
    if (lines.length === 0) return;
    setBusy('create');
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/procurement/purchase-returns', { reason, lines });
      setReason('');
      setSupplierId('');
      await load();
      await loadDetail(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the return.');
    } finally {
      setBusy(null);
    }
  }

  async function act(action: string, body?: Record<string, string>) {
    if (!selectedId) return;
    setBusy(action);
    setError(null);
    try {
      await api.post(`/procurement/purchase-returns/${selectedId}/${action}`, body);
      setActionReason('');
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.purchase_returns')}</h1>
      </div>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        {L('إرجاع بضاعة مستلمة لم تُفوتر بعد إلى المورد. البضاعة المفوترة تُرجَع من خلال إشعار دائن.', 'Returning goods that were received but not yet invoiced to the supplier. Invoiced goods go back through a credit note.')}
      </p>

      {canCreate && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{L('المورد', 'Supplier')}</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.legalName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 260, flex: 1 }}>
                <label>{L('سبب الإرجاع', 'Return reason')}</label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} required />
              </div>
            </div>
            {supplierId && returnable.length === 0 && returnableInvoiced.length === 0 && <div className="empty-state">{L('لا توجد بضاعة قابلة للإرجاع لهذا المورد.', 'No returnable goods for this supplier.')}</div>}
            {returnableInvoiced.length > 0 && (
              <>
                <h4 style={{ margin: '4px 0' }}>{L('بضاعة مفوترة (يُسجَّل ائتمان المورد مع المردود)', 'Invoiced goods (the supplier credit is recorded with the return)')}</h4>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{L('الفاتورة', 'Invoice')}</th>
                      <th>{L('إذن الاستلام', 'Goods receipt')}</th>
                      <th>{L('الصنف', 'Item')}</th>
                      <th>{L('القابل للإرجاع', 'Returnable')}</th>
                      <th>{L('سعر الفاتورة', 'Invoice price')}</th>
                      <th>{L('الكمية المرتجعة', 'Quantity to return')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returnableInvoiced.map((r) => {
                      const key = `inv:${r.supplierInvoiceLineId}:${r.goodsReceiptLineId}`;
                      return (
                        <tr key={key}>
                          <td>{r.invoiceNumber}</td>
                          <td>{r.grNumber}</td>
                          <td>{productName(r.productId)}</td>
                          <td>{Number(r.returnable)}</td>
                          <td>{Number(r.unitCostBase).toFixed(2)}</td>
                          <td>
                            <input type="number" min={0} max={Number(r.returnable)} step="0.001" value={qty[key] ?? ''} onChange={(e) => setQty((p) => ({ ...p, [key]: e.target.value }))} style={{ width: 100 }} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
            {returnable.length > 0 && (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{L('إذن الاستلام', 'Goods receipt')}</th>
                    <th>{L('الصنف', 'Item')}</th>
                    <th>{L('القابل للإرجاع', 'Returnable')}</th>
                    <th>{L('تكلفة الاستلام', 'Receipt cost')}</th>
                    <th>{L('الكمية المرتجعة', 'Quantity to return')}</th>
                  </tr>
                </thead>
                <tbody>
                  {returnable.map((r) => (
                    <tr key={r.goodsReceiptLineId}>
                      <td>{r.grNumber}</td>
                      <td>{productName(r.productId)}</td>
                      <td>{Number(r.returnable)}</td>
                      <td>{Number(r.unitCostBase).toFixed(2)}</td>
                      <td>
                        <input type="number" min={0} max={Number(r.returnable)} step="0.001" value={qty[r.goodsReceiptLineId] ?? ''} onChange={(e) => setQty((p) => ({ ...p, [r.goodsReceiptLineId]: e.target.value }))} style={{ width: 100 }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div>
              <button className="btn btn-primary" type="submit" disabled={busy === 'create' || (returnable.length === 0 && returnableInvoiced.length === 0)}>
                {L('إنشاء مردود (مسودة)', 'Create return (draft)')}
              </button>
            </div>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 480px', minWidth: 0 }}>
          {rows === null ? (
            <div className="empty-state">{loadingLabel()}</div>
          ) : rows.length === 0 ? (
            <div className="empty-state">{t('panel.no_purchase_returns_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{L('رقم المردود', 'Return no.')}</th>
                  <th>{L('المورد', 'Supplier')}</th>
                  <th>{L('السبب', 'Reason')}</th>
                  <th>{L('الحالة', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer', background: r.id === selectedId ? 'rgba(37, 99, 235, 0.06)' : undefined }} onClick={() => loadDetail(r.id)}>
                    <td>{r.returnNumber}</td>
                    <td>{supplierName(r.supplierId)}</td>
                    <td>{r.reason}</td>
                    <td>
                      <StatusBadge code={`purchase_return_lifecycle.state.${r.state}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div className="card" style={{ width: 440, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>{detail.returnNumber}</h3>
              <StatusBadge code={`purchase_return_lifecycle.state.${detail.state}`} />
            </div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {supplierName(detail.supplierId)} — {detail.reason}
            </div>
            {detail.rejectedReason && detail.state === 'rejected' && <div style={{ fontSize: 12, marginBottom: 8 }}>{L('سبب الرفض', 'Rejection reason')}: {detail.rejectedReason}</div>}
            <table className="data-table" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>{L('الصنف', 'Item')}</th>
                  <th>{L('الكمية', 'Qty')}</th>
                  <th>{L('قيمة الاستلام / ائتمان المورد', 'Receipt value / supplier credit')}</th>
                  {detail.state === 'posted' && <th>{L('قيمة الخروج', 'Exit value')}</th>}
                  {detail.state === 'posted' && <th>{L('الفرق', 'Difference')}</th>}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{productName(l.productId)}</td>
                    <td>{Number(l.quantity)}</td>
                    <td>
                      {l.supplierInvoiceLineId ? `${Number(l.creditNetBase ?? 0).toFixed(2)} + ${Number(l.creditTaxBase ?? 0).toFixed(2)} ${L('ضريبة', 'VAT')}` : (Number(l.quantity) * Number(l.receiptUnitCostBase)).toFixed(2)}
                    </td>
                    {detail.state === 'posted' && <td>{Number(l.exitValueBase ?? 0).toFixed(2)}</td>}
                    {detail.state === 'posted' && <td>{Number(l.differenceBase ?? 0).toFixed(2)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {detail.state === 'draft' && canSubmit && (
                <button className="btn btn-primary" disabled={busy === 'submit'} onClick={() => act('submit')}>
                  {L('إرسال للاعتماد', 'Submit for approval')}
                </button>
              )}
              {detail.state === 'submitted' && canApprove && (
                <button className="btn btn-primary" disabled={busy === 'approve'} onClick={() => act('approve')}>
                  {L('اعتماد', 'Approve')}
                </button>
              )}
              {detail.state === 'approved' && canPost && (
                <button className="btn btn-primary" disabled={busy === 'post'} onClick={() => act('post')}>
                  {L('ترحيل (خروج البضاعة)', 'Post (stock leaves)')}
                </button>
              )}
              {detail.state === 'rejected' && canCreate && (
                <button className="btn btn-secondary" disabled={busy === 'reopen'} onClick={() => act('reopen')}>
                  {L('إعادة فتح كمسودة', 'Reopen as draft')}
                </button>
              )}
            </div>
            {['draft', 'submitted', 'approved', 'rejected'].includes(detail.state) && (canApprove || canCreate) && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input value={actionReason} onChange={(e) => setActionReason(e.target.value)} placeholder={L('سبب الرفض / الإلغاء', 'Rejection / cancellation reason')} maxLength={500} />
                <div style={{ display: 'flex', gap: 8 }}>
                  {detail.state === 'submitted' && canApprove && (
                    <button className="btn btn-danger" disabled={busy === 'reject' || actionReason.trim().length < 3} onClick={() => act('reject', { reason: actionReason })}>
                      {L('رفض', 'Reject')}
                    </button>
                  )}
                  {canCreate && (
                    <button className="btn btn-secondary" disabled={busy === 'cancel' || actionReason.trim().length < 3} onClick={() => act('cancel', { reason: actionReason })}>
                      {L('إلغاء المسودة', 'Cancel')}
                    </button>
                  )}
                </div>
              </div>
            )}
            {detail.state === 'posted' && <FinancialTrace ids={[detail.id]} />}
          </div>
        )}
      </div>
    </div>
  );
}
