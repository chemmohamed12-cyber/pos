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
interface PickTaskLineRow {
  productId: string;
  requestedQuantity: number;
  preparedQuantity: number;
  status: 'pending' | 'prepared';
}

interface PickListData {
  task: Task;
  order: Order;
  warehouse: { id: string; code: string; name: string } | undefined;
  fulfillmentOrder: FulfillmentOrder;
  products: Array<{ id: string; name: string; sku: string }>;
  source: Array<{ productId: string; requestedQuantity: number; preparedQuantity: number; status: 'pending' | 'prepared' }>;
}

export function PickListPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<PickListData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.pick_list_title', 'field.sales_order', 'field.warehouse']);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const task = await api.get<Task>(`/fulfillment/pick-tasks/${id}`);
        const fulfillmentOrder = await api.get<FulfillmentOrder>(`/fulfillment/orders/${task.fulfillmentOrderId}`);
        const [order, warehouses, products, lines] = await Promise.all([
          api.get<Order>(`/sales-orders/${fulfillmentOrder.salesOrderId}`),
          api.get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses'),
          api.get<Array<{ id: string; name: string; sku: string }>>('/products/all'),
          api.get<PickTaskLineRow[]>(`/fulfillment/pick-tasks/${id}/lines`),
        ]);
        const warehouse = warehouses.find((w) => w.id === fulfillmentOrder.warehouseId);

        // CTO directive ("PRIORITY: ITEM PREPARATION" / printing across every
        // operational screen) — the pick list now shows Prepared/Requested
        // per item and its Preparation status, not just what was ORIGINALLY
        // requested, sourced from the same `PickTaskLine` rows the
        // Preparation screen itself reads (never a separate print-only
        // calculation).
        const source = lines.length > 0 ? lines : order.lines.map((l) => ({ ...l, requestedQuantity: l.quantity, preparedQuantity: 0, status: 'pending' as const }));

        setData({ task, order, warehouse, fulfillmentOrder, products, source });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { task, order, warehouse, fulfillmentOrder, products, source } = data;
  const productName = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  const doc: BusinessDocument = {
    documentTitleCode: 'document.pick_list_title',
    documentNumber: order.orderNumber,
    issuedAt: task.createdAt,
    statusLabel: t(`fulfillment_task.state.${task.state}`),
    fields: [
      { label: t('field.sales_order'), value: order.orderNumber },
      { label: t('field.warehouse'), value: warehouse ? `${warehouse.code} — ${warehouse.name}` : fulfillmentOrder.warehouseId },
    ],
    lines: source.map((l) => ({
      label: `${productName(l.productId)} — ${t(`prep_item_status.${l.status}`)}`,
      quantity: `${l.preparedQuantity}/${l.requestedQuantity}`,
    })),
  };

  return <PrintDocument doc={doc} />;
}
