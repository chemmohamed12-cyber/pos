import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { StatusBadge } from '../../components/StatusBadge';
import { FinancialTrace } from '../../components/FinancialTrace';

interface Supplier {
  id: string;
  code: string;
  legalName: string;
}
interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  supplierId: string;
}
interface PurchaseOrderLine {
  id: string;
  productId: string;
  quantity: string;
  unitCostBase: string;
  quantityReceived: string;
  quantityInvoiced: string;
}
interface SupplierInvoiceRow {
  id: string;
  invoiceNumber: string;
  supplierReference: string | null;
  supplierId: string;
  purchaseOrderId: string;
  totalAmount: string;
  /** D5 — the explicit VAT stated by the supplier's invoice (totalAmount is NET). */
  taxAmount?: string;
  dueDate: string | null;
  priceVarianceAmount: string;
  state: string;
  remaining: string;
}
interface SupplierInvoiceLine {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  quantity: string;
  unitCostBase: string;
  lineTotalBase: string;
  unitCostVariance: string;
}
interface TreasuryAccount {
  id: string;
  code: string;
  name: string;
}
interface ProductOption {
  id: string;
  sku: string;
  name: string;
}

const CREATABLE_PO_STATES = new Set(['partially_received', 'received', 'closed']);

/**
 * ADR-048 — the `supplier-finance` bounded context's operational screen:
 * raise a Supplier Invoice against a received Purchase Order (3-way match
 * enforced server-side), post it to AP, then record payments against it.
 */
export function SupplierInvoices() {
  const { hasRole } = useAuth();
  const { t, preload } = useLanguage();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<Array<PurchaseOrderRow & { state: string }>>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [treasuryAccounts, setTreasuryAccounts] = useState<TreasuryAccount[]>([]);
  const [invoices, setInvoices] = useState<SupplierInvoiceRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<(SupplierInvoiceRow & { lines: SupplierInvoiceLine[] }) | null>(null);
  // NAV-07 — ids of this invoice's supplier payments (their financial events are keyed by payment id)
  const [paymentIds, setPaymentIds] = useState<string[]>([]);

  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [poLines, setPoLines] = useState<PurchaseOrderLine[]>([]);
  const [invoiceQty, setInvoiceQty] = useState<Record<string, string>>({});
  const [invoiceCost, setInvoiceCost] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('bank_transfer');
  const [paymentTreasuryAccountId, setPaymentTreasuryAccountId] = useState('');
  const [paying, setPaying] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  preload([
    'nav.supplier_invoices',
    'field.supplier',
    'field.po_number',
    'field.invoice_number',
    'field.supplier_reference',
    'field.total_amount',
    'field.vat_amount',
    'field.due_date',
    'field.price_variance',
    'field.status',
    'field.product',
    'field.quantity',
    'field.quantity_received',
    'field.unit_cost',
    'field.line_total',
    'field.remaining',
    'field.payment_method',
    'field.treasury_account',
    'field.amount',
    'action.create_supplier_invoice',
    'action.post_invoice',
    'action.void_invoice',
    'action.record_payment',
    'panel.no_supplier_invoices_yet',
    'supplier_invoice_lifecycle.state.draft',
    'supplier_invoice_lifecycle.state.posted',
    'supplier_invoice_lifecycle.state.partially_paid',
    'supplier_invoice_lifecycle.state.paid',
    'supplier_invoice_lifecycle.state.void',
  ]);

  async function load() {
    try {
      const [inv, sup, po, prod, treasury] = await Promise.all([
        api.get<SupplierInvoiceRow[]>('/procurement/supplier-invoices'),
        api.get<Supplier[]>('/procurement/suppliers/all'),
        api.get<Array<PurchaseOrderRow & { state: string }>>('/procurement/purchase-orders'),
        api.get<ProductOption[]>('/products/all'),
        api.get<TreasuryAccount[]>('/treasury/accounts'),
      ]);
      setInvoices(inv);
      setSuppliers(sup);
      setPurchaseOrders(po.filter((p) => CREATABLE_PO_STATES.has(p.state)));
      setProducts(prod);
      setTreasuryAccounts(treasury);
      if (treasury[0]) setPaymentTreasuryAccountId((v) => v || treasury[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load supplier invoices.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!purchaseOrderId) {
      setPoLines([]);
      return;
    }
    api
      .get<{ lines: PurchaseOrderLine[] }>(`/procurement/purchase-orders/${purchaseOrderId}`)
      .then((d) => {
        setPoLines(d.lines);
        const qty: Record<string, string> = {};
        const cost: Record<string, string> = {};
        for (const l of d.lines) {
          const remaining = Number(l.quantityReceived) - Number(l.quantityInvoiced);
          if (remaining > 0) {
            qty[l.id] = String(remaining);
            cost[l.id] = l.unitCostBase;
          }
        }
        setInvoiceQty(qty);
        setInvoiceCost(cost);
      })
      .catch((err) => {
        // Foundation fix: no error handling — a failure silently left the PO-lines picker empty.
        setError(err instanceof ApiError ? err.message : 'Failed to load purchase order lines.');
      });
  }, [purchaseOrderId]);

  async function loadDetail(id: string) {
    setSelectedId(id);
    try {
      const d = await api.get<SupplierInvoiceRow & { lines: SupplierInvoiceLine[] }>(`/procurement/supplier-invoices/${id}`);
      setDetail(d);
      setPaymentAmount(d.remaining);
      api
        .get<Array<{ id: string; supplierInvoiceId: string }>>(`/procurement/supplier-payments/by-supplier/${d.supplierId}`)
        .then((rows) => setPaymentIds((Array.isArray(rows) ? rows : []).filter((p) => p.supplierInvoiceId === id).map((p) => p.id)))
        .catch(() => setPaymentIds([])); // not permitted to view supplier payments: the invoice's own trace still shows
    } catch (err) {
      // Foundation fix: called directly from a row onClick with no error handling.
      setError(err instanceof ApiError ? err.message : 'Failed to load supplier invoice detail.');
    }
  }

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.legalName ?? id;
  const poNumber = (id: string) => purchaseOrders.find((p) => p.id === id)?.poNumber ?? id;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const lines = poLines
      .filter((l) => Number(invoiceQty[l.id] ?? 0) > 0)
      .map((l) => ({ purchaseOrderLineId: l.id, quantity: invoiceQty[l.id], unitCostBase: invoiceCost[l.id] || l.unitCostBase }));
    if (!purchaseOrderId || lines.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/procurement/supplier-invoices', { purchaseOrderId, supplierReference: supplierReference || undefined, taxAmount: taxAmount || undefined, lines });
      setPurchaseOrderId('');
      setSupplierReference('');
      setPoLines([]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create supplier invoice.');
    } finally {
      setCreating(false);
    }
  }

  async function doAction(action: 'post' | 'void') {
    if (!selectedId) return;
    setBusyAction(action);
    setError(null);
    try {
      if (action === 'void') {
        await api.post(`/procurement/supplier-invoices/${selectedId}/void`, { reason: 'Voided from Supplier Invoices screen' });
      } else {
        await api.post(`/procurement/supplier-invoices/${selectedId}/post`);
      }
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${action} invoice.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function onRecordPayment(e: FormEvent) {
    e.preventDefault();
    if (!selectedId || !detail || !paymentTreasuryAccountId) return;
    setPaying(true);
    setError(null);
    try {
      await api.post('/procurement/supplier-payments', {
        supplierId: detail.supplierId,
        invoiceId: selectedId,
        amount: paymentAmount,
        method: paymentMethod,
        treasuryAccountId: paymentTreasuryAccountId,
      });
      await load();
      await loadDetail(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record payment.');
    } finally {
      setPaying(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.supplier_invoices')}</h1>
      </div>

      {hasRole('admin') && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={onCreate}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
              <div className="form-field" style={{ marginBottom: 0, minWidth: 220 }}>
                <label>{t('field.po_number')}</label>
                <select value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)} required>
                  <option value="">—</option>
                  {purchaseOrders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.poNumber} — {supplierName(p.supplierId)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.supplier_reference')}</label>
                <input value={supplierReference} onChange={(e) => setSupplierReference(e.target.value)} />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label>{t('field.vat_amount')}</label>
                <input type="number" min={0} step="0.01" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} placeholder="0.00" />
              </div>
            </div>

            {poLines.length > 0 && (
              <table className="data-table" style={{ marginBottom: 14 }}>
                <thead>
                  <tr>
                    <th>{t('field.product')}</th>
                    <th>{t('field.quantity_received')}</th>
                    <th>{t('field.quantity')}</th>
                    <th>{t('field.unit_cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {poLines.map((l) => {
                    const remaining = Number(l.quantityReceived) - Number(l.quantityInvoiced);
                    if (remaining <= 0) return null;
                    return (
                      <tr key={l.id}>
                        <td>{productName(l.productId)}</td>
                        <td>{remaining}</td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            max={remaining}
                            step="0.001"
                            value={invoiceQty[l.id] ?? ''}
                            onChange={(e) => setInvoiceQty((prev) => ({ ...prev, [l.id]: e.target.value }))}
                            style={{ width: 90 }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            step="0.0001"
                            value={invoiceCost[l.id] ?? ''}
                            onChange={(e) => setInvoiceCost((prev) => ({ ...prev, [l.id]: e.target.value }))}
                            style={{ width: 100 }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <button className="btn btn-primary" type="submit" disabled={creating || !purchaseOrderId}>
              {t('action.create_supplier_invoice')}
            </button>
          </form>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {invoices === null ? (
            <div className="empty-state">Loading…</div>
          ) : invoices.length === 0 ? (
            <div className="empty-state">{t('panel.no_supplier_invoices_yet')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('field.invoice_number')}</th>
                  <th>{t('field.supplier')}</th>
                  <th>{t('field.po_number')}</th>
                  <th>{t('field.total_amount')}</th>
                  <th>{t('field.vat_amount')}</th>
                  <th>{t('field.remaining')}</th>
                  <th>{t('field.price_variance')}</th>
                  <th>{t('field.status')}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} style={{ cursor: 'pointer' }} onClick={() => loadDetail(inv.id)}>
                    <td>{inv.invoiceNumber}</td>
                    <td>{supplierName(inv.supplierId)}</td>
                    <td>{poNumber(inv.purchaseOrderId)}</td>
                    <td>{inv.totalAmount}</td>
                    <td>{inv.taxAmount ?? '0.00'}</td>
                    <td>{inv.remaining}</td>
                    <td style={{ color: Number(inv.priceVarianceAmount) > 0 ? '#b45309' : undefined }}>{inv.priceVarianceAmount}</td>
                    <td>
                      <StatusBadge code={`supplier_invoice_lifecycle.state.${inv.state}`} />
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
              <h3 style={{ margin: 0 }}>{detail.invoiceNumber}</h3>
              <StatusBadge code={`supplier_invoice_lifecycle.state.${detail.state}`} />
            </div>

            {hasRole('admin') && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                {detail.state === 'draft' && (
                  <>
                    <button className="btn btn-primary" disabled={busyAction === 'post'} onClick={() => doAction('post')}>
                      {t('action.post_invoice')}
                    </button>
                    <button className="btn btn-danger" disabled={busyAction === 'void'} onClick={() => doAction('void')}>
                      {t('action.void_invoice')}
                    </button>
                  </>
                )}
                {(detail.state === 'posted' || detail.state === 'partially_paid') && (
                  <button className="btn btn-danger" disabled={busyAction === 'void'} onClick={() => doAction('void')}>
                    {t('action.void_invoice')}
                  </button>
                )}
              </div>
            )}

            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>{t('field.product')}</th>
                  <th>{t('field.quantity')}</th>
                  <th>{t('field.unit_cost')}</th>
                  <th>{t('field.price_variance')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{productName(l.productId)}</td>
                    <td>{l.quantity}</td>
                    <td>{l.unitCostBase}</td>
                    <td style={{ color: Number(l.unitCostVariance) !== 0 ? '#b45309' : undefined }}>{l.unitCostVariance}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <FinancialTrace ids={[detail.id, ...paymentIds]} />

            {(detail.state === 'posted' || detail.state === 'partially_paid') && hasRole('admin') && Number(detail.remaining) > 0 && (
              <form onSubmit={onRecordPayment} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h4 style={{ margin: 0 }}>{t('action.record_payment')}</h4>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.amount')}</label>
                  <input type="number" min={0} max={Number(detail.remaining)} step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} required />
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.payment_method')}</label>
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="cash">Cash</option>
                    <option value="cheque">Cheque</option>
                  </select>
                </div>
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label>{t('field.treasury_account')}</label>
                  <select value={paymentTreasuryAccountId} onChange={(e) => setPaymentTreasuryAccountId(e.target.value)} required>
                    {treasuryAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn btn-primary" type="submit" disabled={paying}>
                  {t('action.record_payment')}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
