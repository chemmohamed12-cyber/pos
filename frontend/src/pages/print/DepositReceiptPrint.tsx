import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface Deposit {
  id: string;
  salesOrderId: string;
  amount: string;
  method: string;
  status: string;
  createdAt: string;
}
interface Order {
  orderNumber: string;
  customerId: string;
}

interface DepositReceiptData {
  deposit: Deposit;
  order: Order;
  customer: { id: string; name: string } | undefined;
}

export function DepositReceiptPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<DepositReceiptData | null>(null);

  preload(['document.deposit_receipt_title', 'field.customer', 'field.sales_order', 'field.method', 'field.total_amount']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const deposit = await api.get<Deposit>(`/deposits/${id}`);
      const [order, customers] = await Promise.all([
        api.get<Order>(`/sales-orders/${deposit.salesOrderId}`),
        api.get<Array<{ id: string; name: string }>>('/customers'),
      ]);
      const customer = customers.find((c) => c.id === order.customerId);

      setData({ deposit, order, customer });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { deposit, order, customer } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.deposit_receipt_title',
    documentNumber: order.orderNumber,
    issuedAt: deposit.createdAt,
    statusLabel: t(`deposit.status.${deposit.status}`),
    fields: [
      { label: t('field.customer'), value: customer?.name ?? order.customerId },
      { label: t('field.sales_order'), value: order.orderNumber },
      { label: t('field.method'), value: t(`method.${deposit.method}`) },
    ],
    totals: [{ label: t('field.total_amount'), value: deposit.amount }],
  };

  return <PrintDocument doc={doc} />;
}
