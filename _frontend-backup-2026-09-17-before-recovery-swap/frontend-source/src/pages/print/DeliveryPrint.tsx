import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';

interface Shipment {
  waybillNumber: string;
  fulfillmentOrderId: string;
  rshNumber: string | null;
  salesOrderNumber: string | null;
  shippingCompanyId: string | null;
  vehicleId: string | null;
  driverUserId: string | null;
}
interface Outcome {
  outcome: string;
  occurredAt: string;
}
interface Collection {
  amount: string;
  method: string;
  occurredAt: string;
  remittanceStatus: string;
}
interface FulfillmentOrder {
  salesOrderId: string;
}
interface Order {
  orderNumber: string;
  customerId: string;
}
interface ShippingCompany {
  id: string;
  name: string;
}
interface Vehicle {
  id: string;
  plateNumber: string;
}

interface DeliveryPrintData {
  shipment: Shipment;
  order: Order;
  customer: { id: string; name: string } | undefined;
  driver: { id: string; fullName: string } | undefined;
  outcome: Outcome | null;
  collection: Collection | null;
  company: ShippingCompany | null;
  vehicle: Vehicle | null;
}

/** CTO directive ("Printing" — keep Sales Order/RSH/Shipment/Customer/Shipping Company/Vehicle/Custody/Delivery/Treasury linked and the status correct on every shipping/delivery document). */
export function DeliveryPrint() {
  const { id } = useParams<{ id: string }>(); // shipmentId
  const { t, preload } = useLanguage();
  const [data, setData] = useState<DeliveryPrintData | null>(null);

  preload([
    'document.delivery_title', 'field.rsh_number', 'field.sales_order', 'field.customer', 'field.driver',
    'field.shipping_company', 'field.vehicle', 'field.remittance_status', 'field.total_amount',
  ]);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const shipment = await api.get<Shipment>(`/shipments/${id}`);
      const fulfillmentOrder = await api.get<FulfillmentOrder>(`/fulfillment/orders/${shipment.fulfillmentOrderId}`);
      const [order, customers, users, outcome, collection, companies, vehicles] = await Promise.all([
        api.get<Order>(`/sales-orders/${fulfillmentOrder.salesOrderId}`),
        api.get<Array<{ id: string; name: string }>>('/customers'),
        api.get<Array<{ id: string; fullName: string }>>('/admin/users').catch(() => []),
        api.get<Outcome | null>(`/delivery/outcomes?shipmentId=${id}`),
        api.get<Collection | null>(`/delivery/collections?shipmentId=${id}`),
        api.get<ShippingCompany[]>('/shipments/shipping-companies').catch(() => []),
        api.get<Vehicle[]>('/shipments/vehicles').catch(() => []),
      ]);
      const customer = customers.find((c) => c.id === order.customerId);
      const driver = users.find((u) => u.id === shipment.driverUserId);
      const company = shipment.shippingCompanyId ? (companies.find((c) => c.id === shipment.shippingCompanyId) ?? null) : null;
      const vehicle = shipment.vehicleId ? (vehicles.find((v) => v.id === shipment.vehicleId) ?? null) : null;

      setData({ shipment, order, customer, driver, outcome, collection, company, vehicle });
    })();
  }, [id]);

  if (!data) return <div className="empty-state">Loading…</div>;
  const { shipment, order, customer, driver, outcome, collection, company, vehicle } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.delivery_title',
    documentNumber: shipment.waybillNumber,
    issuedAt: outcome?.occurredAt ?? new Date().toISOString(),
    statusLabel: outcome ? t(`delivery_outcome.${outcome.outcome}`) : '—',
    fields: [
      { label: t('field.rsh_number'), value: shipment.rshNumber ?? '—' },
      { label: t('field.sales_order'), value: shipment.salesOrderNumber ?? order.orderNumber },
      { label: t('field.customer'), value: customer?.name ?? order.customerId },
      { label: t('field.driver'), value: driver?.fullName ?? (shipment.driverUserId ?? '—') },
      ...(company ? [{ label: t('field.shipping_company'), value: company.name }] : []),
      ...(vehicle ? [{ label: t('field.vehicle'), value: vehicle.plateNumber }] : []),
      ...(collection ? [{ label: t('field.remittance_status'), value: t(`remittance_status.${collection.remittanceStatus}`) }] : []),
    ],
    totals: collection ? [{ label: `${t('field.total_amount')} (${t(`method.${collection.method}`)})`, value: collection.amount }] : undefined,
  };

  return <PrintDocument doc={doc} />;
}
