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
  // Master-data counts — each fetched independently: a user without that area's `view` permission simply gets no tile.
  const [master, setMaster] = useState<{ boms?: number; routings?: number; workCenters?: number }>({});

  preload(['nav.manufacturing_boms', 'nav.manufacturing_routings', 'nav.manufacturing_work_centers', 'nav.manufacturing_assembly', 'mfg.kpi.active_boms', 'mfg.kpi.routings', 'mfg.kpi.work_centers', 'field.total_work_orders', 'field.open_work_orders', 'field.wip_value', 'field.in_production', 'field.recent_work_orders', ...IN_PRODUCTION_STATES.map((s) => `work_order_lifecycle.state.${s}`)]);

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
        // No `manufacturing.work_order.view` for this user — degrade to no KPIs, not an error (the API is the authority).
      }
      const [boms, routings, workCenters] = await Promise.allSettled([
        api.get<Array<{ status: string }>>('/manufacturing/boms'),
        api.get<unknown[]>('/manufacturing/routings'),
        api.get<unknown[]>('/manufacturing/work-centers'),
      ]);
      setMaster({
        boms: boms.status === 'fulfilled' ? boms.value.filter((b) => b.status === 'active').length : undefined,
        routings: routings.status === 'fulfilled' ? routings.value.length : undefined,
        workCenters: workCenters.status === 'fulfilled' ? workCenters.value.length : undefined,
      });
    })();
  }, []);

  return (
    <SectionCover
      titleCode="module.manufacturing"
      shortcuts={[
        { to: '/manufacturing/work-orders', labelCode: 'nav.manufacturing_work_orders' },
        { to: '/manufacturing/boms', labelCode: 'nav.manufacturing_boms' },
        { to: '/manufacturing/routings', labelCode: 'nav.manufacturing_routings' },
        { to: '/manufacturing/work-centers', labelCode: 'nav.manufacturing_work_centers' },
        { to: '/manufacturing/assembly', labelCode: 'nav.manufacturing_assembly' },
      ]}
      kpis={[
        ...(kpis
          ? [
              { labelCode: 'field.total_work_orders', value: kpis.total, to: '/manufacturing/work-orders' },
              { labelCode: 'field.open_work_orders', value: kpis.open, to: '/manufacturing/work-orders' },
              { labelCode: 'field.in_production', value: kpis.inProduction, to: '/manufacturing/work-orders' },
              { labelCode: 'field.wip_value', value: kpis.wipValue, to: '/manufacturing/work-orders' },
            ]
          : []),
        ...(master.boms !== undefined ? [{ labelCode: 'mfg.kpi.active_boms', value: master.boms, to: '/manufacturing/boms' }] : []),
        ...(master.routings !== undefined ? [{ labelCode: 'mfg.kpi.routings', value: master.routings, to: '/manufacturing/routings' }] : []),
        ...(master.workCenters !== undefined ? [{ labelCode: 'mfg.kpi.work_centers', value: master.workCenters, to: '/manufacturing/work-centers' }] : []),
      ]}
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
