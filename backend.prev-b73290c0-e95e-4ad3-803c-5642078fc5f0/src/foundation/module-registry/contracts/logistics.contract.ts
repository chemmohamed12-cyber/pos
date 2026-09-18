/**
 * ERP Foundation — P4 Tranche-2 (`P4_T2_BLUEPRINT.md` §3), `reports`
 * domain. Public contracts `logistics` (`returns`/`shipment`/`delivery`)
 * exposes to `reporting` — the first time any `logistics` business
 * domain is a contract *provider* rather than only a consumer (Tasks 1-2
 * and the earlier P4-T2 domains only ever built `logistics → *`
 * contracts, never `* → logistics`).
 *
 * Three separate tokens, one per providing domain, same "not one
 * god-contract" discipline as `finance.contract.ts`.
 */

export interface ReturnRequestViewContract {
  id: string;
  salesOrderId: string;
  createdAt: Date;
  quantity: number;
  reason: string;
  state: string;
}

export interface LogisticsReturnsContract {
  listReturns(): Promise<ReturnRequestViewContract[]>;
  /** Only `.originalAmount` is ever read — narrowed from the real `Promise<ReturnCredit | null>`. */
  getCreditForReturnRequest(returnRequestId: string): Promise<{ originalAmount: string } | null>;
}
export const LOGISTICS_RETURNS_CONTRACT = Symbol('LOGISTICS_RETURNS_CONTRACT');

export interface CustodianViewContract {
  id: string;
  code: string;
  custodyAccountId: string | null;
}

export interface ShippingCompanyViewContract extends CustodianViewContract {
  name: string;
}

export interface VehicleViewContract extends CustodianViewContract {
  plateNumber: string;
}

export interface CustodianOverviewContract {
  warehouseId: string | null;
  custodyAccountId: string | null;
  stock: Array<{ warehouseId: string; productId: string; onHand: number; reserved: number; available: number }>;
  custodyBalance: string | null;
  activeShipmentsCount: number;
}

export interface LogisticsShipmentContract {
  /** Only `.id`/`.waybillNumber` are ever read — narrowed from the real `Promise<Shipment | null>`. */
  getShipmentByFulfillmentOrderId(fulfillmentOrderId: string): Promise<{ id: string; waybillNumber: string | null } | null>;
  listShippingCompanies(): Promise<ShippingCompanyViewContract[]>;
  listVehicles(): Promise<VehicleViewContract[]>;
  getCustodianOverview(custodianType: 'company' | 'vehicle', custodianId: string): Promise<CustodianOverviewContract>;
}
export const LOGISTICS_SHIPMENT_CONTRACT = Symbol('LOGISTICS_SHIPMENT_CONTRACT');

export interface CollectionViewContract {
  id: string;
  amount: string;
  remittanceStatus: 'pending' | 'remitted';
  occurredAt: Date;
  method: string;
  custodyAccountId: string | null;
}

export interface LogisticsDeliveryContract {
  getCollectionForShipmentUnscoped(shipmentId: string): Promise<CollectionViewContract | null>;
  listAllCollections(): Promise<CollectionViewContract[]>;
}
export const LOGISTICS_DELIVERY_CONTRACT = Symbol('LOGISTICS_DELIVERY_CONTRACT');
