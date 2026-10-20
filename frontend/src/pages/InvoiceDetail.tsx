import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../context/LanguageContext';
import { StatusBadge } from '../components/StatusBadge';
import { FinancialTrace } from '../components/FinancialTrace';
import { fmtDate } from '../lib/formatDateTime';
import { loadingLabel } from '../lib/displayNames';

interface InvoiceLine {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  lineTotal: string;
}
interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  salesOrderId: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  dueDate: string | null;
  state: string;
  remaining: string;
  lines: InvoiceLine[];
}
interface Customer {
  id: string;
  code: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
  sku: string;
}
interface SalesOrder {
  id: string;
  orderNumber: string;
}

/**
 * ERP UI Integration (CTO directive §8) — "الفواتير" list's own detail
 * screen, and the destination of the Sales Order → Invoice cross-link.
 * Reads the SAME `GET /invoices/:id` the Customer Account page's create/
 * post/void actions already use — this screen is read-only navigation,
 * the actions themselves stay on Customer Account (their one home).
 */
export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, preload } = useLanguage();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  preload([
    'field.invoice_number',
    'field.customer',
    'field.sales_order',
    'field.total_amount',
    'field.due_date',
    'field.remaining',
    'field.status',
    'field.quantity',
    'field.unit_price',
    'action.back',
    'action.view_customer_account',
    'action.print',
    'nav.sales_orders',
  ]);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const inv = await api.get<Invoice>(`/invoices/${id}`);
        setInvoice(inv);
        const [cust, ord, prods] = await Promise.all([
          api.get<Customer>(`/customers/${inv.customerId}`),
          api.get<SalesOrder>(`/sales-orders/${inv.salesOrderId}`),
          api.get<Product[]>('/products/all'),
        ]);
        setCustomer(cust);
        setOrder(ord);
        setProducts(prods);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load invoice.');
      }
    })();
  }, [id]);

  if (error) return <div className="error-text">{error}</div>;
  if (!invoice) return <div className="empty-state">{loadingLabel()}</div>;

  return (
    <div>
      <div className="page-header">
        <h1>{t('field.invoice_number')} — {invoice.invoiceNumber}</h1>
      </div>

      <button className="btn btn-secondary" style={{ marginBottom: 16 }} onClick={() => navigate('/invoices')}>
        {t('action.back')}
      </button>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="detail-grid">
          <div className="detail-field">
            <div className="label">{t('field.customer')}</div>
            <div className="value">
              {customer ? (
                <a onClick={() => navigate(`/customers/${customer.id}/account`)} style={{ cursor: 'pointer' }}>
                  {customer.code} — {customer.name}
                </a>
              ) : (
                '—'
              )}
            </div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.sales_order')}</div>
            <div className="value">
              {order ? (
                <a onClick={() => navigate(`/sales-orders/${order.id}`)} style={{ cursor: 'pointer' }}>
                  {order.orderNumber}
                </a>
              ) : (
                '—'
              )}
            </div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.status')}</div>
            <div className="value">
              <StatusBadge code={`sales_invoice_lifecycle.state.${invoice.state}`} />
            </div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.due_date')}</div>
            <div className="value">{invoice.dueDate ? fmtDate(invoice.dueDate) : '—'}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.total_amount')}</div>
            <div className="value">{invoice.totalAmount}</div>
          </div>
          <div className="detail-field">
            <div className="label">{t('field.remaining')}</div>
            <div className="value">{invoice.remaining}</div>
          </div>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t('field.quantity')}</th>
            <th>{t('field.unit_price')}</th>
            <th>{t('field.total_amount')}</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => {
            const product = products.find((p) => p.id === l.productId);
            return (
              <tr key={l.id}>
                <td>{product ? `${product.sku} — ${product.name}` : l.productId} × {l.quantity}</td>
                <td>{l.unitPrice}</td>
                <td>{l.lineTotal}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 16 }}>
        <FinancialTrace ids={[invoice.id]} />
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary" onClick={() => window.open(`/print/invoice/${invoice.id}`, '_blank')}>
          {t('action.print')}
        </button>
        {customer && (
          <button className="btn btn-secondary" onClick={() => navigate(`/customers/${customer.id}/account`)}>
            {t('action.view_customer_account')}
          </button>
        )}
      </div>
    </div>
  );
}
