import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface Customer {
  code: string;
  name: string;
  phone: string | null;
  status: string;
  classification: string | null;
  orderWorkflowPolicy: 'standard' | 'open_account';
  priceListId: string | null;
  createdAt: string;
}
interface PriceListRef {
  id: string;
  code: string;
  name: string;
}

interface CustomerPrintData {
  customer: Customer;
  priceList: PriceListRef | undefined;
}

export function CustomerPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<CustomerPrintData | null>(null);

  preload(['document.customer_title', 'field.name', 'field.phone', 'field.classification', 'field.order_workflow_policy', 'field.customer_price_list', 'field.no_override']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const [customer, priceLists] = await Promise.all([
        api.get<Customer>(`/customers/${id}`),
        api.get<PriceListRef[]>('/price-lists'),
      ]);
      const priceList = customer.priceListId ? priceLists.find((pl) => pl.id === customer.priceListId) : undefined;

      setData({ customer, priceList });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { customer, priceList } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.customer_title',
    documentNumber: customer.code,
    issuedAt: customer.createdAt,
    statusLabel: customer.status,
    fields: [
      { label: t('field.name'), value: customer.name },
      { label: t('field.phone'), value: customer.phone ?? '—' },
      { label: t('field.classification'), value: customer.classification ?? '—' },
      { label: t('field.order_workflow_policy'), value: t(`workflow_policy.${customer.orderWorkflowPolicy}`) },
      { label: t('field.customer_price_list'), value: priceList ? `${priceList.code} — ${priceList.name}` : t('field.no_override') },
    ],
  };

  return <PrintDocument doc={doc} />;
}
