import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';

interface Task {
  fulfillmentOrderId: string;
  state: string;
  createdAt: string;
}
interface FulfillmentOrder {
  salesOrderId: string;
  warehouseId: string;
}
interface Order {
  orderNumber: string;
  lines: Array<{ productId: string; quantity: number }>;
}

interface PackListData {
  task: Task;
  order: Order;
  warehouse: { id: string; code: string; name: string } | undefined;
  fulfillmentOrder: FulfillmentOrder;
  products: Array<{ id: string; name: string; sku: string }>;
}

export function PackListPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<PackListData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.pack_list_title', 'field.sales_order', 'field.warehouse']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const task = await api.get<Task>(`/fulfillment/pack-tasks/${id}`);
        const fulfillmentOrder = await api.get<FulfillmentOrder>(`/fulfillment/orders/${task.fulfillmentOrderId}`);
        const [order, warehouses, products] = await Promise.all([
          api.get<Order>(`/sales-orders/${fulfillmentOrder.salesOrderId}`),
          api.get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses'),
          api.get<Array<{ id: string; name: string; sku: string }>>('/products/all'),
        ]);
        const warehouse = warehouses.find((w) => w.id === fulfillmentOrder.warehouseId);

        setData({ task, order, warehouse, fulfillmentOrder, products });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { task, order, warehouse, fulfillmentOrder, products } = data;
  const productName = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  const doc: BusinessDocument = {
    documentTitleCode: 'document.pack_list_title',
    documentNumber: order.orderNumber,
    issuedAt: task.createdAt,
    statusLabel: t(`fulfillment_task.state.${task.state}`),
    fields: [
      { label: t('field.sales_order'), value: order.orderNumber },
      { label: t('field.warehouse'), value: warehouse ? `${warehouse.code} — ${warehouse.name}` : fulfillmentOrder.warehouseId },
    ],
    lines: order.lines.map((l) => ({ label: productName(l.productId), quantity: l.quantity })),
  };

  return <PrintDocument doc={doc} />;
}
