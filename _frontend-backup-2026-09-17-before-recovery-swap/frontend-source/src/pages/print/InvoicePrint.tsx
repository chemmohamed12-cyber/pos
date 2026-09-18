import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface InvoiceLine {
  productId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}
interface Invoice {
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
  createdByUserId: string;
  createdAt: string;
  lines: InvoiceLine[];
}
interface Customer {
  code: string;
  name: string;
}
interface Order {
  orderNumber: string;
}
interface AdminUser {
  id: string;
  fullName: string;
}

interface InvoicePrintData {
  inv: Invoice;
  customer: Customer;
  order: Order;
  products: Array<{ id: string; name: string; sku: string }>;
  preparer: string | undefined;
}

/**
 * ERP UI Integration (CTO directive) — the Invoice's own printable document, through the SAME shared `PrintDocument` renderer every other document already uses.
 *
 * Hotfix 4 — raw business data is fetched once (effect depends only on
 * `id`, never on `t`); the `BusinessDocument` (which calls `t()`) is built
 * at render time instead of being frozen into state inside the effect.
 * `t()` reads from the current terminology cache on every render, so a
 * fresh print tab (empty cache) never freezes in raw codes like
 * `field.customer` — it just re-renders with real labels the moment they
 * load, the same self-healing pattern `ReportPrint.tsx` already used
 * correctly. This also stops the effect from needlessly re-running (and
 * re-fetching all 4 requests again) every time the terminology cache
 * updates, which happened before because `t`'s identity changes on every
 * `LanguageProvider` re-render and was in this effect's dependency array.
 */
export function InvoicePrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<InvoicePrintData | null>(null);

  preload(['document.invoice_title', 'field.customer', 'field.sales_order', 'field.due_date', 'field.total_amount', 'field.remaining']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const inv = await api.get<Invoice>(`/invoices/${id}`);
      const [customer, order, products, users] = await Promise.all([
        api.get<Customer>(`/customers/${inv.customerId}`),
        api.get<Order>(`/sales-orders/${inv.salesOrderId}`),
        api.get<Array<{ id: string; name: string; sku: string }>>('/products/all'),
        api.get<AdminUser[]>('/admin/users').catch(() => [] as AdminUser[]),
      ]);
      const preparer = users.find((u) => u.id === inv.createdByUserId)?.fullName;
      setData({ inv, customer, order, products, preparer });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { inv, customer, order, products, preparer } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.invoice_title',
    documentNumber: inv.invoiceNumber,
    issuedAt: inv.createdAt,
    statusLabel: t(`sales_invoice_lifecycle.state.${inv.state}`),
    fields: [
      { label: t('field.customer'), value: `${customer.code} — ${customer.name}` },
      { label: t('field.sales_order'), value: order.orderNumber },
      { label: t('field.due_date'), value: inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '—' },
    ],
    lines: inv.lines.map((l) => {
      const product = products.find((p) => p.id === l.productId);
      return { label: product ? `${product.sku} — ${product.name}` : l.productId, quantity: l.quantity, unitPrice: l.unitPrice, total: l.lineTotal };
    }),
    totals: [
      { label: t('field.total_amount'), value: inv.totalAmount },
      { label: t('field.remaining'), value: inv.remaining },
    ],
    responsibleUser: preparer,
  };

  return <PrintDocument doc={doc} />;
}
