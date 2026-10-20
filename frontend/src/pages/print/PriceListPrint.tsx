import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

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
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.price_list_title', 'field.name']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const [priceList, items] = await Promise.all([
          api.get<PriceList>(`/price-lists/${id}`),
          api.get<PriceListItem[]>(`/price-lists/${id}/items`),
        ]);

        setData({ priceList, items });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">{loadingLabel()}</div>;
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
