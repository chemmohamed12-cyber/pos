import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';

interface Collection {
  id: string;
  shipmentId: string;
  amount: string;
  method: string;
  remittanceStatus: 'pending' | 'remitted';
  remittedAt: string | null;
  occurredAt: string;
}
interface Shipment {
  waybillNumber: string;
  rshNumber: string | null;
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  shippingCompanyId: string | null;
  vehicleId: string | null;
}
interface SalesOrderDetail {
  customerName: string;
}
interface ShippingCompany {
  id: string;
  name: string;
}
interface Vehicle {
  id: string;
  plateNumber: string;
}

interface CollectionReceiptData {
  collection: Collection;
  shipment: Shipment;
  order: SalesOrderDetail | null;
  company: ShippingCompany | null;
  vehicle: Vehicle | null;
}

/**
 * Security/gap review — a Collection (money collected at delivery, Delivery
 * domain) had no print receipt at all, unlike every other financial
 * record in the app. Route param is the shipmentId, not the Collection's
 * own id — a shipment has at most one Collection (enforced as a domain
 * invariant in DeliveryService.recordCollection), so this is unambiguous
 * and lets the Collection Settlements screen (which already has the
 * shipmentId on every row) link straight in. Reads the new finance/admin
 * `GET /delivery/collections/by-shipment/:shipmentId` route — no new
 * calculation, same amount/method/status the settlement screen itself
 * already shows.
 */
export function CollectionReceiptPrint() {
  const { shipmentId } = useParams<{ shipmentId: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<CollectionReceiptData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload([
    'document.collection_receipt_title', 'field.waybill', 'field.rsh_number', 'field.sales_order',
    'field.customer', 'field.payment_method', 'field.shipping_company', 'field.vehicle',
    'field.remitted_at', 'field.collected_amount',
  ]);

  useEffect(() => {
    (async () => {
      if (!shipmentId) return;
      try {
        const collection = await api.get<Collection | null>(`/delivery/collections/by-shipment/${shipmentId}`);
        if (!collection) return;

        const shipment = await api.get<Shipment>(`/shipments/${shipmentId}`);
        const [order, companies, vehicles] = await Promise.all([
          shipment.salesOrderId ? api.get<SalesOrderDetail>(`/sales-orders/${shipment.salesOrderId}`).catch(() => null) : Promise.resolve(null),
          api.get<ShippingCompany[]>('/shipments/shipping-companies').catch(() => []),
          api.get<Vehicle[]>('/shipments/vehicles').catch(() => []),
        ]);
        const company = shipment.shippingCompanyId ? (companies.find((c) => c.id === shipment.shippingCompanyId) ?? null) : null;
        const vehicle = shipment.vehicleId ? (vehicles.find((v) => v.id === shipment.vehicleId) ?? null) : null;

        setData({ collection, shipment, order, company, vehicle });
      } catch (err) {
        // Foundation fix: the two PRIMARY calls here (collection, shipment)
        // had no error handling — only the supplementary lookups did.
        setLoadError(err);
      }
    })();
  }, [shipmentId]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { collection, shipment, order, company, vehicle } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.collection_receipt_title',
    documentNumber: shipment.waybillNumber,
    issuedAt: collection.occurredAt,
    statusLabel: t(`remittance_status.${collection.remittanceStatus}`),
    fields: [
      { label: t('field.waybill'), value: shipment.waybillNumber },
      { label: t('field.rsh_number'), value: shipment.rshNumber ?? '—' },
      { label: t('field.sales_order'), value: shipment.salesOrderNumber ?? '—' },
      { label: t('field.customer'), value: order?.customerName ?? '—' },
      { label: t('field.payment_method'), value: collection.method },
      ...(company ? [{ label: t('field.shipping_company'), value: company.name }] : []),
      ...(vehicle ? [{ label: t('field.vehicle'), value: vehicle.plateNumber }] : []),
      ...(collection.remittedAt ? [{ label: t('field.remitted_at'), value: new Date(collection.remittedAt).toLocaleString() }] : []),
    ],
    totals: [{ label: t('field.collected_amount'), value: collection.amount }],
  };

  return <PrintDocument doc={doc} />;
}
