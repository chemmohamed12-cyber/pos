import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

interface ReturnRequest {
  salesOrderId: string;
  productId: string;
  quantity: number;
  warehouseId: string;
  reason: string;
  state: string;
  createdAt: string;
}
interface Order {
  orderNumber: string;
}

interface ReturnPrintData {
  ret: ReturnRequest;
  order: Order;
  product: { id: string; name: string; sku: string } | undefined;
  warehouse: { id: string; code: string; name: string } | undefined;
}

export function ReturnPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<ReturnPrintData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.return_title', 'field.sales_order', 'field.warehouse', 'field.reason']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const ret = await api.get<ReturnRequest>(`/returns/${id}`);
        const [order, products, warehouses] = await Promise.all([
          api.get<Order>(`/sales-orders/${ret.salesOrderId}`),
          api.get<Array<{ id: string; name: string; sku: string }>>('/products/all'),
          api.get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses'),
        ]);
        const product = products.find((p) => p.id === ret.productId);
        const warehouse = warehouses.find((w) => w.id === ret.warehouseId);

        setData({ ret, order, product, warehouse });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">{loadingLabel()}</div>;
  const { ret, order, product, warehouse } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.return_title',
    documentNumber: order.orderNumber,
    issuedAt: ret.createdAt,
    statusLabel: t(`return_request.state.${ret.state}`),
    fields: [
      { label: t('field.sales_order'), value: order.orderNumber },
      { label: t('field.warehouse'), value: warehouse ? `${warehouse.code} — ${warehouse.name}` : ret.warehouseId },
      { label: t('field.reason'), value: ret.reason },
    ],
    lines: [{ label: product ? `${product.sku} — ${product.name}` : ret.productId, quantity: ret.quantity }],
  };

  return <PrintDocument doc={doc} />;
}
