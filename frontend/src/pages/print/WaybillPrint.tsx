import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useLanguage } from '../../context/LanguageContext';
import { PrintDocument } from '../../print/PrintDocument';
import type { BusinessDocument } from '../../print/documentTypes';
import { ErrorState } from '../../components/ErrorState';

interface Shipment {
  waybillNumber: string;
  fulfillmentOrderId: string;
  driverUserId: string | null;
  state: string;
  createdAt: string;
  /** RSH Shipping Orders + Carrier waybill-required flow — the full chain this document must show (CTO directive §7, "Printing"). */
  rshNumber: string | null;
  salesOrderNumber: string | null;
  shippingCompanyId: string | null;
  vehicleId: string | null;
  codAmount: string | null;
  carrierWaybillNumber: string | null;
}
interface FulfillmentOrder {
  salesOrderId: string;
  warehouseId: string;
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

interface WaybillPrintData {
  shipment: Shipment;
  order: Order;
  warehouse: { id: string; code: string; name: string } | undefined;
  fulfillmentOrder: FulfillmentOrder;
  customer: { id: string; name: string } | undefined;
  driver: { id: string; fullName: string } | undefined;
  company: ShippingCompany | null;
  vehicle: Vehicle | null;
}

export function WaybillPrint() {
  const { id } = useParams<{ id: string }>();
  const { t, preload } = useLanguage();
  const [data, setData] = useState<WaybillPrintData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  preload([
    'document.waybill_title', 'field.rsh_number', 'field.sales_order', 'field.customer', 'field.warehouse',
    'field.driver', 'field.shipping_company', 'field.vehicle', 'field.carrier_waybill_number', 'field.cod_amount',
  ]);

  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const shipment = await api.get<Shipment>(`/shipments/${id}`);
        const fulfillmentOrder = await api.get<FulfillmentOrder>(`/fulfillment/orders/${shipment.fulfillmentOrderId}`);
        const [order, warehouses, customers, users, companies, vehicles] = await Promise.all([
          api.get<Order>(`/sales-orders/${fulfillmentOrder.salesOrderId}`),
          api.get<Array<{ id: string; code: string; name: string }>>('/inventory/warehouses'),
          api.get<Array<{ id: string; name: string }>>('/customers'),
          api.get<Array<{ id: string; fullName: string }>>('/admin/users').catch(() => []),
          api.get<ShippingCompany[]>('/shipments/shipping-companies').catch(() => []),
          api.get<Vehicle[]>('/shipments/vehicles').catch(() => []),
        ]);
        const warehouse = warehouses.find((w) => w.id === fulfillmentOrder.warehouseId);
        const customer = customers.find((c) => c.id === order.customerId);
        const driver = users.find((u) => u.id === shipment.driverUserId);
        const company = shipment.shippingCompanyId ? (companies.find((c) => c.id === shipment.shippingCompanyId) ?? null) : null;
        const vehicle = shipment.vehicleId ? (vehicles.find((v) => v.id === shipment.vehicleId) ?? null) : null;

        setData({ shipment, order, warehouse, fulfillmentOrder, customer, driver, company, vehicle });
      } catch (err) {
        // Foundation fix: the primary calls here had no error handling.
        setLoadError(err);
      }
    })();
  }, [id]);

  if (loadError) return <ErrorState error={loadError} onRetry={() => window.location.reload()} />;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { shipment, order, warehouse, fulfillmentOrder, customer, driver, company, vehicle } = data;

  const doc: BusinessDocument = {
    documentTitleCode: 'document.waybill_title',
    documentNumber: shipment.waybillNumber,
    issuedAt: shipment.createdAt,
    statusLabel: t(`shipment_lifecycle.state.${shipment.state}`),
    fields: [
      { label: t('field.rsh_number'), value: shipment.rshNumber ?? '—' },
      { label: t('field.sales_order'), value: shipment.salesOrderNumber ?? order.orderNumber },
      { label: t('field.customer'), value: customer?.name ?? order.customerId },
      { label: t('field.warehouse'), value: warehouse ? `${warehouse.code} — ${warehouse.name}` : fulfillmentOrder.warehouseId },
      { label: t('field.driver'), value: driver?.fullName ?? (shipment.driverUserId ?? '—') },
      ...(company ? [{ label: t('field.shipping_company'), value: company.name }] : []),
      ...(vehicle ? [{ label: t('field.vehicle'), value: vehicle.plateNumber }] : []),
      ...(shipment.carrierWaybillNumber ? [{ label: t('field.carrier_waybill_number'), value: shipment.carrierWaybillNumber }] : []),
      ...(shipment.codAmount ? [{ label: t('field.cod_amount'), value: shipment.codAmount }] : []),
    ],
  };

  return <PrintDocument doc={doc} />;
}
