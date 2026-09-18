import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface PriceList {
  code: string;
  name: string;
  status: string;
}
interface PriceListItem {
  sku: string;
  productName: string;
  price: string;
}

interface PriceListData {
  priceList: PriceList;
  items: PriceListItem[];
}

export function PriceListPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<PriceListData | null>(null);

  preload(['document.price_list_title', 'field.name']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const [priceList, items] = await Promise.all([
        api.get<PriceList>(`/price-lists/${id}`),
        api.get<PriceListItem[]>(`/price-lists/${id}/items`),
      ]);

      setData({ priceList, items });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { priceList, items } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.price_list_title',
    documentNumber: priceList.code,
    issuedAt: new Date().toISOString(),
    statusLabel: t(`price_list_status.${priceList.status}`),
    fields: [{ label: t('field.name'), value: priceList.name }],
    lines: items.map((i) => ({ label: `${i.sku} — ${i.productName}`, unitPrice: i.price })),
  };

  return <PrintDocument doc={doc} />;
}
