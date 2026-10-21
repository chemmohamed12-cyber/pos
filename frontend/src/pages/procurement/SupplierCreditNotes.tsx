import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { FinancialTrace } from '../../components/FinancialTrace';
import { currentLang, loadingLabel } from '../../lib/displayNames';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  state: string;
  remaining: string;
}
interface Supplier {
  id: string;
  legalName: string;
}
interface ProductOption {
  id: string;
  name: string;
}
interface NoteRow {
  id: string;
  creditNoteNumber: string;
  supplierInvoiceId: string;
  supplierId: string;
  reason: string;
  netAmount: string;
  taxAmount: string;
  state: string;
  rejectedReason?: string | null;
}
interface Creditable {
  supplierInvoiceLineId: string;
  productId: string;
  quantity: string;
  lineNet: string;
  credited: string;
  remaining: string;
  /** posted returns of invoiced goods billed on this line that no credit note has settled yet */
  pendingReturns?: Array<{ purchaseReturnLineId: string; returnNumber: string; quantity: string; clearingValueBase: string }>;
}

/**
 * Phase D-2 (D6) - supplier credit notes linked to the original invoice and its lines. Pick a posted invoice, enter the net value credited per line (never above what is still creditable), submit,
 * approve (a different person), post. The VAT follows the invoice proportionally. A credit after payment is allowed: it lowers the invoice balance and may leave a credit balance with the supplier.
 */
export function SupplierCreditNotes() {
  const { authz, can } = useAuth();
  const { t, preload } = useLanguage();
  const ar = currentLang() === 'ar';
  const L = (a: string, e: string) => (ar ? a : e);
  const [rows, setRows] = useState<NoteRow[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [creditable, setCreditable] = useState<Creditable[]>([]);
  const [amount, setAmount] = useState<Record<string, string>>({});
  // which pending return (if any) each credited line settles
  const [settles, setSettles] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<(NoteRow & { lines: Array<{ id: string; supplierInvoiceLineId: string; amount: string }> }) | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload(['nav.supplier_credit_notes', 'panel.no_supplier_credit_notes_yet']);
  const canCreate = authz ? can('procurement.supplier_credit_note.create', 'editable') : false;
  const canSubmit = authz ? can('procurement.supplier_credit_note.submit', 'editable') : false;
  const canApprove = authz ? can('procurement.supplier_credit_note.approve', 'editable') : false;
  const canPost = authz ? can('procurement.supplier_credit_note.post', 'editable') : false;

  async function load() {
    try {
      const [list, inv, sup, prod] = await Promise.all([
        api.get<NoteRow[]>('/procurement/supplier-credit-notes'),
        api.get<InvoiceRow[]>('/procurement/supplier-invoices'),
        api.get<Supplier[]>('/procurement/suppliers/all'),
        api.get<ProductOption[]>('/products/all'),
      ]);
      setRows(list);
      setInvoices(inv.filter((i) => ['posted', 'partially_paid', 'paid'].includes(i.state)));
      setSuppliers(sup);
      setProducts(prod);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load credit notes.');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setAmount({});
    setSettles({});
    if (!invoiceId) {
      setCreditable([]);
      return;
    }
    api
      .get<Creditable[]>(`/procurement/supplier-credit-notes/creditable?supplierInvoiceId=${invoiceId}`)
      .then(setCreditable)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the invoice lines.'));
  }, [invoiceId]);

  async function loadDetail(id: string) {
    setSelectedId(id);
    try {
      setDetail(await api.get(`/procurement/supplier-credit-notes/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the credit note.');
    }
  }

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.legalName ?? id;
  const invoiceNumber = (id: string) => invoices.find((i) => i.id === id)?.invoiceNumber ?? id;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const lines = creditable
      .filter((c) => Number(amount[c.supplierInvoiceLineId] ?? 0) > 0)
      .map((c) => ({ supplierInvoiceLineId: c.supplierInvoiceLineId, amount: Number(amount[c.supplierInvoiceLineId]).toFixed(2), purchaseReturnLineId: settles[c.supplierInvoiceLineId] || undefined }));
    if (lines.length === 0) return;
    setBusy('create');
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/procurement/supplier-credit-notes', { supplierInvoiceId: invoiceId, reason, supplierReference: supplierReference || undefined, lines });
      setReason('');
      setSupplierReference('');
      setInvoiceId('');
      await load();
      await loadDetail(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the credit note.');
    } finally {
      setBusy(null);
    }
  }

  async function act(action: string, body?: Record<string, string>) {
    if (!selectedId) return;
    setBusy(action);
    setError(null);
    try {
      await api.post(`/procurement/supplier-credit-notes/${selectedId}/${action}`, body);
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
        <h1>{t('nav.supplier_credit_notes')}</h1>
      </div>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        {L('إشعار دائن من المورد مرتبط بالفاتورة الأصلية وبنودها. البضاعة التي تعود فعليًا تُرجَع من «مردودات المشتريات».', 'A supplier credit linked to the original invoice and its lines. Goods that physically go back are returned through Purchase Returns.')}
      </p>

      {canCreate && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 260 }}>
                <label>{L('الفاتورة', 'Invoice')}</label>
                <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                  <option value="">—</option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.invoiceNumber} — {supplierName(i.supplierId)} ({L('المتبقي', 'remaining')} {i.remaining})
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 240, flex: 1 }}>
                <label>{L('السبب', 'Reason')}</label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} required />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{L('مرجع المورد', 'Supplier reference')}</label>
                <input value={supplierReference} onChange={(e) => setSupplierReference(e.target.value)} maxLength={64} />
              </div>
            </div>
            {creditable.length > 0 && (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{L('الصنف', 'Item')}</th>
                    <th>{L('صافي البند', 'Line net')}</th>
                    <th>{L('تم ائتمانه', 'Credited')}</th>
                    <th>{L('المتاح', 'Remaining')}</th>
                    <th>{L('قيمة الإشعار', 'Credit amount')}</th>
                    <th>{L('يسوّي مردودًا', 'Settles a return')}</th>
                  </tr>
                </thead>
                <tbody>
                  {creditable.map((c) => (
                    <tr key={c.supplierInvoiceLineId}>
                      <td>{productName(c.productId)}</td>
                      <td>{c.lineNet}</td>
                      <td>{c.credited}</td>
                      <td>{c.remaining}</td>
                      <td>
                        <input type="number" min={0} max={Number(c.remaining)} step="0.01" value={amount[c.supplierInvoiceLineId] ?? ''} onChange={(e) => setAmount((p) => ({ ...p, [c.supplierInvoiceLineId]: e.target.value }))} style={{ width: 110 }} />
                      </td>
                      <td>
                        {(c.pendingReturns ?? []).length > 0 ? (
                          <select value={settles[c.supplierInvoiceLineId] ?? ''} onChange={(e) => setSettles((p) => ({ ...p, [c.supplierInvoiceLineId]: e.target.value }))}>
                            <option value="">{L('— تسوية سعر فقط —', '— price credit only —')}</option>
                            {(c.pendingReturns ?? []).map((r) => (
                              <option key={r.purchaseReturnLineId} value={r.purchaseReturnLineId}>
                                {r.returnNumber} — {Number(r.quantity)} {L('وحدة', 'units')} ({Number(r.clearingValueBase).toFixed(2)})
                              </option>
                            ))}
                          </select>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div>
              <button className="btn btn-primary" type="submit" disabled={busy === 'create' || creditable.length === 0}>
                {L('إنشاء إشعار دائن (مسودة)', 'Create credit note (draft)')}
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
            <div className="empty-state">{t('panel.no_supplier_credit_notes_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{L('رقم الإشعار', 'Credit note')}</th>
                  <th>{L('الفاتورة', 'Invoice')}</th>
                  <th>{L('الصافي', 'Net')}</th>
                  <th>{L('الضريبة', 'VAT')}</th>
                  <th>{L('الحالة', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer', background: r.id === selectedId ? 'rgba(37, 99, 235, 0.06)' : undefined }} onClick={() => loadDetail(r.id)}>
                    <td>{r.creditNoteNumber}</td>
                    <td>{invoiceNumber(r.supplierInvoiceId)}</td>
                    <td>{r.netAmount}</td>
                    <td>{r.taxAmount}</td>
                    <td>
                      <StatusBadge code={`supplier_credit_note_lifecycle.state.${r.state}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div className="card" style={{ width: 420, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>{detail.creditNoteNumber}</h3>
              <StatusBadge code={`supplier_credit_note_lifecycle.state.${detail.state}`} />
            </div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {invoiceNumber(detail.supplierInvoiceId)} — {detail.reason}
              <br />
              {L('الصافي', 'Net')} {detail.netAmount} + {L('الضريبة', 'VAT')} {detail.taxAmount}
            </div>
            {detail.rejectedReason && detail.state === 'rejected' && <div style={{ fontSize: 12, marginBottom: 8 }}>{L('سبب الرفض', 'Rejection reason')}: {detail.rejectedReason}</div>}
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
                  {L('ترحيل', 'Post')}
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
