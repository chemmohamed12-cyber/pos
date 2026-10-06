import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SectionCover, type SectionKpi } from '../../components/SectionCover';

interface SalesOrder {
  id: string;
  status: string;
}
interface FulfillmentOrderRow {
  id: string;
  salesOrderId: string;
}
interface Task {
  id: string;
  fulfillmentOrderId: string;
  state: string;
}
interface ShipmentRow {
  fulfillmentOrderId: string;
}

/**
 * CTO directive ("Section Cover / Main Dashboard System") — the Production/
 * Fulfillment section's own landing page, same design system as every
 * other section (Sales/Warehouses/Shipping/Catalog/Treasury/Administration).
 * The three KPI buckets are the EXACT same classification
 * `Fulfillment.tsx`'s own dashboard already computes (new / under
 * preparation / ready for shipping, derived from Sales Order + Fulfillment
 * Order + Pack Task + Shipment records) — reused here, not recalculated
 * differently.
 */
export function FulfillmentCover() {
  const [kpis, setKpis] = useState<{ new: number; preparation: number; ready: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [orders, fos, packs, ships] = await Promise.all([
          api.get<SalesOrder[]>('/sales-orders'),
          api.get<FulfillmentOrderRow[]>('/fulfillment/orders'),
          api.get<Task[]>('/fulfillment/pack-tasks'),
          api.get<ShipmentRow[]>('/shipments'),
        ]);
        const released = orders.filter((o) => o.status === 'released');
        const foBySalesOrderId = new Map(fos.map((fo) => [fo.salesOrderId, fo]));
        const packByFoId = new Map(packs.map((p) => [p.fulfillmentOrderId, p]));
        const shippedFoIds = new Set(ships.map((s) => s.fulfillmentOrderId));

        let newCount = 0;
        let preparationCount = 0;
        let readyCount = 0;
        for (const order of released) {
          const fo = foBySalesOrderId.get(order.id);
          if (!fo) {
            newCount += 1;
            continue;
          }
          if (shippedFoIds.has(fo.id)) continue;
          const pack = packByFoId.get(fo.id);
          if (pack && pack.state === 'closed') readyCount += 1;
          else preparationCount += 1;
        }

        setKpis({ new: newCount, preparation: preparationCount, ready: readyCount });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, []);

  const kpiTiles: SectionKpi[] = kpis
    ? [
        { labelCode: 'dashboard.new_orders', value: kpis.new, to: '/fulfillment' },
        { labelCode: 'dashboard.under_preparation', value: kpis.preparation, to: '/fulfillment' },
        { labelCode: 'dashboard.ready_for_shipping', value: kpis.ready, to: '/fulfillment', tone: kpis.ready > 0 ? 'positive' : 'default' },
      ]
    : [];

  return (
    <SectionCover
      titleCode="nav_group.production"
      shortcuts={[{ to: '/fulfillment', labelCode: 'nav.fulfillment' }]}
      kpis={kpis ? kpiTiles : undefined}
    />
  );
}
