import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SectionCover } from '../../components/SectionCover';

interface WorkOrder {
  id: string;
  quantityPlanned: number;
  quantityProduced: number;
}

/** ADR-061 §18 — `manufacturing`'s own landing page, following the established Section Cover pattern (HrCover.tsx). */
export function ManufacturingCover() {
  const [kpis, setKpis] = useState<{ total: number; open: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const workOrders = await api.get<WorkOrder[]>('/manufacturing/work-orders');
        setKpis({
          total: workOrders.length,
          open: workOrders.filter((w) => w.quantityProduced < w.quantityPlanned).length,
        });
      } catch {
        // Feature may be disabled for this installation (manufacturing.work_orders default: false) — degrade to no KPIs, not an error.
      }
    })();
  }, []);

  return (
    <SectionCover
      titleCode="module.manufacturing"
      shortcuts={[{ to: '/manufacturing/work-orders', labelCode: 'nav.manufacturing_work_orders' }]}
      kpis={
        kpis
          ? [
              { labelCode: 'field.total_work_orders', value: kpis.total, to: '/manufacturing/work-orders' },
              { labelCode: 'field.open_work_orders', value: kpis.open, to: '/manufacturing/work-orders' },
            ]
          : undefined
      }
    />
  );
}
