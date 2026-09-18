import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { SectionCover, type SectionKpi } from '../../components/SectionCover';

interface Shipment {
  state: string;
}
interface PendingCollection {
  id: string;
}
interface CustodianOverview {
  custodyBalance: string | null;
}
interface ShippingCompany {
  id: string;
}
interface Vehicle {
  id: string;
}

const IN_TRANSIT_STATES = ['picked_up', 'in_transit', 'out_for_delivery'];

/** CTO directive ("Section Cover / Main Dashboard System") — the Shipping section's own landing page: shipments in transit, pending remittances, and total money currently under custody, all from the exact endpoints `Shipments.tsx` itself already reads. */
export function ShippingCover() {
  const { hasRole } = useAuth();
  const [kpis, setKpis] = useState<{ inTransit: number; pendingRemittances: number | null; custodyBalance: string | null } | null>(null);

  const canReviewFinance = hasRole('admin', 'finance');

  useEffect(() => {
    (async () => {
      const [shipments, companies, vehicles] = await Promise.all([
        api.get<Shipment[]>('/shipments'),
        api.get<ShippingCompany[]>('/shipments/shipping-companies'),
        api.get<Vehicle[]>('/shipments/vehicles'),
      ]);

      let pendingRemittances: number | null = null;
      if (canReviewFinance) {
        const pending = await api.get<PendingCollection[]>('/delivery/collections/pending-remittance');
        pendingRemittances = pending.length;
      }

      const overviews = await Promise.all([
        ...companies.map((c) => api.get<CustodianOverview>(`/shipments/shipping-companies/${c.id}/overview`)),
        ...vehicles.map((v) => api.get<CustodianOverview>(`/shipments/vehicles/${v.id}/overview`)),
      ]);
      const custodyBalance = overviews.reduce((sum, o) => sum + Number(o.custodyBalance ?? 0), 0).toFixed(2);

      setKpis({
        inTransit: shipments.filter((s) => IN_TRANSIT_STATES.includes(s.state)).length,
        pendingRemittances,
        custodyBalance,
      });
    })();
  }, [canReviewFinance]);

  const kpiTiles: SectionKpi[] = [];
  if (kpis) {
    kpiTiles.push({ labelCode: 'nav.shipments', value: kpis.inTransit, to: '/shipments' });
    if (kpis.pendingRemittances !== null) {
      kpiTiles.push({
        labelCode: 'panel.pending_remittances',
        value: kpis.pendingRemittances,
        to: '/shipments',
        tone: kpis.pendingRemittances > 0 ? 'warning' : 'default',
      });
    }
    kpiTiles.push({ labelCode: 'field.total_custody_balance', value: kpis.custodyBalance ?? '—', to: '/shipping-methods' });
  }

  const shortcuts = [
    { to: '/shipments', labelCode: 'nav.shipments' },
    ...(hasRole('admin') ? [{ to: '/shipping-methods', labelCode: 'nav.shipping_methods' }] : []),
    { to: '/custody-returns', labelCode: 'nav.custody_returns' },
    ...(canReviewFinance ? [{ to: '/collection-settlements', labelCode: 'nav.collection_settlements' }] : []),
  ];

  return (
    <SectionCover
      titleCode="nav_group.shipping"
      shortcuts={shortcuts}
      kpis={kpis ? kpiTiles : undefined}
    />
  );
}
