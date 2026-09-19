import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { SectionCover } from '../../components/SectionCover';
import { StatusBadge } from '../../components/StatusBadge';

interface WorkOrder {
  id: string;
  workOrderNumber: string;
  quantityPlanned: number;
  quantityProduced: number;
  state: string;
  wipValue: string;
}

const IN_PRODUCTION_STATES = ['in_progress', 'on_hold'];

/**
 * ADR-061 §18 — `manufacturing`'s own landing page, following the
 * established Section Cover pattern (HrCover.tsx/SalesCover.tsx). Phase 2
 * (team directive UI-01) — adds WIP-value visibility and a recent-activity
 * list on top of the original total/open KPIs, the same real data
 * `WorkOrders.tsx`'s own list already computes server-side
 * (`listWorkOrdersWithSummary`), never a separate decorative computation.
 */
export function ManufacturingCover() {
  const { t, preload } = useLanguage();
  const [kpis, setKpis] = useState<{ total: number; open: number; inProduction: number; wipValue: string } | null>(null);
  const [recent, setRecent] = useState<WorkOrder[]>([]);

  preload(['field.total_work_orders', 'field.open_work_orders', 'field.wip_value', 'field.in_production', 'field.recent_work_orders', ...IN_PRODUCTION_STATES.map((s) => `work_order_lifecycle.state.${s}`)]);

  useEffect(() => {
    (async () => {
      try {
        const workOrders = await api.get<WorkOrder[]>('/manufacturing/work-orders');
        setKpis({
          total: workOrders.length,
          open: workOrders.filter((w) => w.quantityProduced < w.quantityPlanned).length,
          inProduction: workOrders.filter((w) => IN_PRODUCTION_STATES.includes(w.state)).length,
          wipValue: workOrders.reduce((sum, w) => sum + Number(w.wipValue), 0).toFixed(4),
        });
        setRecent([...workOrders].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 5));
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
              { labelCode: 'field.in_production', value: kpis.inProduction, to: '/manufacturing/work-orders' },
              { labelCode: 'field.wip_value', value: kpis.wipValue, to: '/manufacturing/work-orders' },
            ]
          : undefined
      }
    >
      {recent.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('field.recent_work_orders')}</h3>
          <table className="data-table">
            <tbody>
              {recent.map((wo) => (
                <tr key={wo.id}>
                  <td>
                    <Link to={`/manufacturing/work-orders/${wo.id}`}>{wo.workOrderNumber}</Link>
                  </td>
                  <td>
                    <StatusBadge code={`work_order_lifecycle.state.${wo.state}`} />
                  </td>
                  <td>{wo.wipValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCover>
  );
}
