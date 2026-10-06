import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { StockCell, useStockAvailability } from '../../components/StockAvailability';

interface Supplier {
  id: string;
  code: string;
  legalName: string;
}
interface RfqRow {
  id: string;
  rfqNumber: string;
  purchaseRequestId: string;
  state: string;
  createdAt: string;
}
interface Quotation {
  id: string;
  quotationNumber: string;
  supplierId: string;
  totalAmount: string;
  createdAt: string;
}
interface PurchaseRequestLine {
  id: string;
  productId: string;
  quantity: string;
}
/** D6 — the visible state of the award's maker-checker approval (read-only; the rule itself is unchanged). */
interface AwardApproval {
  approvalRequestId: string;
  state: string;
  makerUserId: string;
  submittedAt: string;
  decidedAt: string | null;
  requiredNode: string;
  minApprovers: number;
  approvedCount: number;
  supplierId: string | null;
  totalAmount: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
}
interface RfqDetail {
  /** PRC-01 — the originating Purchase Request's warehouse (for the stock lookup). */
  warehouseId?: string | null;
  awardApproval?: AwardApproval | null;
  rfq: RfqRow;
  state: string;
  invitedSupplierIds: string[];
  quotations: Quotation[];
  purchaseRequestLines: PurchaseRequestLine[];
}
interface ProductOption {
  id: string;
  sku: string;
  name: string;
}

/** ADR-048 — Path B, steps 2-4: RFQ, Supplier Quotations (side-by-side comparison, cheapest first), and the Evaluation/Approval award step. */
export function Rfqs() {
  const { hasRole, user } = useAuth();
  const { t, preload } = useLanguage();
  const [searchParams] = useSearchParams();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [rfqs, setRfqs] = useState<RfqRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id'));
  const [detail, setDetail] = useState<RfqDetail | null>(null);

  const [quoteSupplierId, setQuoteSupplierId] = useState('');
  const [quoteLines, setQuoteLines] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // PRC-01 — official on-hand / reserved / available for the request's warehouse (read-only, informational)
  const stock = useStockAvailability(detail?.warehouseId, (detail?.purchaseRequestLines ?? []).map((l) => l.productId));

  preload([
    'field.on_hand',
    'field.reserved',
    'field.available',
    'nav.rfqs',
    'panel.award_pending_approval',
    'panel.award_pending_hint',
    'panel.award_submitted_by_you',
    'panel.award_approved_po',
    'panel.award_rejected_hint',
    'panel.award_submitted_notice',
    'field.approval_request_id',
    'field.required_permission_node',
    'action.open_approvals',
    'field.rfq_number',
    'field.quotation_number',
    'field.invited_suppliers',
    'field.quotations',
    'field.total_quotation_amount',
    'field.supplier',
    'field.status',
    'field.product',
    'field.quantity',
    'field.unit_cost',
    'action.send_rfq',
    'action.cancel',
    'action.record_quotation',
    'action.award',
    'panel.no_rfqs_yet',
    'panel.no_quotations_yet',
    'rfq_lifecycle.state.draft',
    'rfq_lifecycle.state.sent',
    'rfq_lifecycle.state.awarded',
    'rfq_lifecycle.state.cancelled',
  ]);

  async function load() {
    try {
      const [r, sup, prod] = await Promise.all([
        api.get<RfqRow[]>('/procurement/rfqs'),
        api.get<Supplier[]>('/procurement/suppliers/all'),
        api.get<ProductOption[]>('/products/all'),
      ]);
      setRfqs(r);
      setSuppliers(sup);
      setProducts(prod);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load RFQs.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function loadDetail(id: string) {
    setSelectedId(id);
    try {
      const d = await api.get<RfqDetail>(`/procurement/rfqs/${id}`);
      setDetail(d);
      if (d.invitedSupplierIds[0]) setQuoteSupplierId((v) => v || d.invitedSupplierIds[0]);
    } catch (err) {
      // Foundation fix: called from a row onClick and from a mount effect below, neither guarded.
      setError(err instanceof ApiError ? err.message : 'Failed to load RFQ detail.');
    }
  }

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.legalName ?? id;
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  async function doAction(action: 'send' | 'cancel') {
    if (!selectedId) return;
    setBusyAction(action);
    setError(null);
    try {
      await api.post(`/procurement/rfqs/${selectedId}/${action}`);
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} RFQ.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onRecordQuotation(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || !quoteSupplierId || !detail) return;
    const lines = detail.purchaseRequestLines
      .filter((l) => Number(quoteLines[l.id] ?? 0) > 0)
      .map((l) => ({ purchaseRequestLineId: l.id, quantity: l.quantity, unitCostBase: quoteLines[l.id] }));
    if (lines.length === 0) return;
    setRecording(true);
    setError(null);
    try {
      await api.post(`/procurement/rfqs/${selectedId}/quotations`, { supplierId: quoteSupplierId, lines });
      setQuoteLines({});
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record quotation.');
    } finally {
      setRecording(false);
    }
  }

  async function onAward(quotationId: string) {
    if (!selectedId) return;
    setBusyAction('award');
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<{ approvalRequestId: string }>(`/procurement/rfqs/${selectedId}/award`, { quotationId });
      setNotice(`${t('panel.award_submitted_notice')} (${res.approvalRequestId})`);
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit award for approval.');
    } finally {
      setBusyAction(null);
    }
  }

  const cheapestId = detail && detail.quotations.length > 0 ? detail.quotations[0].id : null;
  const award = detail?.awardApproval ?? null;
  const awardPending = award?.state === 'pending' || award?.state === 'escalated';
  const awardIsMine = !!award && !!user && award.makerUserId === user.id;

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.rfqs')}</h1>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {rfqs === null ? (
            <div className="empty-state">Loading…</div>
          ) : rfqs.length === 0 ? (
            <div className="empty-state">{t('panel.no_rfqs_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.rfq_number')}</th>
                  <th>{t('field.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rfqs.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => loadDetail(r.id)}>
                    <td>{r.rfqNumber}</td>
                    <td>
                      <StatusBadge code={`rfq_lifecycle.state.${r.state}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div className="card" style={{ width: 460, flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{detail.rfq.rfqNumber}</h3>
              <StatusBadge code={`rfq_lifecycle.state.${detail.state}`} />
            </div>

            {notice && <div style={{ color: '#166534', marginBottom: 8 }}>{notice}</div>}
            {award && (
              <div
                className="card"
                style={{ marginBottom: 14, padding: 10, borderInlineStart: `4px solid ${award.state === 'approved' ? '#16a34a' : award.state === 'rejected' ? '#dc2626' : '#d97706'}` }}
              >
                {awardPending && (
                  <>
                    <strong>{t('panel.award_pending_approval')}</strong>
                    <div style={{ fontSize: '0.85rem', marginTop: 4 }}>
                      {t('field.approval_request_id')}: <code>{award.approvalRequestId}</code> · {supplierName(award.supplierId ?? '')} · {award.totalAmount}
                    </div>
                    <div style={{ fontSize: '0.85rem', marginTop: 4 }}>
                      {awardIsMine ? t('panel.award_submitted_by_you') + ' — ' : ''}
                      {t('panel.award_pending_hint')} (<code>{award.requiredNode}</code> × {award.minApprovers}; {award.approvedCount}/{award.minApprovers})
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <Link to="/approvals">{t('action.open_approvals')}</Link>
                    </div>
                  </>
                )}
                {award.state === 'approved' && (
                  <strong>
                    {t('panel.award_approved_po')}: {award.purchaseOrderNumber ?? '—'}
                  </strong>
                )}
                {(award.state === 'rejected' || award.state === 'withdrawn' || award.state === 'expired') && (
                  <>
                    <strong>{award.state}</strong>
                    <div style={{ fontSize: '0.85rem', marginTop: 4 }}>{t('panel.award_rejected_hint')}</div>
                  </>
                )}
              </div>
            )}

            {hasRole('admin') && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                {detail.state === 'draft' && (
                  <button className="btn btn-primary" disabled={busyAction === 'send'} onClick={() => doAction('send')}>
                    {t('action.send_rfq')}
                  </button>
                )}
                {(detail.state === 'draft' || detail.state === 'sent') && (
                  <button className="btn btn-danger" disabled={busyAction === 'cancel'} onClick={() => doAction('cancel')}>
                    {t('action.cancel')}
                  </button>
                )}
              </div>
            )}

            <h4>{t('field.invited_suppliers')}</h4>
            <ul style={{ paddingInlineStart: 18, marginBottom: 14 }}>
              {detail.invitedSupplierIds.map((id) => (
                <li key={id}>{supplierName(id)}</li>
              ))}
            </ul>

            <h4>{t('field.quotations')}</h4>
            {detail.quotations.length === 0 ? (
              <div className="empty-state" style={{ padding: 10 }}>
                {t('panel.no_quotations_yet')}
              </div>
            ) : (
              <table className="data-table" style={{ marginBottom: 14 }}>
                <thead>
                  <tr>
                    <th>{t('field.supplier')}</th>
                    <th>{t('field.total_quotation_amount')}</th>
                    {hasRole('admin') && detail.state === 'sent' && !awardPending && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {detail.quotations.map((q) => (
                    <tr key={q.id} style={q.id === cheapestId ? { background: '#e8f6ee' } : undefined}>
                      <td>{supplierName(q.supplierId)}</td>
                      <td>{q.totalAmount}</td>
                      {hasRole('admin') && detail.state === 'sent' && !awardPending && (
                        <td>
                          <button className="btn btn-secondary" disabled={busyAction === 'award'} onClick={() => onAward(q.id)}>
                            {t('action.award')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {detail.state === 'sent' && hasRole('admin') && (
              <form onSubmit={onRecordQuotation} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h4 style={{ margin: 0 }}>{t('action.record_quotation')}</h4>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.supplier')}</label>
                  <select value={quoteSupplierId} onChange={(e) => setQuoteSupplierId(e.target.value)}>
                    {detail.invitedSupplierIds.map((id) => (
                      <option key={id} value={id}>
                        {supplierName(id)}
                      </option>
                    ))}
                  </select>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('field.product')}</th>
                      <th>{t('field.quantity')}</th>
                      <th>{t('field.on_hand')} / {t('field.reserved')} / {t('field.available')}</th>
                      <th>{t('field.unit_cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.purchaseRequestLines.map((l) => (
                      <tr key={l.id}>
                        <td>{productName(l.productId)}</td>
                        <td>{l.quantity}</td>
                        <StockCell stock={stock[l.productId]} />
                        <td>
                          <input
                            type="number"
                            min={0}
                            step="0.0001"
                            value={quoteLines[l.id] ?? ''}
                            onChange={(e) => setQuoteLines((prev) => ({ ...prev, [l.id]: e.target.value }))}
                            style={{ width: 100 }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="btn btn-primary" type="submit" disabled={recording}>
                  {t('action.record_quotation')}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
