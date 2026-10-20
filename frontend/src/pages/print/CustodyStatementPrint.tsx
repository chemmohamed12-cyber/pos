import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';
import { loadingLabel } from '../../lib/displayNames';

interface CustodianOverview {
  warehouseId: string | null;
  custodyAccountId: string | null;
  stock: Array<{ productId: string; onHand: number; reserved: number; available: number }>;
  custodyBalance: string | null;
  activeShipmentsCount: number;
}
interface ShippingCompany {
  id: string;
  code: string;
  name: string;
}
interface Vehicle {
  id: string;
  code: string;
  plateNumber: string;
}
interface Product {
  id: string;
  sku: string;
  name: string;
}

interface CustodyStatementData {
  overview: CustodianOverview;
  products: Product[];
  custodianLabel: string;
}

/**
 * CTO directive ("Printing Extensions") — the one print document this
 * backlog never had: a Custody Statement per Shipping Company / Company
 * Vehicle, showing exactly what the Shipping section's own KPI/overview
 * screens already compute (`getCustodianOverview` — the same endpoint,
 * never a separate print-only calculation): goods currently under
 * custody and money currently under custody, together.
 */
export function CustodyStatementPrint() {
  const { type, id } = useParams<{ type: 'company' | 'vehicle'; id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<CustodyStatementData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload(['document.custody_statement_title', 'field.custodian', 'field.active_shipments', 'field.custody_balance', 'field.on_hand', 'field.reserved']);

  useEffect(() => {
    (async () => {
      if (!type || !id) return;
      try {
        const [overview, products] = await Promise.all([
          api.get<CustodianOverview>(`/shipments/${type === 'vehicle' ? 'vehicles' : 'shipping-companies'}/${id}/overview`),
          api.get<Product[]>('/products/all'),
        ]);
        let custodianLabel = id;
        if (type === 'vehicle') {
          const vehicles = await api.get<Vehicle[]>('/shipments/vehicles');
          const vehicle = vehicles.find((v) => v.id === id);
          custodianLabel = vehicle ? `${vehicle.code} — ${vehicle.plateNumber}` : id;
        } else {
          const companies = await api.get<ShippingCompany[]>('/shipments/shipping-companies');
          const company = companies.find((c) => c.id === id);
          custodianLabel = company ? `${company.code} — ${company.name}` : id;
        }

        setData({ overview, products, custodianLabel });
      } catch (err) {
        // Foundation fix: mount-time load had no error handling.
        setLoadError(err);
      }
    })();
  }, [type, id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">{loadingLabel()}</div>;
  const { overview, products, custodianLabel } = data;
  const productLabel = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    return p ? `${p.sku} — ${p.name}` : pid;
  };

  const doc: BusinessDocument = {
    documentTitleCode: 'document.custody_statement_title',
    documentNumber: custodianLabel,
    issuedAt: new Date().toISOString(),
    fields: [
      { label: t('field.custodian'), value: custodianLabel },
      { label: t('field.active_shipments'), value: String(overview.activeShipmentsCount) },
      { label: t('field.custody_balance'), value: overview.custodyBalance ?? '0.00' },
    ],
    lines: overview.stock
      .filter((s) => s.onHand !== 0 || s.reserved !== 0)
      .map((s) => ({ label: productLabel(s.productId), quantity: `${t('field.on_hand')}: ${s.onHand} / ${t('field.reserved')}: ${s.reserved}` })),
  };

  return <PrintDocument doc={doc} />;
}
