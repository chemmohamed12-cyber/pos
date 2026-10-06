import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';

interface OrderLine {
  productId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}
interface Order {
  orderNumber: string;
  repSequenceNumber: number;
  customerId: string;
  customerAddress: string | null;
  customerGovernorate: string | null;
  shippingMethod: 'company_vehicles' | 'shipping_company' | null;
  totalAmount: string;
  status: string;
  createdAt: string;
  lines: OrderLine[];
}
interface Deposit {
  status: string;
}

interface SalesOrderPrintData {
  order: Order;
  customer: { id: string; name: string; phone: string | null } | undefined;
  products: Array<{ id: string; name: string; sku: string }>;
  deposit: Deposit | null;
}

export function SalesOrderPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, lang, preload } = useLanguage();
  const [data, setData] = useState<SalesOrderPrintData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload([
    'document.sales_order_title', 'field.customer', 'field.governorate', 'field.address',
    'field.rep_sequence_number', 'field.shipping_method', 'field.deposit_status', 'field.total_amount',
  ]);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const [order, customers, products, deposit] = await Promise.all([
          api.get<Order>(`/sales-orders/${id}`),
          api.get<Array<{ id: string; name: string; phone: string | null }>>('/customers'),
          api.get<Array<{ id: string; name: string; sku: string }>>('/products/all'),
          api.get<Deposit | null>(`/deposits?salesOrderId=${id}`).catch(() => null),
        ]);
        const customer = customers.find((c) => c.id === order.customerId);

        setData({ order, customer, products, deposit });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { order, customer, products, deposit } = data;
  const productName = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  const doc: BusinessDocument = {
    documentTitleCode: 'document.sales_order_title',
    documentNumber: order.orderNumber,
    issuedAt: order.createdAt,
    statusLabel: t(`sales_order_approval.state.${order.status}`),
    fields: [
      { label: t('field.customer'), value: customer?.name ?? order.customerId },
      { label: lang === 'ar' ? 'هاتف العميل' : 'Customer Phone', value: customer?.phone ?? '—' },
      { label: t('field.governorate'), value: order.customerGovernorate ?? '—' },
      { label: t('field.address'), value: order.customerAddress ?? '—' },
      { label: t('field.rep_sequence_number'), value: String(order.repSequenceNumber) },
      {
        label: t('field.shipping_method'),
        value: order.shippingMethod ? t(`shipping_method.${order.shippingMethod}`) : '—',
      },
      { label: t('field.deposit_status'), value: deposit ? t(`deposit.status.${deposit.status}`) : '—' },
    ],
    lines: order.lines.map((l) => ({
      label: productName(l.productId),
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      total: l.lineTotal,
    })),
    totals: [{ label: t('field.total_amount'), value: order.totalAmount }],
  };

  return <PrintDocument doc={doc} />;
}
