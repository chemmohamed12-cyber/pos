import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover } from '../../components/SectionCover';
import { ReportsHub } from '../../components/ReportsHub';

interface SalesOrder {
  id: string;
}
interface Shipment {
  id: string;
  state?: string;
}
interface ReturnRequest {
  id: string;
}
interface ArAgingRow {
  remaining: string;
}

/**
 * Master continuation directive §6 — the Reports section had no Section
 * Cover; clicking "التقارير" went straight into the existing 11-tab
 * report tool (`Reports.tsx`) with no shortcut row and no KPI summary,
 * unlike every other main section. Shortcuts deep-link into specific
 * report tabs via `?tab=...` (added to `Reports.tsx` alongside this cover)
 * rather than just landing on the same default tab every time. KPIs reuse
 * the exact same endpoints the reports themselves already read — no new
 * calculation. AR Outstanding is admin/finance-only, matching the
 * `custody_cod` report tab's own access tier — every other KPI here stays
 * as broadly visible as the Reports tool itself.
 */
export function ReportsCover() {
  const { hasRole } = useAuth();
  const canViewFinance = hasRole('admin', 'finance');
  const [kpis, setKpis] = useState<{ openOrders: number; activeShipments: number; openReturns: number } | null>(null);
  const [arOutstanding, setArOutstanding] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [orders, shipments, returns] = await Promise.all([
          api.get<SalesOrder[]>('/sales-orders'),
          api.get<Shipment[]>('/shipments'),
          api.get<ReturnRequest[]>('/returns'),
        ]);
        setKpis({
          openOrders: orders.length,
          activeShipments: shipments.filter((s) => s.state !== 'delivered' && s.state !== 'returned').length,
          openReturns: returns.length,
        });
      } catch {
        // Foundation fix: degrade to no-KPIs rather than an unhandled rejection.
      }
    })();
  }, []);

  useEffect(() => {
    if (!canViewFinance) return;
    api
      .get<ArAgingRow[]>('/ar-aging')
      .then((rows) => setArOutstanding(rows.reduce((sum, r) => sum + Number(r.remaining), 0).toFixed(2)))
      .catch(() => undefined);
  }, [canViewFinance]);

  return (
    <SectionCover
      titleCode="nav.reports"
      shortcuts={[
        { to: '/reports?tab=sales_by_rep', labelCode: 'field.sales_by_rep' },
        { to: '/reports?tab=sales_by_period', labelCode: 'field.sales_by_period' },
        { to: '/reports?tab=returns', labelCode: 'nav.returns' },
        { to: '/reports?tab=fulfillment', labelCode: 'nav.fulfillment' },
        { to: '/reports?tab=shipments', labelCode: 'nav.shipments' },
        ...(canViewFinance ? [{ to: '/reports?tab=custody_cod', labelCode: 'panel.custody_cod_report' }] : []),
      ]}
      kpis={
        kpis
          ? [
              { labelCode: 'nav.sales_orders', value: kpis.openOrders, to: '/reports?tab=sales_orders' },
              { labelCode: 'field.active_shipments', value: kpis.activeShipments, to: '/reports?tab=shipments' },
              { labelCode: 'nav.returns', value: kpis.openReturns, to: '/reports?tab=returns' },
              ...(canViewFinance && arOutstanding !== null
                ? [{ labelCode: 'field.total_outstanding_all', value: arOutstanding, to: '/reports?tab=custody_cod' }]
                : []),
            ]
          : undefined
      }
    >
      <ReportsHub />
    </SectionCover>
  );
}
